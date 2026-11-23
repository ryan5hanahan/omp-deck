/**
 * Fake handshake-era MCP server for tests: JSON-RPC 2.0 over stdio, one JSON
 * message per line. Run as `bun fake-mcp-server.ts`; exits when stdin closes.
 *
 * Tools: `echo` (text block + `structuredContent: {text}`), `json_text` (JSON in
 * a text block, no `structuredContent`), `fail` (`isError: true`, text `boom`).
 */

// Module scope, for the top-level `for await` below.
export {};

interface JsonRpcMessage {
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
}

type Reply = { result: unknown } | { error: { code: number; message: string } };

const TOOLS = [
	{
		name: "echo",
		description: "Echo the given text.",
		inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
	},
	{
		name: "json_text",
		description: "Return a JSON object as a text block.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "fail",
		description: "Always report a tool error.",
		inputSchema: { type: "object", properties: {} },
	},
];

function callTool(name: unknown, args: Record<string, unknown>): Reply {
	switch (name) {
		case "echo": {
			const text = String(args.text ?? "");
			return { result: { content: [{ type: "text", text }], structuredContent: { text } } };
		}
		case "json_text":
			return { result: { content: [{ type: "text", text: JSON.stringify({ ok: true, n: 2 }) }] } };
		case "fail":
			return { result: { content: [{ type: "text", text: "boom" }], isError: true } };
		default:
			return { error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
	}
}

function handle(method: string, params: Record<string, unknown>): Reply {
	switch (method) {
		case "initialize":
			return {
				result: {
					protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "fake-mcp", version: "1.0.0" },
				},
			};
		case "ping":
			return { result: {} };
		case "tools/list":
			return { result: { tools: TOOLS } };
		case "tools/call":
			return callTool(params.name, (params.arguments ?? {}) as Record<string, unknown>);
		default:
			// Includes `server/discover`: a plain method-not-found makes the SDK's probe treat this as handshake-era.
			return { error: { code: -32601, message: `Method not found: ${method}` } };
	}
}

for await (const line of console) {
	if (!line.trim()) continue;
	const message = JSON.parse(line) as JsonRpcMessage;
	// Notifications (`notifications/initialized`, cancellations) and responses get no reply.
	if (message.id === undefined || typeof message.method !== "string") continue;
	const reply = handle(message.method, message.params ?? {});
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })}\n`);
}
