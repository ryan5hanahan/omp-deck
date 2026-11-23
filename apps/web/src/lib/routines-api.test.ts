import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { RoutinesApiError, routinesApi, webhookConflict } from "./routines-api";

function respondWith(body: string, status: number): void {
	spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));
}

async function failure(): Promise<RoutinesApiError> {
	const err = await routinesApi.get("r1").catch((e: unknown) => e);
	expect(err).toBeInstanceOf(RoutinesApiError);
	return err as RoutinesApiError;
}

afterEach(() => mock.restore());

test("a JSON error body becomes the message, with status and parsed body", async () => {
	const body = { error: "webhook path /hooks/x is already used by routine \"a\"", path: "/hooks/x", routine: { id: "r2", name: "a" } };
	respondWith(JSON.stringify(body), 409);
	const err = await failure();
	expect(err.message).toBe(body.error);
	expect(err.status).toBe(409);
	expect(err.body).toEqual(body);
	expect(webhookConflict(err)).toEqual(body);
});

test("a non-JSON body keeps the HTTP status line message", async () => {
	respondWith("boom", 500);
	const err = await failure();
	expect(err.message).toBe("HTTP 500 /routines/r1: boom");
	expect(err.body).toBeUndefined();
	expect(webhookConflict(err)).toBeUndefined();
});

test("JSON without an error string keeps the HTTP status line message", async () => {
	respondWith(JSON.stringify({ errors: ["x"] }), 400);
	expect((await failure()).message).toBe('HTTP 400 /routines/r1: {"errors":["x"]}');
});

test("webhookConflict ignores other 409s and non-API errors", async () => {
	respondWith(JSON.stringify({ error: "already exists" }), 409);
	expect(webhookConflict(await failure())).toBeUndefined();
	expect(webhookConflict(new Error("x"))).toBeUndefined();
});
