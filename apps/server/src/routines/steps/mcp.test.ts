import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify } from "yaml";

import type { RoutineSpec, RoutineStep } from "@omp-deck/protocol";

import { closeDb, openDb } from "../../db/index.ts";
import { listStepRuns } from "../../db/routine-step-runs.ts";
import { createV1Routine, startRun } from "../../db/routines.ts";
import type { RunContext } from "../types.ts";
import { runV1Pipeline } from "../v1-runner.ts";
import { executeMcpStep, type McpStepClient } from "./mcp.ts";

const ECHO = {
	name: "echo",
	inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
};

function fakeMcp(callTool: McpStepClient["callTool"], tools: Record<string, Array<typeof ECHO>> = { srv: [ECHO] }) {
	const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
	const client: McpStepClient = {
		async listTools(server) {
			const list = tools[server];
			if (!list) throw new Error(`MCP server "${server}" not found`);
			return list;
		},
		callTool(server, tool, args, signal) {
			calls.push({ server, tool, args });
			return callTool(server, tool, args, signal);
		},
	};
	return { client, calls };
}

function mcpStep(
	args: Record<string, unknown> = { msg: "hi" },
	tool = "echo",
	server = "srv",
): Extract<RoutineStep, { type: "mcp" }> {
	return { id: "call", type: "mcp", server, tool, args };
}

function ctx(steps: RunContext["steps"] = {}): RunContext {
	return {
		run: {
			id: "run_test_01",
			started: "2026-11-23T00:00:00.000Z",
			iso_started: "2026-11-23T00:00:00.000Z",
			date: "2026-11-23",
			epoch: 1795392000,
			trigger_kind: "manual",
		},
		trigger: {},
		steps,
		env: {},
		secrets: {},
		state: {},
	};
}

const signal = new AbortController().signal;

describe("executeMcpStep", () => {
	test("prefers structuredContent over text JSON", async () => {
		const { client } = fakeMcp(async () => ({
			content: [{ type: "text", text: '{"a":1}' }],
			structuredContent: { b: 2 },
		}));
		const result = await executeMcpStep(mcpStep(), ctx(), signal, client);
		expect(result.status).toBe("success");
		expect(result.json).toEqual({ b: 2 });
		expect(result.stdoutExcerpt).toBe('{"a":1}');
	});

	test("parses the first text block as JSON when structuredContent is null", async () => {
		const { client } = fakeMcp(async () => ({
			content: [
				{ type: "text", text: '{"a":1}' },
				{ type: "text", text: "second" },
			],
			structuredContent: null,
		}));
		const result = await executeMcpStep(mcpStep(), ctx(), signal, client);
		expect(result.json).toEqual({ a: 1 });
		expect(result.stdoutExcerpt).toBe('{"a":1}\nsecond');
	});

	test("falls back to the content array for plain text", async () => {
		const content = [
			{ type: "text", text: "hello" },
			{ type: "image" },
		];
		const { client } = fakeMcp(async () => ({ content }));
		const result = await executeMcpStep(mcpStep(), ctx(), signal, client);
		expect(result.status).toBe("success");
		expect(result.json).toEqual(content);
		expect(result.stdoutExcerpt).toBe("hello");
	});

	test("isError fails the step with the text, or a generic message", async () => {
		const withText = fakeMcp(async () => ({ content: [{ type: "text", text: "quota exceeded" }], isError: true }));
		const failed = await executeMcpStep(mcpStep(), ctx(), signal, withText.client);
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("quota exceeded");

		const bare = fakeMcp(async () => ({ content: [], isError: true }));
		expect((await executeMcpStep(mcpStep(), ctx(), signal, bare.client)).error).toBe("srv/echo returned an error");
	});

	test("schema-invalid args fail without calling the tool", async () => {
		const { client, calls } = fakeMcp(async () => ({ content: [] }));
		const result = await executeMcpStep(mcpStep({ msg: 5 }), ctx(), signal, client);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("invalid args for srv/echo");
		expect(result.error).toContain("/msg");
		expect(calls).toHaveLength(0);
	});

	test("an uncompilable input schema is skipped and the tool still runs", async () => {
		const broken = { name: "echo", inputSchema: { $ref: "#/$defs/missing" } } as unknown as typeof ECHO;
		const { client, calls } = fakeMcp(async () => ({ content: [{ type: "text", text: "ok" }] }), { srv: [broken] });
		const result = await executeMcpStep(mcpStep(), ctx(), signal, client);
		expect(result.status).toBe("success");
		expect(calls).toHaveLength(1);
	});

	test("unknown server or tool fails", async () => {
		const { client, calls } = fakeMcp(async () => ({ content: [] }));
		const noServer = await executeMcpStep(mcpStep({ msg: "hi" }, "echo", "nope"), ctx(), signal, client);
		expect(noServer.status).toBe("failed");
		expect(noServer.error).toBe('MCP server "nope" not found');

		const noTool = await executeMcpStep(mcpStep({}, "missing"), ctx(), signal, client);
		expect(noTool.status).toBe("failed");
		expect(noTool.error).toBe("unknown tool srv/missing");
		expect(calls).toHaveLength(0);
	});

	test("a throwing call is failed, or aborted once the run is cancelled", async () => {
		const { client } = fakeMcp(async () => {
			throw new Error("connection closed");
		});
		const failed = await executeMcpStep(mcpStep(), ctx(), signal, client);
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("connection closed");

		const controller = new AbortController();
		controller.abort();
		expect((await executeMcpStep(mcpStep(), ctx(), controller.signal, client)).status).toBe("aborted");
	});

	test("templates args from the run context, preserving types", async () => {
		const { client, calls } = fakeMcp(async () => ({ content: [] }));
		const context = ctx({
			x: { status: "success", stdout: "", stderr: "", duration_ms: 0, json: { y: { ids: [1, 2] } } },
		});
		const step = mcpStep({ msg: "run {{ run.id }}", payload: "{{ steps.x.json.y }}" });
		await executeMcpStep(step, context, signal, client);
		expect(calls[0]?.args).toEqual({ msg: "run run_test_01", payload: { ids: [1, 2] } });
	});
});

test("runV1Pipeline exposes an mcp step's json to a downstream transform", async () => {
	const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-mcp-step-"));
	openDb({ path: path.join(dbDir, "deck.db") });
	try {
		const spec: RoutineSpec = {
			name: "mcp-pipeline",
			trigger: [{ manual: {} }],
			steps: [
				{ id: "fetch", type: "mcp", server: "srv", tool: "echo", args: { msg: "hi" } },
				{ id: "count", type: "transform", body: "steps.fetch.json.items.length" },
			],
		};
		const routine = createV1Routine({ name: spec.name, specYaml: stringify(spec), spec });
		const run = startRun(routine.id, "manual");
		const { client } = fakeMcp(async () => ({ content: [], structuredContent: { items: ["a", "b", "c"] } }));

		const outcome = await runV1Pipeline({
			routine,
			spec,
			runId: run.id,
			triggerKind: "manual",
			triggerPayload: {},
			abortSignal: new AbortController().signal,
			defaultCwd: dbDir,
			agentSandboxRoot: path.join(dbDir, "routine-runs"),
			mcp: client,
		});

		expect(outcome.status).toBe("success");
		const count = listStepRuns(run.id).find((s) => s.stepId === "count");
		expect(count?.outputJson).toBe("3");
	} finally {
		closeDb();
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows can hold the SQLite handle briefly after close; a leaked temp dir is harmless.
		}
	}
});
