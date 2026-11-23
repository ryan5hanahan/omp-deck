/**
 * Trigger picker. Edits a routine's `trigger:` array (cron, webhook, manual, event).
 */
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import type { RoutineTrigger } from "@omp-deck/protocol";

import { newWebhookPath } from "@/lib/webhook-path";

import { Field, NumInput as _NumInput, Select, TextInput } from "./form-primitives";

interface Props {
	triggers: RoutineTrigger[];
	onChange: (next: RoutineTrigger[]) => void;
	/** Save error for the webhook trigger (path owned by another routine). */
	webhookError?: string;
}

const KINDS = ["cron", "webhook", "manual", "event"] as const;
type TriggerKind = (typeof KINDS)[number];
type EventSpec = Extract<RoutineTrigger, { event: unknown }>["event"];

/** Sources the server emits (`apps/server/src/deck-events.ts`): types, payload fields, a filter example. */
const EVENT_SOURCES: Record<string, { types: readonly string[]; fields: string; filter: string }> = {
	deck_inbox: { types: ["created"], fields: "item", filter: 'event.item.kind === "idea"' },
	deck_task: { types: ["moved"], fields: "task, fromStateId, toStateId", filter: 'event.toStateId === "s_done"' },
	routine_finished: {
		types: ["success", "failed", "aborted"],
		fields: "routineId, routineName, runId, status, abortReason",
		filter: 'event.routineName === "daily-briefing"',
	},
	telegram: { types: ["message"], fields: "chatId, fromId, text", filter: 'event.text.startsWith("/triage")' },
};

const PRESET_CRONS: ReadonlyArray<{ label: string; expr: string }> = [
	{ label: "every minute", expr: "* * * * *" },
	{ label: "hourly :00", expr: "0 * * * *" },
	{ label: "daily 7am", expr: "0 7 * * *" },
	{ label: "weekdays 9am", expr: "0 9 * * 1-5" },
	{ label: "weekly Sun 9am", expr: "0 9 * * 0" },
];

export function TriggerPicker({ triggers, onChange, webhookError }: Props) {
	function add(kind: TriggerKind): void {
		const next = triggers.slice();
		if (kind === "cron") next.push({ cron: "0 9 * * *" });
		else if (kind === "webhook") next.push({ webhook: { path: newWebhookPath(), secret_env: "ROUTINE_WEBHOOK_SECRET" } });
		else if (kind === "event") next.push({ event: { source: "deck_task", type: "moved" } });
		else next.push({ manual: {} });
		onChange(next);
	}
	function remove(idx: number): void {
		const next = triggers.slice();
		next.splice(idx, 1);
		onChange(next);
	}
	function replace(idx: number, t: RoutineTrigger): void {
		const next = triggers.slice();
		next[idx] = t;
		onChange(next);
	}

	return (
		<div className="space-y-2">
			{triggers.length === 0 ? (
				<div className="rounded border border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn">
					This routine has no triggers. Add at least one below.
				</div>
			) : null}
			{triggers.map((t, idx) => (
				<TriggerCard
					key={idx}
					trigger={t}
					webhookError={webhookError}
					onChange={(v) => replace(idx, v)}
					onRemove={() => remove(idx)}
				/>
			))}
			<div className="flex flex-wrap gap-1.5">
				{KINDS.map((kind) => {
					const blocked = kind === "webhook" && triggers.some((t) => "webhook" in t);
					return (
						<button
							key={kind}
							type="button"
							onClick={() => add(kind)}
							disabled={blocked}
							title={blocked ? "A routine can have at most one webhook trigger" : undefined}
							className="btn-ghost h-7 px-2 text-2xs disabled:opacity-40"
						>
							<Plus className="h-3 w-3" />
							{kind}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function TriggerCard({
	trigger,
	webhookError,
	onChange,
	onRemove,
}: {
	trigger: RoutineTrigger;
	webhookError?: string;
	onChange: (next: RoutineTrigger) => void;
	onRemove: () => void;
}) {
	const kind: TriggerKind = (() => {
		if ("cron" in trigger) return "cron";
		if ("webhook" in trigger) return "webhook";
		if ("manual" in trigger) return "manual";
		return "event";
	})();
	return (
		<div className="rounded border border-line bg-paper-2/40 p-2">
			<div className="flex items-center justify-between">
				<div className="meta">{kind}</div>
				<button type="button" onClick={onRemove} className="btn-ghost h-6 w-6 p-0 text-ink-4 hover:text-danger">
					<Trash2 className="h-3 w-3" />
				</button>
			</div>
			<div className="mt-1.5">
				{"cron" in trigger ? <CronEditor expr={trigger.cron} onChange={(c) => onChange({ cron: c })} /> : null}
				{"webhook" in trigger ? (
					<WebhookEditor
						path={trigger.webhook.path}
						secretEnv={trigger.webhook.secret_env}
						error={webhookError}
						onChange={(path, secret_env) => onChange({ webhook: { path, secret_env } })}
					/>
				) : null}
				{"manual" in trigger ? (
					<div className="font-mono text-2xs text-ink-3">
						Fired via the Run-now button or <code>POST /api/routines/:id/run</code>.
					</div>
				) : null}
				{"event" in trigger ? <EventEditor event={trigger.event} onChange={(event) => onChange({ event })} /> : null}
			</div>
		</div>
	);
}

function EventEditor({ event, onChange }: { event: EventSpec; onChange: (next: EventSpec) => void }) {
	const known = EVENT_SOURCES[event.source];
	const sources = withCurrent(Object.keys(EVENT_SOURCES), event.source);
	const types = withCurrent(known?.types ?? [], event.type);
	// The spec omits empty optional keys; "" in the type select means any type.
	function set(next: EventSpec): void {
		onChange({
			source: next.source,
			...(next.type ? { type: next.type } : {}),
			...(next.filter?.trim() ? { filter: next.filter } : {}),
		});
	}
	return (
		<div className="space-y-1.5">
			<div className="grid grid-cols-2 gap-1.5">
				<Field label="source">
					<Select
						value={event.source}
						onChange={(source) => set({ source, filter: event.filter })}
						options={sources.map((s) => ({ value: s, label: s }))}
					/>
				</Field>
				<Field label="type">
					<Select
						value={event.type ?? ""}
						onChange={(type) => set({ ...event, type })}
						options={[{ value: "", label: "any" }, ...types.map((t) => ({ value: t, label: t }))]}
					/>
				</Field>
			</div>
			<Field label="filter (optional JS expression over event)">
				<TextInput
					value={event.filter ?? ""}
					onChange={(filter) => set({ ...event, filter })}
					placeholder={known?.filter}
					mono
				/>
			</Field>
			<div className="font-mono text-2xs text-ink-3">
				{known ? (
					<>
						<code>event</code> has <code>source, type, {known.fields}</code>.{" "}
					</>
				) : null}
				A routine never fires on its own events; chains stop at depth 3.
			</div>
		</div>
	);
}

/** Keeps a value set in YAML that the picker doesn't list, so the select never rewrites it. */
function withCurrent(list: readonly string[], current: string | undefined): readonly string[] {
	return current && !list.includes(current) ? [...list, current] : list;
}

function CronEditor({ expr, onChange }: { expr: string; onChange: (v: string) => void }) {
	const [preview, setPreview] = useState<
		| { valid: true; nextRuns: string[] }
		| { valid: false; error: string }
		| undefined
	>(undefined);
	useEffect(() => {
		if (!expr.trim()) {
			setPreview(undefined);
			return;
		}
		const t = setTimeout(async () => {
			try {
				const r = await fetch(`/api/cron/validate?expr=${encodeURIComponent(expr)}`);
				setPreview(
					(await r.json()) as
						| { valid: true; nextRuns: string[] }
						| { valid: false; error: string },
				);
			} catch {
				/* keep previous */
			}
		}, 250);
		return () => clearTimeout(t);
	}, [expr]);
	return (
		<div className="space-y-1.5">
			<TextInput value={expr} onChange={onChange} placeholder="0 9 * * *" mono />
			<div className="flex flex-wrap gap-1">
				{PRESET_CRONS.map((p) => (
					<button
						key={p.expr}
						type="button"
						onClick={() => onChange(p.expr)}
						className="rounded border border-line bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-3 hover:bg-paper-3 hover:text-ink"
					>
						{p.label}
					</button>
				))}
			</div>
			{preview ? (
				preview.valid ? (
					<div className="rounded border border-success/30 bg-success/5 px-2 py-1">
						<div className="meta mb-0.5 text-success">next {preview.nextRuns.length}</div>
						<ul className="space-y-0.5 font-mono text-2xs text-ink-2">
							{preview.nextRuns.slice(0, 3).map((iso) => (
								<li key={iso}>{new Date(iso).toLocaleString()}</li>
							))}
						</ul>
					</div>
				) : (
					<div className="rounded border border-danger/40 bg-danger/5 px-2 py-1 font-mono text-2xs text-danger">
						{preview.error}
					</div>
				)
			) : null}
		</div>
	);
}

function WebhookEditor({
	path,
	secretEnv,
	error,
	onChange,
}: {
	path: string;
	secretEnv: string;
	error?: string;
	onChange: (path: string, secretEnv: string) => void;
}) {
	return (
		<div className="space-y-1.5">
			<Field label="path" hint={error} tone="danger">
				<TextInput value={path} onChange={(v) => onChange(v, secretEnv)} placeholder="/hooks/my-routine" mono />
			</Field>
			<Field label="secret_env (env var name holding the shared secret)">
				<TextInput
					value={secretEnv}
					onChange={(v) => onChange(path, v)}
					placeholder="ROUTINE_WEBHOOK_SECRET"
					mono
				/>
			</Field>
			<div className="font-mono text-2xs text-ink-3">
				Once saved, use the "Rotate secret" button on the Settings tab to mint a server-side secret. Senders sign
				the request body with <code>X-Routine-Signature: sha256=...</code>.
			</div>
		</div>
	);
}
