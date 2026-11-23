/**
 * `agent` step: one in-process headless agent run (`AgentBridge.runHeadless`).
 * The final assistant text becomes stdout. With `structured_output` the model
 * returns its result through the `yield` tool; a run that never yields falls
 * back to parsing the final text as JSON.
 */

import { type RoutineStep, validateAgainstSchema } from "@omp-deck/protocol";
import type { AgentBridge } from "../../bridge/types.ts";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";

export type HeadlessRunner = AgentBridge["runHeadless"];

const MAX_EXCERPT = 8 * 1024;

export async function executeAgentStep(
	step: Extract<RoutineStep, { type: "agent" }>,
	context: RunContext,
	signal: AbortSignal,
	cwd: string,
	runHeadless: HeadlessRunner | undefined,
): Promise<StepResult> {
	const startedMs = Date.now();
	if (!runHeadless) {
		return {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: "agent steps need the deck's agent bridge, and none is registered",
			durationMs: 0,
		};
	}
	const prompt = renderString(step.prompt, context as unknown as Record<string, unknown>);

	try {
		const run = await runHeadless({
			cwd,
			prompt,
			label: `agent step ${step.id}`,
			model: step.model,
			skills: step.skills_allowed,
			mcpServers: step.mcp_servers_allowed,
			outputSchema: step.structured_output?.schema,
			signal,
		});
		const durationMs = Date.now() - startedMs;
		const usage = {
			model: run.model || step.model,
			// Cached prompt tokens are still input the model read.
			llmTokensIn: run.usage.input + run.usage.cacheRead + run.usage.cacheWrite,
			llmTokensOut: run.usage.output,
			llmCostMicros: Math.round(run.usage.cost * 1_000_000),
		};
		const stdoutExcerpt = clip(run.text || (run.json === undefined ? "" : JSON.stringify(run.json)));
		if (signal.aborted) {
			return { status: "aborted", stdoutExcerpt, stderrExcerpt: "", error: "aborted", durationMs, ...usage };
		}
		if (run.error) {
			return { status: "failed", stdoutExcerpt, stderrExcerpt: "", error: run.error, durationMs, ...usage };
		}

		let json: unknown;
		if (step.structured_output) {
			const structured = readStructured(step.structured_output.schema, run.json, run.text);
			if (structured.error && step.structured_output.strict !== false) {
				return { status: "failed", stdoutExcerpt, stderrExcerpt: "", error: structured.error, durationMs, ...usage };
			}
			json = structured.value;
		}
		return { status: "success", stdoutExcerpt, stderrExcerpt: "", json, durationMs, ...usage };
	} catch (err) {
		return {
			status: signal.aborted ? "aborted" : "failed",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: signal.aborted ? "aborted" : err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - startedMs,
		};
	}
}

/** The yielded value, else the final text parsed as JSON; `error` when neither matches the schema. */
function readStructured(schema: unknown, yielded: unknown, text: string): { value?: unknown; error?: string } {
	let value = yielded;
	if (value === undefined) {
		try {
			value = JSON.parse(text.trim());
		} catch (err) {
			return { error: `structured_output parse failure: ${String(err)}` };
		}
	}
	try {
		const result = validateAgainstSchema(schema, value);
		if (result.valid) return { value };
		const issues = (result.errors ?? []).map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ");
		return { value, error: `structured_output does not match the schema: ${issues}` };
	} catch (err) {
		return { value, error: `structured_output schema is invalid: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function clip(text: string): string {
	return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}\n…(truncated)` : text;
}
