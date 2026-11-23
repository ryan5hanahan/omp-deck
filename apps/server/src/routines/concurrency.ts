/**
 * In-memory concurrency controller for the V1 runner.
 *
 *   - skip            (default) drop new trigger when a run is in flight
 *   - queue           queue subsequent invocations, max depth 10
 *   - cancel-previous abort the in-flight run, start a new one
 *   - parallel        run concurrently, up to the spec's `max_parallel`
 *                     (unlimited when unset); fires above the cap queue
 *
 * The runner asks the controller whether to start; gets back an action
 * along with (for cancel-previous) the AbortController of the in-flight run.
 */

import type { RoutineConcurrency } from "@omp-deck/protocol";

interface ActiveRun {
	runId: string;
	abort: AbortController;
}

interface RoutineEntry {
	active: ActiveRun[];
	queued: Array<() => void>;
}

const MAX_QUEUE_DEPTH = 10;

export type StartDecision =
	| { kind: "go"; abort: AbortController }
	| { kind: "skip"; reason: "concurrency_skipped" }
	| { kind: "cancel"; toCancel: AbortController; abort: AbortController }
	| { kind: "queue"; abort: AbortController; release: Promise<void> };

export class ConcurrencyController {
	private routines = new Map<string, RoutineEntry>();

	/** Decide what to do when a trigger fires. 'go' and 'cancel' register the run as active before returning; 'queue' registers it when `release` resolves. The caller MUST call `finish()` once the run ends. */
	decide(routineId: string, runId: string, policy: RoutineConcurrency, maxParallel?: number): StartDecision {
		const entry = this.entry(routineId);
		const slots = policy === "parallel" ? (maxParallel ?? Number.POSITIVE_INFINITY) : 1;
		if (entry.active.length < slots) {
			const abort = new AbortController();
			entry.active.push({ runId, abort });
			return { kind: "go", abort };
		}
		switch (policy) {
			case "skip":
				return { kind: "skip", reason: "concurrency_skipped" };
			case "cancel-previous": {
				const prev = entry.active[entry.active.length - 1];
				if (!prev) {
					const abort = new AbortController();
					entry.active.push({ runId, abort });
					return { kind: "go", abort };
				}
				const abort = new AbortController();
				entry.active.push({ runId, abort });
				return { kind: "cancel", toCancel: prev.abort, abort };
			}
			// At the cap, parallel waits for a free slot exactly like queue.
			case "parallel":
			case "queue": {
				if (entry.queued.length >= MAX_QUEUE_DEPTH) {
					return { kind: "skip", reason: "concurrency_skipped" };
				}
				const abort = new AbortController();
				const release = new Promise<void>((resolve) => {
					entry.queued.push(() => {
						entry.active.push({ runId, abort });
						resolve();
					});
				});
				return { kind: "queue", abort, release };
			}
			default:
				return { kind: "skip", reason: "concurrency_skipped" };
		}
	}

	/** Caller invokes this after the run finishes (success or failure) to release the slot. */
	finish(routineId: string, runId: string): void {
		const entry = this.routines.get(routineId);
		if (!entry) return;
		entry.active = entry.active.filter((r) => r.runId !== runId);
		// Promote the head of the queue if any.
		const next = entry.queued.shift();
		if (next) next();
		if (entry.active.length === 0 && entry.queued.length === 0) {
			this.routines.delete(routineId);
		}
	}

	/** Snapshot for /metrics endpoints + debugging. */
	snapshot(): Array<{ routineId: string; active: number; queued: number }> {
		return Array.from(this.routines.entries()).map(([routineId, entry]) => ({
			routineId,
			active: entry.active.length,
			queued: entry.queued.length,
		}));
	}

	private entry(routineId: string): RoutineEntry {
		let entry = this.routines.get(routineId);
		if (!entry) {
			entry = { active: [], queued: [] };
			this.routines.set(routineId, entry);
		}
		return entry;
	}
}
