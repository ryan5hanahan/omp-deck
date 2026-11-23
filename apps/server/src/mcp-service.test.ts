import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { disposeLocalMcpHost, localMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { type McpServerInfo, McpService, UnknownMcpServerError } from "./mcp-service.ts";

const FIXTURE = path.join(import.meta.dir, "test-fixtures", "fake-mcp-server.ts");
const source = { provider: "test", providerName: "test", path: FIXTURE, level: "project" as const };

// Injected configs and the in-process host: the user's MCP config files, auth
// storage and omp daemon are never touched.
const service = new McpService({
	cwd: import.meta.dir,
	loadConfigs: async () => ({
		configs: {
			fake: { type: "stdio", command: process.execPath, args: [FIXTURE] },
			broken: { type: "stdio", command: process.execPath, args: [path.join(import.meta.dir, "no-such-server.ts")] },
		},
		exaApiKeys: [],
		sources: { fake: source, broken: source },
	}),
	hostAccess: localMcpHost(),
});

afterAll(async () => {
	await service.dispose();
	await disposeLocalMcpHost();
});

/** Real subprocesses, and the service exposes no completion event: poll until nothing reports "connecting". */
async function settledServers(): Promise<McpServerInfo[]> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const servers = await service.listServers();
		if (!servers.some((server) => server.status === "connecting")) return servers;
		await Bun.sleep(50);
	}
	throw new Error("MCP servers still connecting after 10s");
}

describe("McpService", () => {
	test("lists the fake server as connected and the broken one as an error", async () => {
		const servers = await settledServers();
		expect(servers.find((server) => server.name === "fake")).toEqual({
			name: "fake",
			status: "connected",
			transport: "stdio",
			sourcePath: FIXTURE,
		});
		const broken = servers.find((server) => server.name === "broken");
		expect(broken?.status).toBe("error");
		expect(broken?.error).toBeTruthy();
	}, 15_000);

	test("lists tools with their raw input schemas", async () => {
		const tools = await service.listTools("fake");
		expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "fail", "json_text"]);
		expect(tools.find((tool) => tool.name === "echo")?.inputSchema).toEqual({
			type: "object",
			required: ["text"],
			properties: { text: { type: "string" } },
		});
	});

	test("calls a tool and returns the SDK result unchanged", async () => {
		const result = await service.callTool("fake", "echo", { text: "hi" }, AbortSignal.timeout(5_000));
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		expect(result.structuredContent).toEqual({ text: "hi" });
		expect(result.isError).toBeFalsy();

		const failed = await service.callTool("fake", "fail", {}, AbortSignal.timeout(5_000));
		expect(failed.isError).toBe(true);
	});

	test("rejects an unknown server", async () => {
		await expect(service.listTools("nope")).rejects.toBeInstanceOf(UnknownMcpServerError);
		await expect(service.callTool("nope", "echo", {}, AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(
			UnknownMcpServerError,
		);
	});

	test("reload reconnects and serves calls again", async () => {
		await service.reload();
		const result = await service.callTool("fake", "echo", { text: "again" }, AbortSignal.timeout(5_000));
		expect(result.structuredContent).toEqual({ text: "again" });
	}, 15_000);
});
