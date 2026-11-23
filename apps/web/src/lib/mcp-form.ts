import type { AddMcpServerRequest, McpServerConfigInput, McpTransport } from "@omp-deck/protocol";

/** Raw add-server form fields; the textareas stay strings until submit. */
export interface McpServerForm {
	name: string;
	scope: AddMcpServerRequest["scope"];
	transport: McpTransport;
	command: string;
	/** One arg per line; a single line is split on whitespace. */
	args: string;
	/** One `KEY=VALUE` per line. */
	env: string;
	url: string;
	/** Optional bearer token for http/sse, sent as an `Authorization` header. */
	token: string;
}

export const EMPTY_MCP_FORM: McpServerForm = {
	name: "",
	scope: "user",
	transport: "stdio",
	command: "",
	args: "",
	env: "",
	url: "",
	token: "",
};

export const GOOGLE_WORKSPACE_FORM: McpServerForm = {
	...EMPTY_MCP_FORM,
	name: "google-workspace",
	command: "uvx",
	args: "workspace-mcp --tools gmail drive calendar",
	env: "GOOGLE_OAUTH_CLIENT_ID=\nGOOGLE_OAUTH_CLIENT_SECRET=",
};

function parseArgs(text: string): string[] {
	const rows = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return rows.length > 1 ? rows : rows.flatMap((row) => row.split(/\s+/));
}

function parseEnv(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim();
		if (!line) return;
		const eq = line.indexOf("=");
		const key = eq > 0 ? line.slice(0, eq).trim() : "";
		// Line number only: the line itself may hold a secret.
		if (!key) throw new Error(`Env line ${i + 1}: expected KEY=VALUE`);
		env[key] = line.slice(eq + 1).trim();
	});
	return env;
}

/** Turns the add form into the config the server writes to `mcp.json`. Throws on a malformed env line. */
export function buildMcpServerConfig(form: McpServerForm): McpServerConfigInput {
	if (form.transport === "stdio") {
		const args = parseArgs(form.args);
		const env = parseEnv(form.env);
		return {
			command: form.command.trim(),
			...(args.length > 0 ? { args } : {}),
			...(Object.keys(env).length > 0 ? { env } : {}),
		};
	}
	const token = form.token.trim().replace(/^bearer\s+/i, "");
	return {
		type: form.transport,
		url: form.url.trim(),
		...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
	};
}
