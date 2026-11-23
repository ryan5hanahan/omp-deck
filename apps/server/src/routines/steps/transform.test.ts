import { describe, expect, test } from "bun:test";
import type { RoutineStep } from "@omp-deck/protocol";
import type { RunContext } from "../types.ts";
import { executeTransformStep } from "./transform.ts";

function ctx(): RunContext {
	return {
		run: {
			id: "run_test_01",
			started: "2026-05-21T00:00:00.000Z",
			iso_started: "2026-05-21T00:00:00.000Z",
			date: "2026-05-21",
			epoch: 1779321600,
			trigger_kind: "manual",
		},
		trigger: {},
		steps: {},
		env: {},
		secrets: {},
		state: {},
	};
}

function transform(body: string): Extract<RoutineStep, { type: "transform" }> {
	return { id: "t", type: "transform", body };
}

describe("executeTransformStep", () => {
	test("work longer than the 100 ms guard budget still succeeds", async () => {
		const body = "const t = Date.now(); while (Date.now() - t < 300) {} return 1";
		const result = await executeTransformStep(transform(body), ctx(), new AbortController().signal);
		expect(result.status).toBe("success");
		expect(result.json).toBe(1);
	});

	test("a runaway transform is still interrupted", async () => {
		const t0 = Date.now();
		const result = await executeTransformStep(transform("while (true) {}"), ctx(), new AbortController().signal);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("interrupted");
		expect(Date.now() - t0).toBeLessThan(3000);
	});
});
