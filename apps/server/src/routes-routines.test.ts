import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { parse as parseYaml, stringify } from "yaml";

import type { Routine, RoutineSpec } from "@omp-deck/protocol";

import { closeDb, openDb } from "./db/index.ts";
import { getWebhookSecretByPath } from "./db/routine-step-runs.ts";
import { createV1Routine, getRoutine, listRoutines } from "./db/routines.ts";
import { buildHooksRouter } from "./routes-hooks.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
import { RoutinesRunner } from "./routines-runner.ts";

let dbDir: string;
let runner: RoutinesRunner;
let app: Hono;

beforeEach(() => {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-routines-"));
	openDb({ path: path.join(dbDir, "deck.db") });
	runner = new RoutinesRunner();
	// Accepted hooks must not start real runs that outlive the temp DB.
	spyOn(runner, "fire").mockResolvedValue(undefined);
	// Mounted at "/" as in routes.ts: index.ts strips `/api` before the router, and hooks match on the stripped path.
	app = new Hono();
	app.route("/", buildRoutinesRouter(runner));
	app.route("/", buildHooksRouter(runner));
});

afterEach(() => {
	runner.dispose();
	closeDb();
	try {
		fs.rmSync(dbDir, { recursive: true, force: true });
	} catch {
		// Windows can hold the SQLite handle briefly after close; a leaked temp dir is harmless.
	}
});

function specFor(name: string, hookPath?: string): RoutineSpec {
	return {
		name,
		trigger: hookPath ? [{ manual: {} }, { webhook: { path: hookPath, secret_env: "HOOK_SECRET" } }] : [{ manual: {} }],
		steps: [{ id: "pause", type: "wait", duration_secs: 0.1 }],
	};
}

function send(method: string, url: string, body?: unknown): Promise<Response> {
	return Promise.resolve(
		app.request(url, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

async function create(spec: RoutineSpec): Promise<Routine> {
	const res = await send("POST", "/routines", { specYaml: stringify(spec) });
	expect(res.status).toBe(201);
	const routine = (await res.json()) as Routine;
	return routine;
}

async function rotate(id: string): Promise<string> {
	const res = await send("POST", `/routines/${id}/webhook-secret/rotate`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { secret: string };
	return body.secret;
}

function callHook(hookPath: string, secret: string): Promise<Response> {
	return Promise.resolve(app.request(hookPath, { method: "POST", headers: { "x-routine-signature": secret }, body: "ping" }));
}

test("saving the same spec again keeps a rotated secret valid", async () => {
	const spec = specFor("keeps-secret", "/hooks/keeps-secret");
	const routine = await create(spec);
	const secret = await rotate(routine.id);

	for (let i = 0; i < 2; i++) {
		expect((await send("PATCH", `/routines/${routine.id}`, { specYaml: stringify(spec) })).status).toBe(200);
	}

	expect((await callHook("/hooks/keeps-secret", secret)).status).toBe(202);
	expect(runner.fire).toHaveBeenCalledWith(routine.id, "webhook", { body: "ping" });
});

test("a path conflict on create or PATCH returns 409 and persists nothing", async () => {
	const owner = await create(specFor("owner", "/hooks/shared"));
	const conflictBody = {
		error: 'webhook path /hooks/shared is already used by routine "owner"',
		path: "/hooks/shared",
		routine: { id: owner.id, name: "owner" },
	};

	const created = await send("POST", "/routines", { specYaml: stringify(specFor("intruder", "/hooks/shared")) });
	expect(created.status).toBe(409);
	expect(await created.json()).toEqual(conflictBody);
	expect(listRoutines().map((r) => r.id)).toEqual([owner.id]);

	const other = await create(specFor("other", "/hooks/other"));
	const patched = await send("PATCH", `/routines/${other.id}`, { specYaml: stringify(specFor("other", "/hooks/shared")) });
	expect(patched.status).toBe(409);
	expect(await patched.json()).toEqual(conflictBody);
	expect(getRoutine(other.id)?.specYaml).toBe(other.specYaml);
	expect(getWebhookSecretByPath("/hooks/other")?.routine_id).toBe(other.id);
	expect(getWebhookSecretByPath("/hooks/shared")?.routine_id).toBe(owner.id);
});

test("removing the webhook trigger unregisters its path", async () => {
	const routine = await create(specFor("unhooked", "/hooks/unhooked"));
	const secret = await rotate(routine.id);

	expect((await send("PATCH", `/routines/${routine.id}`, { specYaml: stringify(specFor("unhooked")) })).status).toBe(200);

	expect((await callHook("/hooks/unhooked", secret)).status).toBe(404);
	// The path is free again for another routine.
	await create(specFor("reuser", "/hooks/unhooked"));
});

test("deleting a routine unregisters its webhook", async () => {
	const routine = await create(specFor("deleted", "/hooks/deleted"));
	const secret = await rotate(routine.id);

	expect((await send("DELETE", `/routines/${routine.id}`)).status).toBe(200);

	expect((await callHook("/hooks/deleted", secret)).status).toBe(404);
});

test("rotate on a path owned by another routine returns 409", async () => {
	const owner = await create(specFor("owner", "/hooks/taken"));
	// A pre-F9 routine whose colliding webhook was skipped at save time.
	const spec = specFor("legacy", "/hooks/taken");
	const legacy = createV1Routine({ name: spec.name, specYaml: stringify(spec), spec });

	const res = await send("POST", `/routines/${legacy.id}/webhook-secret/rotate`);
	expect(res.status).toBe(409);
	expect(await res.json()).toMatchObject({ path: "/hooks/taken", routine: { id: owner.id, name: "owner" } });
	expect(getWebhookSecretByPath("/hooks/taken")?.routine_id).toBe(owner.id);
});

test("installing the same template repeatedly suffixes the webhook path", async () => {
	const hookPaths: string[] = [];
	for (let i = 0; i < 3; i++) {
		const res = await send("POST", "/routine-templates/daily-briefing");
		expect(res.status).toBe(201);
		const routine = (await res.json()) as Routine;
		const spec = parseYaml(routine.specYaml ?? "") as RoutineSpec;
		const hookPath = spec.trigger.flatMap((t) => ("webhook" in t ? [t.webhook.path] : []))[0] ?? "";
		expect(getWebhookSecretByPath(hookPath)?.routine_id).toBe(routine.id);
		hookPaths.push(hookPath);
	}
	expect(hookPaths).toEqual([
		"/hooks/daily-briefing-manual",
		"/hooks/daily-briefing-manual-2",
		"/hooks/daily-briefing-manual-3",
	]);
});
