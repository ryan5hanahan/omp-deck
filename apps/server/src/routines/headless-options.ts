/**
 * Allowlist → `createAgentSession` options for a headless agent-step session.
 * Each list follows the step schema: omitted = unrestricted (the SDK's own
 * discovery), `[]` = none, a list = only those names.
 */
import { resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";

export interface HeadlessAllowlists {
	/** Skill names. */
	skills?: string[];
	/** MCP server names. */
	mcpServers?: string[];
}

interface McpToolLike {
	name: string;
	mcpServerName?: string;
}

/** The slice of the SDK's `MCPManager` the MCP allowlist needs. */
export interface HeadlessMcpManager<T extends McpToolLike> {
	getAllServerNames(): string[];
	getTools(): T[];
	waitForStartup(timeoutMs: number): Promise<unknown>;
}

export interface HeadlessOptionDeps<S extends { name: string }, T extends McpToolLike, M> {
	/** Skills the session would discover on its own. Called only for a skills allowlist. */
	discoverSkills(): Promise<S[]>;
	/** The deck's shared, discovered MCP manager. Called only for a non-empty MCP allowlist. */
	getMcpManager(): Promise<M & HeadlessMcpManager<T>>;
}

export interface HeadlessSessionOptions<S, T, M> {
	skills?: S[];
	enableMCP?: false;
	mcpManager?: M;
	mcpTools?: T[];
}

export async function buildHeadlessOptions<S extends { name: string }, T extends McpToolLike, M>(
	allow: HeadlessAllowlists,
	deps: HeadlessOptionDeps<S, T, M>,
): Promise<HeadlessSessionOptions<S, T, M>> {
	const options: HeadlessSessionOptions<S, T, M> = {};
	if (allow.skills) {
		const allowed = new Set(allow.skills);
		options.skills =
			allow.skills.length === 0 ? [] : (await deps.discoverSkills()).filter((skill) => allowed.has(skill.name));
	}
	if (allow.mcpServers?.length === 0) {
		// Also blocks process-global MCP access, not only this session's tool list.
		options.enableMCP = false;
	} else if (allow.mcpServers) {
		const manager = await deps.getMcpManager();
		const installed = new Set(manager.getAllServerNames());
		const missing = allow.mcpServers.filter((name) => !installed.has(name));
		if (missing.length > 0) throw new Error(`MCP server not installed: ${missing.join(", ")}`);
		// Servers past the SDK's short connect window are still loading tools; wait as `omp -p` does.
		await manager.waitForStartup(resolveMCPTimeoutMs());
		const allowed = new Set(allow.mcpServers);
		options.mcpManager = manager;
		options.mcpTools = manager
			.getTools()
			.filter((tool) => tool.mcpServerName !== undefined && allowed.has(tool.mcpServerName));
	}
	return options;
}
