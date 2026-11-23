import { describe, expect, test } from "bun:test";

import type { RoutineStep } from "./index.ts";
import { extractStepReferences, findOrderingProblems } from "./step-references.ts";

describe("extractStepReferences", () => {
	test("finds refs in a templated prompt and `when`", () => {
		const step: RoutineStep = {
			id: "summarize",
			type: "agent",
			when: "steps.fetch.status === 'success'",
			prompt: "Summarize {{ steps.fetch.json }} using {{ steps.notes.text }}",
		};
		expect(extractStepReferences(step)).toEqual(["fetch", "notes"]);
	});

	test("walks nested `args` objects and arrays", () => {
		const step: RoutineStep = {
			id: "send",
			type: "mcp",
			server: "gmail",
			tool: "send",
			args: { to: ["{{ steps.lookup.json.email }}"], meta: { body: "{{ steps.draft.text }}" } },
		};
		expect(extractStepReferences(step)).toEqual(["lookup", "draft"]);
	});

	test("matches only the step-id charset", () => {
		const step: RoutineStep = {
			id: "x",
			type: "transform",
			body: "steps.a-b.json + steps.Upper.json + steps.c9_d.json",
		};
		expect(extractStepReferences(step)).toEqual(["a", "c9_d"]);
	});

	test("ignores self-references and collapses duplicates", () => {
		const step: RoutineStep = {
			id: "loop",
			type: "transform",
			body: "steps.loop.json ?? steps.prev.json ?? steps.prev.text",
		};
		expect(extractStepReferences(step)).toEqual(["prev"]);
	});
});

describe("findOrderingProblems", () => {
	test("reports `later` and `missing` in step order then ref order", () => {
		const steps: RoutineStep[] = [
			{ id: "a", type: "transform", body: "steps.c.json + steps.ghost.json" },
			{ id: "b", type: "transform", body: "steps.a.json" },
			{ id: "c", type: "write", path: "{{ steps.b.text }}", content: "{{ steps.nope.text }}" },
		];
		expect(findOrderingProblems({ steps })).toEqual([
			{ stepId: "a", ref: "c", kind: "later" },
			{ stepId: "a", ref: "ghost", kind: "missing" },
			{ stepId: "c", ref: "nope", kind: "missing" },
		]);
	});

	test("returns nothing for a correctly ordered spec", () => {
		const steps: RoutineStep[] = [
			{ id: "a", type: "wait", duration_secs: 1 },
			{ id: "b", type: "http", method: "GET", url: "https://x.test/{{ steps.a.json }}" },
		];
		expect(findOrderingProblems({ steps })).toEqual([]);
	});
});
