import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./db/index.ts";
import { createInbox } from "./db/inbox.ts";
import { createTask, moveTask } from "./db/tasks.ts";
import { type DeckEvent, emitDeckEvent, onDeckEvent, routineRunScope } from "./deck-events.ts";

const unsubs: (() => void)[] = [];
let dbDir: string | null = null;

afterEach(() => {
	for (const off of unsubs.splice(0)) off();
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// leaking a temp dir is fine, failing the suite is not
		}
		dbDir = null;
	}
});

function capture(): DeckEvent[] {
	const seen: DeckEvent[] = [];
	unsubs.push(onDeckEvent((e) => seen.push(e)));
	return seen;
}

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-events-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("deck event bus", () => {
	test("listener receives the event without origin outside a routine run", () => {
		const seen = capture();
		emitDeckEvent("telegram", "message", { text: "hi" });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ source: "telegram", type: "message", payload: { text: "hi" } });
		expect(seen[0]!.origin).toBeUndefined();
	});

	test("origin is stamped from routineRunScope", async () => {
		const seen = capture();
		await routineRunScope.run({ routineId: "r1", chainDepth: 2 }, async () => {
			await Promise.resolve();
			emitDeckEvent("deck_inbox", "created", {});
		});
		emitDeckEvent("deck_inbox", "created", {});
		expect(seen[0]!.origin).toEqual({ routineId: "r1", chainDepth: 2 });
		expect(seen[1]!.origin).toBeUndefined();
	});

	test("a throwing listener neither stops others nor throws from emit", () => {
		unsubs.push(
			onDeckEvent(() => {
				throw new Error("boom");
			}),
		);
		const seen = capture();
		expect(() => emitDeckEvent("telegram", "message", {})).not.toThrow();
		expect(seen).toHaveLength(1);
	});

	test("unsubscribe stops delivery", () => {
		const seen: DeckEvent[] = [];
		const off = onDeckEvent((e) => seen.push(e));
		off();
		emitDeckEvent("telegram", "message", {});
		expect(seen).toHaveLength(0);
	});
});

describe("db emit points", () => {
	test("createInbox emits deck_inbox/created with the returned item", () => {
		bootDb();
		const seen = capture();
		const item = createInbox({ kind: "idea", title: "x" });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ source: "deck_inbox", type: "created", payload: { item } });
	});

	test("cross-column moveTask emits deck_task/moved with from/to", () => {
		bootDb();
		const t = createTask({ title: "card", stateId: "s_backlog" });
		const seen = capture();
		const moved = moveTask(t.id, "s_active", 0);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			source: "deck_task",
			type: "moved",
			payload: { task: moved, fromStateId: "s_backlog", toStateId: "s_active" },
		});
	});

	test("same-column moveTask emits nothing", () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		createTask({ title: "b", stateId: "s_backlog" });
		const seen = capture();
		moveTask(a.id, "s_backlog", 1);
		expect(seen).toHaveLength(0);
	});
});
