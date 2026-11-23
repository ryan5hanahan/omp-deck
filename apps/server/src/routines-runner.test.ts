import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { stringify } from "yaml";

import type { RoutineSpec } from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { createV1Routine, listRuns } from "./db/routines.ts";
import { RoutinesRunner } from "./routines-runner.ts";

let dbDir: string;

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-runner-"));
	openDb({ path: path.join(dbDir, "deck.db") });
});

afterEach(() => {
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
