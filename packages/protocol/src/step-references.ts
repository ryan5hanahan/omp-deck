/**
 * Cross-step references (`steps.<id>`) in a routine spec, and the ordering
 * problems they reveal. Shared by the form builder's reorder warnings and the
 * canvas's inferred dependency edges.
 */
import type { RoutineStep } from "./index";

/** Step ids match `^[a-z][a-z0-9_]*$`, so `steps.a-b` references only `a`. */
const STEP_REFERENCE_RE = /\bsteps\.([a-z][a-z0-9_]*)/g;

export interface OrderingProblem {
	stepId: string;
	ref: string;
	/** `later`: the referenced step runs after this one. `missing`: no step has that id. */
	kind: "later" | "missing";
}

/**
 * Unique step ids referenced as `steps.<id>` in any string leaf of `step`
 * (`when`, `prompt`, `args`, `url`, `body`, …), in first-seen order. The
 * step's own id is excluded.
 */
export function extractStepReferences(step: RoutineStep): string[] {
	const refs = new Set<string>();
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			for (const match of value.matchAll(STEP_REFERENCE_RE)) {
				const id = match[1];
				if (id) refs.add(id);
			}
		} else if (value !== null && typeof value === "object") {
			for (const child of Object.values(value)) visit(child);
		}
	};
	visit(step);
	refs.delete(step.id);
	return [...refs];
}

/** Every reference to a missing or later step, in step order then reference order. */
export function findOrderingProblems(spec: { steps: RoutineStep[] }): OrderingProblem[] {
	// First occurrence wins so a duplicated id doesn't report a false `later`.
	const indexById = new Map<string, number>();
	spec.steps.forEach((step, i) => {
		if (!indexById.has(step.id)) indexById.set(step.id, i);
	});
	const problems: OrderingProblem[] = [];
	spec.steps.forEach((step, i) => {
		for (const ref of extractStepReferences(step)) {
			const at = indexById.get(ref);
			if (at === undefined) problems.push({ stepId: step.id, ref, kind: "missing" });
			else if (at > i) problems.push({ stepId: step.id, ref, kind: "later" });
		}
	});
	return problems;
}
