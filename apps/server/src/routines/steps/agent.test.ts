import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify } from "yaml";

import type { RoutineSpec, RoutineStep } from "@omp-deck/protocol";

import type { HeadlessRunOptions, HeadlessRunResult } from "../../bridge/types.ts";
import { closeDb, openDb } from "../../db/index.ts";
import { listStepRuns } from "../../db/routine-step-runs.ts";
import { createV1Routine, startRun } from "../../db/routines.ts";
import type { RunContext } from "../types.ts";
import { runV1Pipeline } from "../v1-runner.ts";
import { executeAgentStep } from "./agent.ts";

const USAGE = { input: 100, output: 40, reasoning: 0, cacheRead: 1000, cacheWrite: 50, total: 1190, cost: 0.0123 };
const SCHEMA = { type: "object", required: ["count"], properties: { count: { type: "number" } } };

/** Stands in for `AgentBridge.runHeadless`: records its options, returns `result` over a usage-only default. */
function fakeRunner(result: Partial<HeadlessRunResult> | ((opts: HeadlessRunOptions) => Promise<HeadlessRunResult>) = {}) {
	const calls: HeadlessRunOptions[] = [];
	const run = async (opts: HeadlessRunOptions): Promise<HeadlessRunResult> => {
		calls.push(opts);
		if (typeof result === "function") return result(opts);
		return { text: "", usage: USAGE, model: "anthropic/claude-sonnet-4-6", ...result };
	};
	return { run, calls };
}

function agentStep(extra: Partial<Extract<RoutineStep, { type: "agent" }>> = {}): Extract<RoutineStep, { type: "agent" }> {
	return { id: "brief", type: "agent", prompt: "Brief for {{ run.date }}", ...extra };
}

function ctx(): RunContext {
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
		steps: {},
		env: {},
		secrets: {},
		state: {},
	};
}

const signal = new AbortController().signal;

describe("executeAgentStep", () => {
	test("renders the prompt, passes the allowlists, and records real usage", async () => {
		const { run, calls } = fakeRunner({ text: "## Briefing" });
		const step = agentStep({
			model: "claude-sonnet-4-6",
			skills_allowed: ["deck-inbox"],
			mcp_servers_allowed: ["fake"],
			tools_allowed: ["read"],
		});
		const result = await executeAgentStep(step, ctx(), signal, "/sandbox", run);

		expect(calls).toEqual([
			{
				cwd: "/sandbox",
				prompt: "Brief for 2026-11-23",
				label: "agent step brief",
				model: "claude-sonnet-4-6",
				skills: ["deck-inbox"],
				mcpServers: ["fake"],
				tools: ["read"],
				outputSchema: undefined,
				signal,
			},
		]);
		expect(result).toMatchObject({
			status: "success",
			stdoutExcerpt: "## Briefing",
			model: "anthropic/claude-sonnet-4-6",
			llmTokensIn: 1150,
			llmTokensOut: 40,
			llmCostMicros: 12_300,
		});
		expect(result.json).toBeUndefined();
	});

	test("structured_output: a yielded object that matches the schema becomes json", async () => {
		const { run, calls } = fakeRunner({ json: { count: 2 } });
		const result = await executeAgentStep(agentStep({ structured_output: { schema: SCHEMA } }), ctx(), signal, "/s", run);
		expect(calls[0]?.outputSchema).toBe(SCHEMA);
		expect(result.status).toBe("success");
		expect(result.json).toEqual({ count: 2 });
		expect(result.stdoutExcerpt).toBe('{"count":2}');
	});

	test("strict structured_output fails on a mismatching object and still records usage", async () => {
		const { run } = fakeRunner({ json: { count: "two" } });
		const result = await executeAgentStep(agentStep({ structured_output: { schema: SCHEMA } }), ctx(), signal, "/s", run);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("does not match the schema");
		expect(result.llmCostMicros).toBe(12_300);
	});

	test("non-strict structured_output keeps a mismatching object", async () => {
		const { run } = fakeRunner({ json: { count: "two" } });
		const step = agentStep({ structured_output: { schema: SCHEMA, strict: false } });
		const result = await executeAgentStep(step, ctx(), signal, "/s", run);
		expect(result.status).toBe("success");
		expect(result.json).toEqual({ count: "two" });
	});

	test("without a yield, the final text is parsed and validated instead", async () => {
		const step = agentStep({ structured_output: { schema: SCHEMA } });
		const parsed = await executeAgentStep(step, ctx(), signal, "/s", fakeRunner({ text: ' {"count": 3}\n' }).run);
		expect(parsed.status).toBe("success");
		expect(parsed.json).toEqual({ count: 3 });

		const prose = await executeAgentStep(step, ctx(), signal, "/s", fakeRunner({ text: "three" }).run);
		expect(prose.status).toBe("failed");
		expect(prose.error).toContain("structured_output parse failure");
	});

	test("a run that ends on a model error fails the step with its usage", async () => {
		const { run } = fakeRunner({ text: "partial", error: "overloaded" });
		const result = await executeAgentStep(agentStep(), ctx(), signal, "/s", run);
		expect(result).toMatchObject({ status: "failed", error: "overloaded", stdoutExcerpt: "partial", llmTokensOut: 40 });
	});

	test("an abort maps to aborted, whether the run returns or throws", async () => {
		const returned = new AbortController();
		const stopped = fakeRunner(async () => {
			returned.abort();
			return { text: "", error: "request aborted", usage: USAGE, model: "m" };
		});
		const afterReturn = await executeAgentStep(agentStep(), ctx(), returned.signal, "/s", stopped.run);
		expect(afterReturn).toMatchObject({ status: "aborted", error: "aborted", llmTokensIn: 1150 });

		const thrown = new AbortController();
		thrown.abort();
		const rejecting = fakeRunner(async (opts) => {
			opts.signal.throwIfAborted();
			throw new Error("unreachable");
		});
		const afterThrow = await executeAgentStep(agentStep(), ctx(), thrown.signal, "/s", rejecting.run);
		expect(afterThrow).toMatchObject({ status: "aborted", error: "aborted" });
	});

	test("a runner error before the LLM call fails the step with its message", async () => {
		const { run } = fakeRunner(async () => {
			throw new Error("MCP server not installed: ghost");
		});
		const result = await executeAgentStep(agentStep(), ctx(), signal, "/s", run);
		expect(result).toMatchObject({ status: "failed", error: "MCP server not installed: ghost" });
		expect(result.llmTokensIn).toBeUndefined();
	});

	test("fails clearly when no runner is registered", async () => {
		const result = await executeAgentStep(agentStep(), ctx(), signal, "/s", undefined);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("none is registered");
	});
});

test("runV1Pipeline hands a yielded object to downstream steps and records the agent's usage", async () => {
	const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agent-step-"));
	openDb({ path: path.join(dbDir, "deck.db") });
	try {
		const spec: RoutineSpec = {
			name: "agent-pipeline",
			trigger: [{ manual: {} }],
			steps: [
				{ id: "classify", type: "agent", prompt: "count things", structured_output: { schema: SCHEMA } },
				{ id: "double", type: "transform", body: "steps.classify.json.count * 2" },
			],
		};
		const routine = createV1Routine({ name: spec.name, specYaml: stringify(spec), spec });
		const run = startRun(routine.id, "manual");
		const { run: runHeadless, calls } = fakeRunner({ json: { count: 21 } });

		const outcome = await runV1Pipeline({
			routine,
			spec,
			runId: run.id,
			triggerKind: "manual",
			triggerPayload: {},
			abortSignal: new AbortController().signal,
			defaultCwd: dbDir,
			agentSandboxRoot: path.join(dbDir, "routine-runs"),
			runHeadless,
		});

		expect(outcome.status).toBe("success");
		expect(calls[0]?.cwd).toBe(path.join(dbDir, "routine-runs", run.id));
		const steps = listStepRuns(run.id);
		expect(steps.find((s) => s.stepId === "double")?.outputJson).toBe("42");
		expect(steps.find((s) => s.stepId === "classify")).toMatchObject({ llmTokensIn: 1150, llmCostMicros: 12_300 });
	} finally {
		closeDb();
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows can hold the SQLite handle briefly after close; a leaked temp dir is harmless.
		}
	}
});
