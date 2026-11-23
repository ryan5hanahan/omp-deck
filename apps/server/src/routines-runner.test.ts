import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { stringify } from "yaml";

import type { Routine, RoutineSpec } from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { createV1Routine, listRuns, updateV1Routine } from "./db/routines.ts";
import { emitDeckEvent, onDeckEvent, routineRunScope, type DeckEvent } from "./deck-events.ts";
import { RoutinesRunner } from "./routines-runner.ts";

let dbDir: string;
let started: RoutinesRunner | undefined;

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-runner-"));
	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
	// the deck event bus is process-global; a leaked subscription would fire into later tests
	started?.dispose();
	started = undefined;
	closeDb();
	try {
		fs.rmSync(dbDir, { recursive: true, force: true });
	} catch {
		// Windows can hold the SQLite handle briefly after close; a leaked temp dir is harmless.
	}
});

test("queue concurrency starts the second run only after the first finishes", async () => {
	const waitSecs = 0.2;
	const spec: RoutineSpec = {
		name: "queued",
		trigger: [{ manual: {} }],
		concurrency: "queue",
		steps: [{ id: "pause", type: "wait", duration_secs: waitSecs }],
	};
	const routine = createV1Routine({ name: spec.name, specYaml: stringify(spec), spec });
	const runner = new RoutinesRunner();

	const startedMs = Date.now();
	await Promise.all([runner.fire(routine.id), runner.fire(routine.id)]);
	const elapsedMs = Date.now() - startedMs;

	// Serialized runs take two waits; overlapping runs finish in about one.
	expect(elapsedMs).toBeGreaterThanOrEqual(2 * waitSecs * 1000 - 20);
	expect(listRuns(routine.id).map((r) => r.abortReason ?? null)).toEqual([null, null]);
	expect(runner.concurrency.snapshot()).toEqual([]);
});

function startRunner(): RoutinesRunner {
	started = new RoutinesRunner();
	started.start();
	return started;
}

function eventRoutine(name: string, trigger: RoutineSpec["trigger"]): Routine {
	const spec: RoutineSpec = { name, trigger, steps: [{ id: "noop", type: "transform", body: "1" }] };
	return createV1Routine({ name, specYaml: stringify(spec), spec });
}

/** Resolves with the routine_finished event of the routine's next run. */
function nextFinish(routineId: string): Promise<DeckEvent> {
	const { promise, resolve } = Promise.withResolvers<DeckEvent>();
	const off = onDeckEvent((event) => {
		if (event.source === "routine_finished" && event.payload.routineId === routineId) {
			off();
			resolve(event);
		}
	});
	return promise;
}

test("event trigger fires on a matching source and type only", async () => {
	const match = eventRoutine("match", [{ event: { source: "deck_inbox", type: "created" } }]);
	const otherType = eventRoutine("other-type", [{ event: { source: "deck_inbox", type: "updated" } }]);
	const otherSource = eventRoutine("other-source", [{ event: { source: "deck_task" } }]);
	const runner = startRunner();
	const fired: Array<[string, string | undefined, Record<string, unknown> | undefined]> = [];
	const fire = runner.fire.bind(runner);
	runner.fire = (id, trigger, payload) => {
		fired.push([id, trigger, payload]);
		return fire(id, trigger, payload);
	};

	const done = nextFinish(match.id);
	emitDeckEvent("deck_inbox", "created", { item: { id: "i1" } });
	const finished = await done;

	expect(finished.type).toBe("success");
	expect(fired).toEqual([[match.id, "event", { source: "deck_inbox", type: "created", item: { id: "i1" } }]]);
	expect(listRuns(match.id).map((r) => r.trigger)).toEqual(["event"]);
	expect(listRuns(otherType.id)).toEqual([]);
	expect(listRuns(otherSource.id)).toEqual([]);
});

test("event filter: truthy fires, falsy and throwing filters do not", async () => {
	const trigger = (filter: string): RoutineSpec["trigger"] => [{ event: { source: "deck_task", type: "moved", filter } }];
	const yes = eventRoutine("yes", trigger(`event.toStateId === "s_done"`));
	const no = eventRoutine("no", trigger(`event.toStateId === "s_todo"`));
	const boom = eventRoutine("boom", trigger("event.missing.deeper"));
	startRunner();

	// all three filters are evaluated before `yes` finishes its run
	const done = nextFinish(yes.id);
	emitDeckEvent("deck_task", "moved", { task: { id: "t1" }, fromStateId: "s_todo", toStateId: "s_done" });
	await done;

	expect(listRuns(yes.id)).toHaveLength(1);
	expect(listRuns(no.id)).toEqual([]);
	expect(listRuns(boom.id)).toEqual([]);
});

test("a routine is not fired by its own routine_finished event", async () => {
	const self = eventRoutine("self", [
		{ manual: {} },
		{ event: { source: "routine_finished", filter: `event.routineName === "self"` } },
	]);
	const watcher = eventRoutine("watcher", [{ event: { source: "routine_finished", filter: `event.routineName === "self"` } }]);
	const runner = startRunner();

	const watched = nextFinish(watcher.id);
	await runner.fire(self.id);
	const finished = await watched;

	expect(listRuns(self.id)).toHaveLength(1);
	expect(listRuns(watcher.id).map((r) => r.trigger)).toEqual(["event"]);
	expect(finished.origin).toEqual({ routineId: watcher.id, chainDepth: 1 });
});

test("events at chain depth 3 are dropped, depth 2 fires", async () => {
	const deep = eventRoutine("deep", [{ event: { source: "telegram", type: "message" } }]);
	startRunner();
	const message = { chatId: 1, fromId: 2, text: "hi" };

	// an unfiltered match starts its run row synchronously, so an empty list means dropped
	routineRunScope.run({ routineId: "r_upstream", chainDepth: 3 }, () => emitDeckEvent("telegram", "message", message));
	expect(listRuns(deep.id)).toEqual([]);

	const done = nextFinish(deep.id);
	routineRunScope.run({ routineId: "r_upstream", chainDepth: 2 }, () => emitDeckEvent("telegram", "message", message));
	const finished = await done;

	expect(listRuns(deep.id)).toHaveLength(1);
	expect(finished.origin).toEqual({ routineId: deep.id, chainDepth: 3 });
});

test("rescheduling with a changed event trigger rebuilds the index", async () => {
	const routine = eventRoutine("moving", [{ event: { source: "deck_inbox" } }]);
	const runner = startRunner();

	const first = nextFinish(routine.id);
	emitDeckEvent("deck_inbox", "created", { item: { id: "i1" } });
	await first;

	const spec: RoutineSpec = {
		name: "moving",
		trigger: [{ event: { source: "deck_task" } }],
		steps: [{ id: "noop", type: "transform", body: "1" }],
	};
	runner.schedule(updateV1Routine(routine.id, { specYaml: stringify(spec), spec })!);

	const second = nextFinish(routine.id);
	emitDeckEvent("deck_inbox", "created", { item: { id: "i2" } });
	emitDeckEvent("deck_task", "moved", { task: { id: "t1" }, fromStateId: "s_a", toStateId: "s_b" });
	await second;

	expect(listRuns(routine.id)).toHaveLength(2);
});
