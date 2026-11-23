import { afterEach, describe, expect, test } from "bun:test";

import { type DeckEvent, onDeckEvent } from "./deck-events.ts";
import { buildEventsRouter } from "./routes-events.ts";

let off: (() => void) | null = null;

afterEach(() => {
	off?.();
	off = null;
});

function capture(): DeckEvent[] {
	const seen: DeckEvent[] = [];
	off = onDeckEvent((e) => seen.push(e));
	return seen;
}

async function post(body: string): Promise<Response> {
	return buildEventsRouter().request("/events/telegram", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

describe("POST /events/telegram", () => {
	test("valid body → 202 and one telegram/message event", async () => {
		const seen = capture();
		const res = await post(JSON.stringify({ chatId: 42, fromId: "7", text: "hello" }));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			source: "telegram",
			type: "message",
			payload: { chatId: 42, fromId: "7", text: "hello" },
		});
	});

	test.each([
		["non-JSON", "not json"],
		["null body", "null"],
		["missing text", JSON.stringify({ chatId: 1, fromId: 2 })],
		["non-string text", JSON.stringify({ chatId: 1, fromId: 2, text: 3 })],
		["bad chatId", JSON.stringify({ chatId: { id: 1 }, fromId: 2, text: "x" })],
	])("%s → 400 and no event", async (_label, body) => {
		const seen = capture();
		const res = await post(body);
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toHaveProperty("error");
		expect(seen).toHaveLength(0);
	});
});
