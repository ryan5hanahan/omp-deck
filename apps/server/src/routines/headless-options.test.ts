import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeLocalMcpHost, localMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { McpService } from "../mcp-service.ts";
import { buildHeadlessOptions } from "./headless-options.ts";

const FIXTURE = path.join(import.meta.dir, "..", "test-fixtures", "fake-mcp-server.ts");
const source = { provider: "test", providerName: "test", path: FIXTURE, level: "project" as const };
const fixtureConfig = { type: "stdio" as const, command: process.execPath, args: [FIXTURE] };

// Injected configs and the in-process host: the user's MCP config files and omp daemon are never touched.
const service = new McpService({
	cwd: import.meta.dir,
	loadConfigs: async () => ({
		configs: { fake: fixtureConfig, other: fixtureConfig },
		exaApiKeys: [],
		sources: { fake: source, other: source },
	}),
	hostAccess: localMcpHost(),
});

afterAll(async () => {
	await service.dispose();
	await disposeLocalMcpHost();
});

const SKILLS = [{ name: "a" }, { name: "b" }, { name: "c" }];

const untouched = {
	discoverSkills: async (): Promise<typeof SKILLS> => {
		throw new Error("skill discovery should not run");
	},
	getMcpManager: async (): Promise<never> => {
		throw new Error("the MCP manager should not be touched");
	},
};

describe("buildHeadlessOptions", () => {
	test("omitted lists leave the SDK's own discovery in place", async () => {
		expect(await buildHeadlessOptions({}, untouched)).toEqual({});
	});

	test("empty lists turn skills and MCP off without discovering anything", async () => {
		expect(await buildHeadlessOptions({ skills: [], mcpServers: [] }, untouched)).toEqual({
			skills: [],
			enableMCP: false,
		});
	});

	test("a skills list keeps only the named discovered skills", async () => {
		const options = await buildHeadlessOptions(
			{ skills: ["a", "c", "not-installed"] },
			{ ...untouched, discoverSkills: async () => SKILLS },
		);
		expect(options).toEqual({ skills: [{ name: "a" }, { name: "c" }] });
	});

	test("an MCP server that isn't installed fails, naming it", async () => {
		const manager = {
			getAllServerNames: () => ["fake"],
			getTools: () => [],
			waitForStartup: async () => {},
		};
		await expect(
			buildHeadlessOptions({ mcpServers: ["fake", "ghost"] }, { ...untouched, getMcpManager: async () => manager }),
		).rejects.toThrow("MCP server not installed: ghost");
	});

	test("an MCP list hands the shared manager and only that server's tools", async () => {
		const manager = await service.getManager();
		const options = await buildHeadlessOptions(
			{ mcpServers: ["fake"] },
			{ ...untouched, getMcpManager: () => service.getManager() },
		);
		expect(options.mcpManager).toBe(manager);
		const names = (options.mcpTools ?? []).map((tool) => tool.name).sort();
		expect(names).toEqual(["mcp__fake_echo", "mcp__fake_fail", "mcp__fake_json_text"]);
		// The other server is connected too; its tools stay out.
		expect(manager.getTools().some((tool) => tool.mcpServerName === "other")).toBe(true);
	}, 30_000);
});

describe("buildHeadlessOptions: tools allowlist", () => {
	test("an empty list restricts the session to nothing, keeping yield for structured output", async () => {
		expect(await buildHeadlessOptions({ tools: [], mcpServers: [] }, untouched)).toEqual({
			enableMCP: false,
			toolNames: [],
			restrictToolNames: true,
		});
		expect(await buildHeadlessOptions({ tools: [], mcpServers: [], outputSchema: { type: "object" } }, untouched)).toEqual(
			{ enableMCP: false, toolNames: ["yield"], restrictToolNames: true },
		);
	});

	test("a list is exactly those built-ins (+ yield when needed)", async () => {
		const options = await buildHeadlessOptions({ tools: ["read", "grep"], mcpServers: [], outputSchema: {} }, untouched);
		expect(options).toEqual({ enableMCP: false, toolNames: ["read", "grep", "yield"], restrictToolNames: true });
	});

	test("an unknown name fails before any discovery, naming it", async () => {
		await expect(
			buildHeadlessOptions({ tools: ["read", "shell"], skills: ["a"], mcpServers: ["fake"] }, untouched),
		).rejects.toThrow("unknown built-in tool: shell");
	});

	test("allowed MCP tools join the restricted session as named custom tools", async () => {
		const options = await buildHeadlessOptions(
			{ tools: [], mcpServers: ["fake"] },
			{ ...untouched, getMcpManager: () => service.getManager() },
		);
		const names = ["mcp__fake_echo", "mcp__fake_fail", "mcp__fake_json_text"];
		expect([...(options.toolNames ?? [])].sort()).toEqual(names);
		expect((options.customTools ?? []).map((tool) => tool.name).sort()).toEqual(names);
		expect(options).toMatchObject({ restrictToolNames: true, allowRestrictedCustomTools: true });
		// A restricted session ignores these; handing them anyway would be misleading.
		expect(options.mcpManager).toBeUndefined();
		expect(options.mcpTools).toBeUndefined();
	}, 30_000);

	test("with no MCP list, a tools list keeps every installed server's tools", async () => {
		const options = await buildHeadlessOptions({ tools: ["read"] }, { ...untouched, getMcpManager: () => service.getManager() });
		expect(new Set((options.customTools ?? []).map((tool) => tool.mcpServerName))).toEqual(new Set(["fake", "other"]));
		expect(options.toolNames?.[0]).toBe("read");
	}, 30_000);
});

test("the SDK keeps a restricted list exact and widens an unrestricted one", async () => {
	// Settings that make the SDK auto-include memory and skill tools into an explicit list.
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "memory.backend": "mnemopi", "autolearn.enabled": true }),
		skipPythonPreflight: true,
		requireYieldTool: true,
	};
	expect((await resolveBuiltinToolPlan({ ...session, restrictToolNames: true }, [])).names).toEqual(["yield"]);
	expect((await resolveBuiltinToolPlan({ ...session, restrictToolNames: true }, ["read"])).names).toEqual([
		"read",
		"yield",
	]);
	const widened = (await resolveBuiltinToolPlan(session, [])).names;
	expect(widened).toContain("retain");
	expect(widened).toContain("manage_skill");
});
