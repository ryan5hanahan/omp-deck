import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type LoadMCPConfigsResult,
	listMCPServers,
	type MCPServerConfig,
	readMCPConfigFile,
	writeMCPConfigFile,
} from "@oh-my-pi/pi-coding-agent/mcp";
import { disposeLocalMcpHost, localMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import type { McpServerSummary, McpToolSummary } from "@omp-deck/protocol";
import { McpService } from "./mcp-service.ts";
import { buildMcpRouter } from "./routes-mcp.ts";

const FIXTURE = path.join(import.meta.dir, "test-fixtures", "fake-mcp-server.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-mcp-"));
const userPath = path.join(tmp, "agent", "mcp.json");
const projectPath = path.join(tmp, "project", ".omp", "mcp.json");
/** Where the `ext` server claims to come from: another tool's config the deck never writes. */
const externalPath = path.join(tmp, "project", ".cursor", "mcp.json");

const ENV_SECRET = "env-secret-4f2a";
const BEARER_TOKEN = "tok-secret-9c1d";
const STDERR_SECRET = "stderr-secret-7e3b";

// Discovery over the temp files only (plus one external server), honouring `enabled` and the
// user allow/denylists like the SDK's loader. With the in-process host, the user's MCP config
// files, auth storage and omp daemon are never touched.
const service = new McpService({
	cwd: tmp,
	loadConfigs: async () => {
		const [user, project] = await Promise.all([readMCPConfigFile(userPath), readMCPConfigFile(projectPath)]);
		const denied = new Set(user.disabledServers ?? []);
		const forced = new Set(user.enabledServers ?? []);
		const result: LoadMCPConfigsResult = { configs: {}, exaApiKeys: [], sources: {} };
		const add = (name: string, config: MCPServerConfig, file: string): void => {
			if (name in result.configs || denied.has(name) || (config.enabled === false && !forced.has(name))) return;
			result.configs[name] = config;
			result.sources[name] = { provider: "test", providerName: "test", path: file, level: "project" };
		};
		for (const [name, config] of Object.entries(project.mcpServers ?? {})) add(name, config, projectPath);
		for (const [name, config] of Object.entries(user.mcpServers ?? {})) add(name, config, userPath);
		add("ext", { type: "stdio", command: process.execPath, args: [FIXTURE] }, externalPath);
		return result;
	},
	hostAccess: localMcpHost(),
});
const app = buildMcpRouter({ service, cwd: tmp, userConfigPath: userPath, projectConfigPath: projectPath });

beforeAll(async () => {
	await writeMCPConfigFile(userPath, {
		mcpServers: {
			// Disabled, so nothing ever dials it; it is only here to be listed without its header.
			remote: {
				type: "http",
				url: "https://mcp.example.invalid/mcp",
				headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
				enabled: false,
			},
			// Fails on start after printing its env secret to stderr.
			leaky: {
				type: "stdio",
				command: process.execPath,
				args: ["-e", "console.error(process.env.LEAK_SECRET); process.exit(1)"],
				env: { LEAK_SECRET: STDERR_SECRET },
			},
		},
	});
});

afterAll(async () => {
	await service.dispose();
	await disposeLocalMcpHost();
	fs.rmSync(tmp, { recursive: true, force: true });
});

function call(method: string, url: string, body?: unknown): Promise<Response> {
	return Promise.resolve(
		app.request(
			url,
			body === undefined
				? { method }
				: { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		),
	);
}

/** Real subprocesses, and the service exposes no completion event: poll until nothing reports "connecting". */
async function settledServers(): Promise<McpServerSummary[]> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const servers = (await (await call("GET", "/mcp/servers")).json()) as McpServerSummary[];
		if (!servers.some((server) => server.status === "connecting")) return servers;
		await Bun.sleep(50);
	}
	throw new Error("MCP servers still connecting after 10s");
}

const fakeConfig = { command: process.execPath, args: [FIXTURE] };

describe("/mcp routes", () => {
	test("adds a stdio server to the user config and lists it connected with its tools", async () => {
		const res = await call("POST", "/mcp/servers", {
			name: "fake",
			config: { ...fakeConfig, env: { FAKE_TOKEN: ENV_SECRET } },
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			name: "fake",
			scope: "user",
			sourcePath: userPath,
			transport: "stdio",
			enabled: true,
		});
		expect((await readMCPConfigFile(userPath)).mcpServers?.fake).toEqual({
			type: "stdio",
			...fakeConfig,
			env: { FAKE_TOKEN: ENV_SECRET },
		});

		const fake = (await settledServers()).find((server) => server.name === "fake");
		expect(fake).toMatchObject({ status: "connected", toolCount: 3 });
	}, 15_000);

	test("lists disabled and external servers and never echoes secrets", async () => {
		const text = await (await call("GET", "/mcp/servers")).text();
		expect(text).not.toContain(ENV_SECRET);
		expect(text).not.toContain(BEARER_TOKEN);
		expect(text).not.toContain(STDERR_SECRET);

		const servers = JSON.parse(text) as McpServerSummary[];
		expect(servers.find((server) => server.name === "remote")).toEqual({
			name: "remote",
			scope: "user",
			sourcePath: userPath,
			transport: "http",
			enabled: false,
			status: "disconnected",
			toolCount: 0,
		});
		expect(servers.find((server) => server.name === "ext")).toMatchObject({
			scope: "external",
			sourcePath: externalPath,
			enabled: true,
			status: "connected",
		});
		expect(servers.find((server) => server.name === "leaky")?.status).toBe("error");
	});

	test("lists a server's tools with their raw input schemas", async () => {
		const tools = (await (await call("GET", "/mcp/servers/fake/tools")).json()) as McpToolSummary[];
		expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "fail", "json_text"]);
		expect(tools.find((tool) => tool.name === "echo")?.inputSchema).toEqual({
			type: "object",
			required: ["text"],
			properties: { text: { type: "string" } },
		});
		expect((await call("GET", "/mcp/servers/nope/tools")).status).toBe(404);
	});

	test("rejects duplicate names in any scope and invalid input", async () => {
		expect((await call("POST", "/mcp/servers", { name: "fake", scope: "project", config: fakeConfig })).status).toBe(
			409,
		);
		expect((await call("POST", "/mcp/servers", { name: "ext", config: fakeConfig })).status).toBe(409);

		expect((await call("POST", "/mcp/servers", { name: "bad/name", config: fakeConfig })).status).toBe(400);
		expect((await call("POST", "/mcp/servers", { name: "ok", scope: "global", config: fakeConfig })).status).toBe(
			400,
		);
		const badConfig = await call("POST", "/mcp/servers", { name: "ok", config: { type: "http", url: "" } });
		expect(badConfig.status).toBe(400);
		expect(await badConfig.json()).toMatchObject({ error: expect.stringContaining("url") });

		expect(await listMCPServers(projectPath)).toEqual([]);
		expect(await listMCPServers(userPath)).not.toContain("ok");
	});

	test("reconnects a loaded server", async () => {
		const res = await call("POST", "/mcp/servers/fake/reconnect");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ name: "fake", scope: "user" });
		expect((await settledServers()).find((server) => server.name === "fake")?.status).toBe("connected");
		expect((await call("POST", "/mcp/servers/nope/reconnect")).status).toBe(404);
	}, 15_000);

	test("disabling a user server writes enabled:false and keeps it listed", async () => {
		expect((await call("POST", "/mcp/servers/fake/enabled", { enabled: "no" })).status).toBe(400);

		const res = await call("POST", "/mcp/servers/fake/enabled", { enabled: false });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			name: "fake",
			scope: "user",
			enabled: false,
			status: "disconnected",
			toolCount: 0,
		});
		expect((await readMCPConfigFile(userPath)).mcpServers?.fake?.enabled).toBe(false);
	}, 15_000);

	test("an external server cannot be removed but can be disabled and re-enabled", async () => {
		expect((await call("DELETE", "/mcp/servers/ext")).status).toBe(400);

		const off = await call("POST", "/mcp/servers/ext/enabled", { enabled: false });
		expect(off.status).toBe(200);
		// Denylisted, so the SDK no longer loads it: no transport or source is known.
		expect(await off.json()).toEqual({
			name: "ext",
			scope: "external",
			enabled: false,
			status: "disconnected",
			toolCount: 0,
		});
		expect((await readMCPConfigFile(userPath)).disabledServers).toEqual(["ext"]);
		expect((await settledServers()).find((server) => server.name === "ext")?.enabled).toBe(false);

		const on = await call("POST", "/mcp/servers/ext/enabled", { enabled: true });
		expect(on.status).toBe(200);
		expect(await on.json()).toMatchObject({
			name: "ext",
			scope: "external",
			sourcePath: externalPath,
			transport: "stdio",
			enabled: true,
		});
		expect((await readMCPConfigFile(userPath)).disabledServers).toBeUndefined();
	}, 15_000);

	test("removes a user server from its file", async () => {
		const res = await call("DELETE", "/mcp/servers/fake?scope=user");
		expect(res.status).toBe(204);
		expect(await listMCPServers(userPath)).not.toContain("fake");
		expect((await settledServers()).some((server) => server.name === "fake")).toBe(false);
		expect((await call("DELETE", "/mcp/servers/nope")).status).toBe(404);
	}, 15_000);

	test("reauth of an unknown server is a 404 before any SDK lookup", async () => {
		expect((await call("POST", "/mcp/servers/nope/reauth")).status).toBe(404);
	});
});
