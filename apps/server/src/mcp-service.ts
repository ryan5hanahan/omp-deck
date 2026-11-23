/**
 * Deck-level MCP access for routines (`mcp` steps) and the Integrations page:
 * one SDK `MCPManager`, connected lazily on first use and shared by every caller.
 * Hosting follows the SDK: servers run in this process, or in the per-user omp
 * daemon once a chat session holds `mcp.shared`.
 */
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import {
	callTool as sdkCallTool,
	listTools as sdkListTools,
	type MCPConfigLoader,
	type McpHostAccess,
	MCPManager,
	type MCPServerConnection,
	type MCPToolCallResult,
	type MCPToolDefinition,
} from "@oh-my-pi/pi-coding-agent/mcp";
import { getDeckAuthStorage } from "./auth-singleton.ts";
import { loadConfig } from "./config.ts";

export interface McpServerInfo {
	name: string;
	status: "connected" | "connecting" | "disconnected" | "error";
	transport?: string;
	sourcePath?: string;
	error?: string;
}

export interface McpServiceOptions {
	cwd: string;
	getAuthStorage?: () => Promise<AuthStorage>;
	/** Replaces config discovery (default: every MCP config the SDK finds under `cwd` and the user dir). */
	loadConfigs?: MCPConfigLoader;
	/** Where servers are hosted (default: the SDK's choice of in-process host or omp daemon). */
	hostAccess?: McpHostAccess;
}

export class UnknownMcpServerError extends Error {
	readonly server: string;

	constructor(server: string) {
		super(`Unknown MCP server: ${server}`);
		this.name = "UnknownMcpServerError";
		this.server = server;
	}
}

export class McpService {
	readonly #manager: MCPManager;
	readonly #getAuthStorage: (() => Promise<AuthStorage>) | undefined;
	#connected: Promise<void> | undefined;
	/** Newest connect failure per server, cleared when it connects (mirrors the manager's private record). */
	readonly #errors = new Map<string, string>();

	constructor(options: McpServiceOptions) {
		this.#manager = new MCPManager(options.cwd, options.loadConfigs, undefined, options.hostAccess);
		this.#getAuthStorage = options.getAuthStorage;
		this.#manager.addConnectionStatusListener((event) => {
			if (event.type === "failed") this.#errors.set(event.serverName, event.error);
			else if (event.type === "connected") this.#errors.delete(event.serverName);
		});
	}

	#ensureConnected(): Promise<void> {
		if (this.#connected) return this.#connected;
		const connected = (async () => {
			// OAuth-backed HTTP servers resolve their tokens during discovery.
			if (this.#getAuthStorage) this.#manager.setAuthStorage(await this.#getAuthStorage());
			await this.#manager.discoverAndConnect();
		})();
		this.#connected = connected;
		// A failed discovery (unreadable config) is retried by the next call instead of cached.
		connected.catch(() => {
			if (this.#connected === connected) this.#connected = undefined;
		});
		return connected;
	}

	async #connection(server: string): Promise<MCPServerConnection> {
		await this.#ensureConnected();
		if (!this.#manager.getAllServerNames().includes(server)) throw new UnknownMcpServerError(server);
		// Never `manual: true`: it stops the upstream, which other omp sessions may share.
		// "connecting" already has an attempt in flight, which `waitForConnection` joins.
		if (this.#manager.getConnectionStatus(server) === "disconnected") await this.#manager.reconnectServer(server);
		return this.#manager.waitForConnection(server);
	}

	async listServers(): Promise<McpServerInfo[]> {
		await this.#ensureConnected();
		const manager = this.#manager;
		return manager.getAllServerNames().map((name): McpServerInfo => {
			const status = manager.getConnectionStatus(name);
			const runtime = manager.getServerRuntime(name);
			const config = manager.getServerConfig(name);
			const error =
				status === "disconnected"
					? (this.#errors.get(name) ??
						(runtime?.state === "failed" ? runtime.exit?.stderr.trim() || "MCP server failed" : undefined))
					: undefined;
			return {
				name,
				status: error === undefined ? status : "error",
				transport: config ? (config.type ?? "stdio") : undefined,
				sourcePath: manager.getSource(name)?.path,
				error,
			};
		});
	}

	async listTools(server: string, signal?: AbortSignal): Promise<MCPToolDefinition[]> {
		return sdkListTools(await this.#connection(server), { signal });
	}

	async callTool(
		server: string,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<MCPToolCallResult> {
		return sdkCallTool(await this.#connection(server), tool, args, { signal });
	}

	/** Drop every connection and rediscover, picking up config changes. */
	async reload(): Promise<void> {
		await this.#manager.disconnectAll();
		// Reset after the teardown so a call racing it cannot start a discovery that the teardown then wipes.
		this.#connected = undefined;
		this.#errors.clear();
		await this.#ensureConnected();
	}

	async dispose(): Promise<void> {
		await this.#manager.disconnectAll();
		this.#connected = undefined;
	}
}

let service: McpService | undefined;

export function getMcpService(): McpService {
	service ??= new McpService({ cwd: loadConfig().defaultCwd, getAuthStorage: getDeckAuthStorage });
	return service;
}

export async function disposeMcpService(): Promise<void> {
	const current = service;
	service = undefined;
	await current?.dispose();
}
