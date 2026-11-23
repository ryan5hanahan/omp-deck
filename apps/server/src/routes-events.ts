import { Hono } from "hono";

import { emitDeckEvent } from "./deck-events.ts";

function isId(v: unknown): v is number | string {
	return typeof v === "number" || typeof v === "string";
}

/** Inbound deck events from bridges. Telegram only; there is deliberately no generic emit route. */
export function buildEventsRouter(): Hono {
	const app = new Hono();

	app.post("/events/telegram", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body !== "object" || body === null) return c.json({ error: "body must be an object" }, 400);
		const { chatId, fromId, text } = body as Record<string, unknown>;
		if (!isId(chatId) || !isId(fromId) || typeof text !== "string") {
			return c.json({ error: "chatId, fromId (number|string) and text (string) required" }, 400);
		}
		emitDeckEvent("telegram", "message", { chatId, fromId, text });
		return c.json({ ok: true }, 202);
	});

	return app;
}
