import { describe, expect, test } from "bun:test";

import { ConcurrencyController, type StartDecision } from "./concurrency.ts";

function releaseOf(d: StartDecision): Promise<void> {
	if (d.kind !== "queue") throw new Error(`expected a queue decision, got ${d.kind}`);
	return d.release;
}

// A queued run's `release` resolves in the same callback that moves it from
// `queued` to `active`, so the snapshot counts show whether it was released.
describe("ConcurrencyController", () => {
	test("queue serializes runs and leaves no entries behind", async () => {
		const c = new ConcurrencyController();
		expect(c.decide("r", "a", "queue").kind).toBe("go");
		const b = releaseOf(c.decide("r", "b", "queue"));
		expect(c.snapshot()).toEqual([{ routineId: "r", active: 1, queued: 1 }]);

		c.finish("r", "a");
		expect(c.snapshot()).toEqual([{ routineId: "r", active: 1, queued: 0 }]);
		await b;

		c.finish("r", "b");
		expect(c.snapshot()).toEqual([]);
	});

	test("parallel with max_parallel 2 queues the third run until a slot frees", async () => {
		const c = new ConcurrencyController();
		expect(c.decide("r", "a", "parallel", 2).kind).toBe("go");
		expect(c.decide("r", "b", "parallel", 2).kind).toBe("go");
		const third = releaseOf(c.decide("r", "c", "parallel", 2));
		expect(c.snapshot()).toEqual([{ routineId: "r", active: 2, queued: 1 }]);

		c.finish("r", "b");
		expect(c.snapshot()).toEqual([{ routineId: "r", active: 2, queued: 0 }]);
		await third;

		c.finish("r", "a");
		c.finish("r", "c");
		expect(c.snapshot()).toEqual([]);
	});

	test("the 11th waiting run is skipped once 10 are queued", () => {
		for (const [policy, cap] of [["queue", undefined], ["parallel", 1]] as const) {
			const c = new ConcurrencyController();
			expect(c.decide("r", "running", policy, cap).kind).toBe("go");
			for (let i = 0; i < 10; i++) {
				expect(c.decide("r", `q${i}`, policy, cap).kind).toBe("queue");
			}
			expect(c.decide("r", "overflow", policy, cap)).toEqual({
				kind: "skip",
				reason: "concurrency_skipped",
			});
		}
	});

	test("parallel without max_parallel is unlimited", () => {
		const c = new ConcurrencyController();
		for (let i = 0; i < 50; i++) {
			expect(c.decide("r", `p${i}`, "parallel").kind).toBe("go");
		}
		expect(c.snapshot()).toEqual([{ routineId: "r", active: 50, queued: 0 }]);
	});
});
