/**
 * Top-level routines runner. Dispatches by `routine.specVersion`:
 *   - V0 (specVersion=0): legacy single-action shell-out (bash/script/prompt)
 *   - V1 (specVersion=1): multi-step pipeline via runV1Pipeline()
 *
 * Also owns the Cron scheduler. For V0 routines, schedule from `routine.cron`.
 * For V1 routines, parse `spec.trigger` and schedule a Cron per cron-trigger
 * entry. Event triggers are indexed by source and fired from deck events
 * (deck-events.ts). Webhook and manual triggers sit passive and are invoked
 * from routes-hooks.ts / routes-routines.ts.
 */

import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import * as path from "node:path";

import type { Routine, RoutineActionKind, RoutineSpec, RoutineTrigger } from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { emitDeckEvent, onDeckEvent, routineRunScope, type DeckEvent } from "./deck-events.ts";
import {
	finishRun,
	listRoutines,
	setRoutineSchedule,
	startRun,
} from "./db/routines.ts";
import { ConcurrencyController } from "./routines/concurrency.ts";
import { runV1Pipeline } from "./routines/v1-runner.ts";
import { evaluate } from "./routines/sandbox.ts";
import { finalizeRun, insertAbortedRun } from "./db/routine-step-runs.ts";
import { loadConfig } from "./config.ts";

const log = logger("routines-runner");

const MAX_EXCERPT = 8 * 1024;
const MAX_RUNTIME_MS = 10 * 60_000;
/** Loop guard: events emitted by a run this deep in an event chain fire nothing. */
const MAX_CHAIN_DEPTH = 3;

interface ScheduledCron {
	cron: Cron;
	routineId: string;
}

interface EventTriggerEntry {
	routineId: string;
	type?: string;
	filter?: string;
}

export class RoutinesRunner {
	private crons = new Map<string, ScheduledCron[]>();
	/** Event triggers of enabled routines, keyed by source. */
	private eventTriggers = new Map<string, EventTriggerEntry[]>();
	private offDeckEvent: (() => void) | null = null;
	private disposed = false;
	readonly concurrency = new ConcurrencyController();

	start(): void {
		this.offDeckEvent ??= onDeckEvent((event) => this.dispatchEvent(event));
		const routines = listRoutines();
		for (const r of routines) {
			if (r.enabled) this.schedule(r);
		}
		log.info(`scheduled ${routines.filter((r) => r.enabled).length} routine(s)`);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.offDeckEvent?.();
		this.offDeckEvent = null;
		this.eventTriggers.clear();
		for (const entries of this.crons.values()) {
			for (const entry of entries) {
				try {
					entry.cron.stop();
				} catch (err) {
					log.warn(`stop failed for routine ${entry.routineId}`, err);
				}
			}
		}
		this.crons.clear();
	}

	schedule(r: Routine): void {
		this.unschedule(r.id);
		if (!r.enabled) return;

		const triggers = v1Triggers(r);
		for (const t of triggers) {
			if (!("event" in t) || typeof t.event?.source !== "string") continue;
			const list = this.eventTriggers.get(t.event.source) ?? [];
			list.push({ routineId: r.id, type: t.event.type, filter: t.event.filter });
			this.eventTriggers.set(t.event.source, list);
		}

		const cronExprs = collectCronExpressions(r, triggers);
		if (cronExprs.length === 0) {
			setRoutineSchedule(r.id, { nextRunAt: null });
			return;
		}

		const scheduled: ScheduledCron[] = [];
		let earliestNext: Date | null = null;
		for (const expr of cronExprs) {
			try {
				const cron = new Cron(
					expr,
					{
						catch: true,
						protect: true,
						...(r.timezone ? { timezone: r.timezone } : {}),
					},
					() => {
						void this.fire(r.id, "cron").catch((err) => log.warn(`cron fire failed`, err));
					},
				);
				scheduled.push({ cron, routineId: r.id });
				const next = cron.nextRun();
				if (next && (!earliestNext || next < earliestNext)) earliestNext = next;
			} catch (err) {
				log.warn(`failed to schedule cron '${expr}' for ${r.id}`, err);
			}
		}
		this.crons.set(r.id, scheduled);
		setRoutineSchedule(r.id, { nextRunAt: earliestNext?.toISOString() ?? null });
	}

	unschedule(routineId: string): void {
		for (const [source, list] of this.eventTriggers) {
			const kept = list.filter((t) => t.routineId !== routineId);
			if (kept.length > 0) this.eventTriggers.set(source, kept);
			else this.eventTriggers.delete(source);
		}
		const existing = this.crons.get(routineId);
		if (!existing) return;
		for (const entry of existing) {
			try {
				entry.cron.stop();
			} catch (err) {
				log.warn(`stop failed for ${routineId}`, err);
			}
		}
		this.crons.delete(routineId);
	}

	/** Deck event listener. Stays sync; filter evaluation and firing run as caught promises. */
	private dispatchEvent(event: DeckEvent): void {
		for (const t of this.eventTriggers.get(event.source) ?? []) {
			if (t.type && t.type !== event.type) continue;
			if (event.origin?.routineId === t.routineId) {
				log.warn(`dropped ${event.source}/${event.type} for routine ${t.routineId}: emitted by its own run`);
				continue;
			}
			if (event.origin && event.origin.chainDepth >= MAX_CHAIN_DEPTH) {
				log.warn(
					`dropped ${event.source}/${event.type} for routine ${t.routineId}: event chain depth ${event.origin.chainDepth}`,
				);
				continue;
			}
			void this.fireOnEvent(t, event).catch((err) => log.warn(`event fire failed for routine ${t.routineId}`, err));
		}
	}

	private async fireOnEvent(t: EventTriggerEntry, event: DeckEvent): Promise<void> {
		const payload = { source: event.source, type: event.type, ...event.payload };
		if (t.filter) {
			let matched: unknown;
			try {
				matched = await evaluate(t.filter, { event: payload }, { timeoutMs: 100 });
			} catch (err) {
				log.warn(`event filter for routine ${t.routineId} threw; treating as no match`, err);
				return;
			}
			if (!matched) return;
		}
		await this.fire(t.routineId, "event", payload);
	}

	/** Fire a routine. Branches on specVersion. */
	async fire(
		routineId: string,
		trigger: "cron" | "manual" | "webhook" | "event" = "manual",
		payload: Record<string, unknown> = {},
	): Promise<void> {
		const all = listRoutines();
		const routine = all.find((r) => r.id === routineId);
		if (!routine) {
			log.warn(`fire: routine ${routineId} not found`);
			return;
		}
		if (!routine.enabled && trigger === "cron") return;

		if (routine.specVersion === 1 && routine.specYaml) {
			await this.fireV1(routine, trigger, payload);
		} else {
			await this.fireV0(routine, trigger === "cron" || trigger === "manual" ? trigger : "manual");
		}

		const reschedule = this.crons.get(routineId)?.[0];
		const now = new Date().toISOString();
		setRoutineSchedule(routineId, {
			lastRunAt: now,
			nextRunAt: reschedule?.cron.nextRun()?.toISOString() ?? null,
		});
	}

	private async fireV0(routine: Routine, trigger: "cron" | "manual"): Promise<void> {
		if (!routine.actionKind || routine.actionBody === undefined) {
			log.warn(`V0 routine ${routine.id} missing action_kind/action_body`);
			return;
		}
		const run = startRun(routine.id, trigger);
		const cwd =
			routine.actionCwd && routine.actionCwd.trim()
				? routine.actionCwd
				: process.cwd();
		log.info(`firing V0 routine ${routine.name} (${routine.actionKind})`);
		try {
			const result = await runV0Action(routine.actionKind, routine.actionBody, cwd);
			finishRun(run.id, result);
		} catch (err) {
			finishRun(run.id, { error: String(err) });
		}
	}

	private async fireV1(
		routine: Routine,
		trigger: "cron" | "manual" | "webhook" | "event",
		payload: Record<string, unknown>,
	): Promise<void> {
		const parent = routineRunScope.getStore();
		const scope = { routineId: routine.id, chainDepth: parent ? parent.chainDepth + 1 : 0 };
		let spec: RoutineSpec;
		try {
			spec = parseYaml(routine.specYaml!) as RoutineSpec;
		} catch (err) {
			log.warn(`V1 routine ${routine.id} has malformed spec_yaml`, err);
			insertAbortedRun({
				routineId: routine.id,
				triggerKind: trigger,
				triggerPayload: JSON.stringify(payload),
				abortReason: "failure",
				error: `spec_yaml parse failure: ${String(err)}`,
			});
			return;
		}

		const run = startRun(routine.id, trigger);
		const decision = this.concurrency.decide(routine.id, run.id, routine.concurrency, spec.max_parallel);
		if (decision.kind === "skip") {
			finalizeRun(run.id, {
				endedAt: new Date().toISOString(),
				abortedAt: new Date().toISOString(),
				abortReason: "concurrency_skipped",
				error: "skipped: another run is in flight",
			});
			return;
		}
		if (decision.kind === "cancel") {
			decision.toCancel.abort();
		}
		if (decision.kind === "queue") {
			await decision.release;
		}

		log.info(`firing V1 routine ${routine.name} (${spec.steps.length} steps, trigger=${trigger})`);
		const config = loadConfig();
		// Events emitted by the run (and its routine_finished) carry this scope as their origin.
		await routineRunScope.run(scope, async () => {
			const result = await runV1Pipeline({
				routine,
				spec,
				runId: run.id,
				triggerKind: trigger,
				triggerPayload: payload,
				abortSignal: decision.abort.signal,
				defaultCwd: config.defaultCwd,
				// Sandbox `agent` steps in <deck-data-dir>/routine-runs/<runId>/
				// so the embedded coding agent can't reach into the user's home
				// for "context" it wasn't asked about.
				agentSandboxRoot: path.join(path.dirname(config.dbPath), "routine-runs"),
			})
				.catch((err: unknown) => {
					log.error(`V1 pipeline threw for ${routine.id}`, err);
					return null;
				})
				.finally(() => this.concurrency.finish(routine.id, run.id));
			if (!result) return;
			// Emitted only after the slot is released: a listener may start this routine
			// again and must not be skipped (or queued) behind the run that just ended.
			emitDeckEvent("routine_finished", result.status, {
				routineId: routine.id,
				routineName: routine.name,
				runId: run.id,
				status: result.status,
				...(result.abortReason ? { abortReason: result.abortReason } : {}),
			});
		});
	}
}

/** Triggers of a V1 routine's spec; [] for V0 or unparseable specs. */
function v1Triggers(routine: Routine): RoutineTrigger[] {
	if (routine.specVersion !== 1 || !routine.specYaml) return [];
	try {
		return (parseYaml(routine.specYaml) as RoutineSpec).trigger ?? [];
	} catch {
		return [];
	}
}

/** Pull every cron expression out of a routine: V0 `routine.cron`, or the V1 cron triggers. */
function collectCronExpressions(routine: Routine, triggers: RoutineTrigger[]): string[] {
	if (routine.specVersion === 1 && routine.specYaml) {
		return triggers.flatMap((t) => ("cron" in t && typeof t.cron === "string" ? [t.cron] : []));
	}
	return routine.cron ? [routine.cron] : [];
}

// ─── V0 single-action executor (preserved for backward compat) ────────────

async function runV0Action(
	kind: RoutineActionKind,
	body: string,
	cwd: string,
): Promise<{ exitCode?: number; stdoutExcerpt: string; stderrExcerpt: string; error?: string }> {
	const cmd = buildV0Cmd(kind, body);
	if (!cmd) {
		return { error: `unsupported action kind: ${kind}`, stdoutExcerpt: "", stderrExcerpt: "" };
	}
	const proc = Bun.spawn(cmd, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const timer = setTimeout(() => {
		try { proc.kill(); } catch { /* already gone */ }
	}, MAX_RUNTIME_MS);
	timer.unref?.();
	const [stdout, stderr, exitCode] = await Promise.all([
		readClipped(proc.stdout),
		readClipped(proc.stderr),
		proc.exited,
	]);
	clearTimeout(timer);
	return {
		exitCode: typeof exitCode === "number" ? exitCode : undefined,
		stdoutExcerpt: stdout,
		stderrExcerpt: stderr,
	};
}

function buildV0Cmd(kind: RoutineActionKind, body: string): string[] | null {
	const isWin = process.platform === "win32";
	switch (kind) {
		case "bash":
			return isWin ? ["cmd", "/c", body] : ["bash", "-lc", body];
		case "script": {
			const parts = body.trim().split(/\s+/);
			if (parts.length === 0 || !parts[0]) return null;
			return parts as string[];
		}
		case "prompt":
			return ["omp", "-p", body];
		default:
			return null;
	}
}

async function readClipped(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let acc = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		acc += decoder.decode(value, { stream: true });
		if (acc.length > MAX_EXCERPT) {
			acc = acc.slice(0, MAX_EXCERPT) + "\n…(truncated)";
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			break;
		}
	}
	acc += decoder.decode();
	return acc;
}
