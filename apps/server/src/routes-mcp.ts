/**
 * /api/mcp — the Integrations page over the deck's MCP service.
 *
 * Servers are the deck manager's view unioned with the user (`~/.omp/agent/mcp.json`)
 * and project (`<cwd>/.omp/mcp.json`) files and the user denylist, so disabled
 * entries still show. Writes go through the SDK config writer, then the service
 * reloads. A server found in any other config is `external`: it can be enabled or
 * disabled (through the user allow/denylists) but not removed.
 */
import { Hono } from "hono";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
	addMCPServer,
	listMCPServers,
	type MCPServerConfig,
	readMCPConfigFile,
	removeMCPServer,
	setMcpServerEnabled,
	validateServerConfig,
	validateServerName,
} from "@oh-my-pi/pi-coding-agent/mcp";
import {
	findMcpServerForAuth,
	McpReauthRefusalError,
	reauthorizeMcpServer,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { McpServerSummary, McpToolSummary } from "@omp-deck/protocol";

import { getDeckAuthStorage } from "./auth-singleton.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import { getMcpService, type McpService, UnknownMcpServerError } from "./mcp-service.ts";

const log = logger("routes:mcp");

type ReauthReply = { body: { url: string } | { ok: true } | { error: string }; status: 200 | 400 | 500 };

/**
 * A parsed JSON body before validation. Sound for any JSON value: a field read on a primitive or
 * array is `undefined`, and every field stays `unknown` until checked.
 */
type RawBody = { [field: string]: unknown } | null;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((item) => typeof item === "string")
	);
}

/** The add form's subset of `MCPServerConfig`; any other request field is not written to `mcp.json`. */
function parseServerConfig(input: unknown): MCPServerConfig | string {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return "config must be an object";
	const { type, url, headers, command, args, env } = input as { [field: string]: unknown };
	if (type === "http" || type === "sse") {
		if (typeof url !== "string") return "url must be a string";
		if (headers !== undefined && !isStringRecord(headers)) return "headers must map names to strings";
		return { type, url, ...(headers ? { headers } : {}) };
	}
	if (type !== undefined && type !== "stdio") return `unknown transport "${String(type)}"`;
	if (typeof command !== "string") return "command must be a string";
	if (args !== undefined && !isStringArray(args)) return "args must be a list of strings";
	if (env !== undefined && !isStringRecord(env)) return "env must map names to strings";
	return { type: "stdio", command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
}

/** Connect errors can quote a server's stderr or request; never echo its env or header values. */
function redactSecrets(text: string, config: MCPServerConfig | undefined): string {
	if (!config) return text;
	const env = "env" in config ? config.env : undefined;
	const headers = "headers" in config ? config.headers : undefined;
	const secrets = Object.values({ ...env, ...headers });
	// shortcut: values under 4 chars (flags like "1") are skipped so they don't mangle the message; a short real secret would leak.
	return secrets.reduce((out, secret) => (secret.length >= 4 ? out.replaceAll(secret, "[redacted]") : out), text);
}

export function buildMcpRouter(
	opts: { service?: McpService; cwd?: string; userConfigPath?: string; projectConfigPath?: string } = {},
): Hono {
	const service = opts.service ?? getMcpService();
	const cwd = opts.cwd ?? loadConfig().defaultCwd;
	const userPath = opts.userConfigPath ?? path.join(getAgentDir(), "mcp.json");
	const projectPath = opts.projectConfigPath ?? path.join(cwd, ".omp", "mcp.json");
	const app = new Hono();

	async function listSummaries(): Promise<McpServerSummary[]> {
		const [live, manager, user, project] = await Promise.all([
			service.listServers(),
			service.getManager(),
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);
		const liveByName = new Map(live.map((info) => [info.name, info]));
		const toolCounts = new Map<string, number>();
		for (const tool of manager.getTools()) {
			if (tool.mcpServerName) toolCounts.set(tool.mcpServerName, (toolCounts.get(tool.mcpServerName) ?? 0) + 1);
		}
		const denied = new Set(user.disabledServers ?? []);
		const names = new Set([
			...Object.keys(project.mcpServers ?? {}),
			...Object.keys(user.mcpServers ?? {}),
			...liveByName.keys(),
			...denied,
		]);
		return [...names].sort().map((name): McpServerSummary => {
			// Project before user: runtime discovery lets the project entry win a name collision.
			const scope = project.mcpServers?.[name] ? "project" : user.mcpServers?.[name] ? "user" : "external";
			const fileConfig = project.mcpServers?.[name] ?? user.mcpServers?.[name];
			// A denylisted external server is not loaded, so its config (and transport) is unknown.
			const config = manager.getServerConfig(name) ?? fileConfig;
			const info = liveByName.get(name);
			return {
				name,
				scope,
				sourcePath: scope === "project" ? projectPath : scope === "user" ? userPath : info?.sourcePath,
				transport: config ? (config.type ?? "stdio") : undefined,
				// Loaded means enabled; otherwise the entry's flag and the user denylist decide.
				enabled: info !== undefined || (!denied.has(name) && fileConfig?.enabled !== false),
				status: info?.status ?? "disconnected",
				toolCount: toolCounts.get(name) ?? 0,
				error: info?.error === undefined ? undefined : redactSecrets(info.error, config),
			};
		});
	}

	async function summaryOf(name: string): Promise<McpServerSummary> {
		const summary = (await listSummaries()).find((candidate) => candidate.name === name);
		if (!summary) throw new UnknownMcpServerError(name);
		return summary;
	}

	app.onError((err, c) => {
		if (err instanceof UnknownMcpServerError) return c.json({ error: err.message }, 404);
		log.error(`${c.req.method} ${c.req.path} failed`, err);
		return c.json({ error: err.message }, 500);
	});

	app.get("/mcp/servers", async (c) => c.json(await listSummaries()));

	app.get("/mcp/servers/:name/tools", async (c) => {
		const tools = await service.listTools(c.req.param("name"), c.req.raw.signal);
		return c.json(
			tools.map(
				({ name, title, description, inputSchema, annotations }): McpToolSummary => ({
					name,
					title,
					description,
					inputSchema,
					annotations: annotations ? { ...annotations } : undefined,
				}),
			),
		);
	});

	app.post("/mcp/servers", async (c) => {
		const body = (await c.req.json().catch(() => null)) as RawBody;
		const name = body?.name;
		if (typeof name !== "string") return c.json({ error: "body must be { name, scope?, config }" }, 400);
		// User by default, so routines see the server regardless of cwd (the SDK's `/mcp add` defaults to project).
		const scope = body?.scope ?? "user";
		if (scope !== "user" && scope !== "project") return c.json({ error: 'scope must be "user" or "project"' }, 400);
		const config = parseServerConfig(body?.config);
		const problems = [
			validateServerName(name),
			...(typeof config === "string" ? [config] : validateServerConfig(name, config)),
		].filter((problem): problem is string => problem !== undefined);
		if (problems.length > 0 || typeof config === "string") return c.json({ error: problems.join("; ") }, 400);
		if ((await listSummaries()).some((summary) => summary.name === name)) {
			return c.json({ error: `MCP server "${name}" already exists` }, 409);
		}
		await addMCPServer(scope === "user" ? userPath : projectPath, name, config);
		await service.reload();
		return c.json(await summaryOf(name), 201);
	});

	app.delete("/mcp/servers/:name", async (c) => {
		const name = c.req.param("name");
		const summary = await summaryOf(name);
		if (summary.scope === "external") {
			const source = summary.sourcePath ?? "another config";
			return c.json({ error: `"${name}" comes from ${source} and cannot be removed here; disable it instead` }, 400);
		}
		const scope = c.req.query("scope") ?? summary.scope;
		if (scope !== "user" && scope !== "project") return c.json({ error: 'scope must be "user" or "project"' }, 400);
		const filePath = scope === "user" ? userPath : projectPath;
		if (!(await listMCPServers(filePath)).includes(name)) {
			return c.json({ error: `"${name}" is not in the ${scope} config` }, 404);
		}
		await removeMCPServer(filePath, name);
		await service.reload();
		return c.body(null, 204);
	});

	app.post("/mcp/servers/:name/enabled", async (c) => {
		const name = c.req.param("name");
		const body = (await c.req.json().catch(() => null)) as RawBody;
		const enabled = body?.enabled;
		if (typeof enabled !== "boolean") return c.json({ error: "body must be { enabled: boolean }" }, 400);
		// 404 before anything is written.
		await summaryOf(name);
		// No `sourcePath`: an external server is toggled through the user denylist/allowlist, never by
		// writing `enabled` into its own file, so a disabled one stays listed (the deck reads only the
		// user and project files) and can be re-enabled here.
		await setMcpServerEnabled({ userPath, projectPath, name, enabled });
		await service.reload();
		return c.json(await summaryOf(name));
	});

	app.post("/mcp/servers/:name/reconnect", async (c) => {
		const name = c.req.param("name");
		const manager = await service.getManager();
		if (!manager.getAllServerNames().includes(name)) throw new UnknownMcpServerError(name);
		// Never `manual: true`: it stops the upstream, which other omp sessions may share.
		// A failed attempt resolves null and surfaces as the summary's `error`.
		await manager.reconnectServer(name);
		return c.json(await summaryOf(name));
	});

	app.post("/mcp/servers/:name/reauth", async (c) => {
		const name = c.req.param("name");
		// 404 for an unknown name before the SDK reads any config file.
		await summaryOf(name);
		const manager = await service.getManager();
		const found = await findMcpServerForAuth(name, cwd, manager);
		if (!found) throw new UnknownMcpServerError(name);
		const authStorage = await getDeckAuthStorage();
		// Answer with the consent URL as soon as the SDK has one (the flow keeps running in the
		// background), or with the flow's outcome if it settles first. Later resolves are no-ops.
		const { promise, resolve } = Promise.withResolvers<ReauthReply>();
		void reauthorizeMcpServer(name, found, {
			authStorage,
			mcpManager: manager,
			cwd,
			onAuth: (info) => resolve({ body: { url: info.url }, status: 200 }),
		})
			// Pick up the fresh credential, as `/mcp reauth` does.
			.then(() => service.reload())
			.then(
				() => resolve({ body: { ok: true }, status: 200 }),
				(err: unknown) => {
					log.warn(`reauth of MCP server "${name}" failed`, err);
					resolve({
						body: { error: err instanceof Error ? err.message : String(err) },
						status: err instanceof McpReauthRefusalError ? 400 : 500,
					});
				},
			);
		const reply = await promise;
		return c.json(reply.body, reply.status);
	});

	return app;
}
