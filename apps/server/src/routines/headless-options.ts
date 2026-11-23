/**
 * Allowlist → `createAgentSession` options for a headless agent-step session.
 * Each list follows the step schema: omitted = unrestricted (the SDK's own
 * discovery), `[]` = none, a list = only those names.
 */
import { resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

export interface HeadlessAllowlists {
	/** Skill names. */
	skills?: string[];
	/** MCP server names. */
	mcpServers?: string[];
	/** Built-in tool names. */
	tools?: string[];
	/** Present when the run wants structured output; `yield` then survives a tools list. */
	outputSchema?: unknown;
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
	/** The deck's shared, discovered MCP manager. Called for a non-empty MCP allowlist, or for any tools list unless MCP is off. */
	getMcpManager(): Promise<M & HeadlessMcpManager<T>>;
}

export interface HeadlessSessionOptions<S, T, M> {
	skills?: S[];
	enableMCP?: false;
	mcpManager?: M;
	mcpTools?: T[];
	toolNames?: string[];
	restrictToolNames?: true;
	customTools?: T[];
	allowRestrictedCustomTools?: true;
}

const BUILTIN_TOOLS: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);

export async function buildHeadlessOptions<S extends { name: string }, T extends McpToolLike, M>(
	allow: HeadlessAllowlists,
	deps: HeadlessOptionDeps<S, T, M>,
): Promise<HeadlessSessionOptions<S, T, M>> {
	// Checked first, so a typo fails the step before any discovery, connection or model call.
	const unknownTools = allow.tools?.filter((name) => !BUILTIN_TOOLS.has(name)) ?? [];
	if (unknownTools.length > 0) {
		throw new Error(`unknown built-in tool: ${unknownTools.join(", ")} (known: ${BUILTIN_TOOL_NAMES.join(", ")})`);
	}
	const restricted = allow.tools !== undefined;

	const options: HeadlessSessionOptions<S, T, M> = {};
	if (allow.skills) {
		const allowed = new Set(allow.skills);
		options.skills =
			allow.skills.length === 0 ? [] : (await deps.discoverSkills()).filter((skill) => allowed.has(skill.name));
	}

	let mcpTools: T[] = [];
	if (allow.mcpServers?.length === 0) {
		// Also blocks process-global MCP access, not only this session's tool list.
		options.enableMCP = false;
	} else if (allow.mcpServers || restricted) {
		const manager = await deps.getMcpManager();
		if (allow.mcpServers) {
			const installed = new Set(manager.getAllServerNames());
			const missing = allow.mcpServers.filter((name) => !installed.has(name));
			if (missing.length > 0) throw new Error(`MCP server not installed: ${missing.join(", ")}`);
		}
		// Servers past the SDK's short connect window are still loading tools; wait as `omp -p` does.
		await manager.waitForStartup(resolveMCPTimeoutMs());
		const allowed = allow.mcpServers && new Set(allow.mcpServers);
		mcpTools = manager
			.getTools()
			.filter((tool) => tool.mcpServerName !== undefined && (!allowed || allowed.has(tool.mcpServerName)));
		if (!restricted) {
			options.mcpManager = manager;
			options.mcpTools = mcpTools;
		}
	}

	if (restricted) {
		// The SDK widens a bare `toolNames` list with memory, skill, extension and special tools, so the
		// list is only exact with `restrictToolNames` (sdk.ts alwaysInclude; tools/index.ts auto-includes).
		// That also turns MCP off, so the allowed MCP tools ride along as named custom tools, each still
		// bound to its own server connection.
		options.toolNames = [
			...(allow.tools ?? []),
			...(allow.outputSchema !== undefined ? ["yield"] : []),
			...mcpTools.map((tool) => tool.name),
		];
		options.restrictToolNames = true;
		if (mcpTools.length > 0) {
			options.customTools = mcpTools;
			options.allowRestrictedCustomTools = true;
		}
	}
	return options;
}
