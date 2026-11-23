/**
 * `transform` step: pure-JS expression over the run context, evaluated in the
 * quickjs sandbox. Returns whatever the expression returns; captured as the
 * step's json output for downstream steps.
 */

import type { RoutineStep } from "@omp-deck/protocol";
import { evaluate, MAX_TIMEOUT_MS } from "../sandbox.ts";
import type { RunContext, StepResult } from "../types.ts";

export async function executeTransformStep(
	step: Extract<RoutineStep, { type: "transform" }>,
	context: RunContext,
	_signal: AbortSignal,
): Promise<StepResult> {
	const startedMs = Date.now();
	try {
		// Transforms process real data (e.g. a page of mail); the 100 ms default is for `when:` guards and filters.
		const result = await evaluate(step.body, context as unknown as Record<string, unknown>, { timeoutMs: MAX_TIMEOUT_MS });
		return {
			status: "success",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			json: result,
			durationMs: Date.now() - startedMs,
		};
	} catch (err) {
		return {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: String(err),
			error: String(err),
			durationMs: Date.now() - startedMs,
		};
	}
}
