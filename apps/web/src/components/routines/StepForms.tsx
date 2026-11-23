/**
 * Per-step-type forms for the visual builder. Each form takes a strongly-typed
 * step extract and emits a new step of the same type. Common fields (id, when,
 * on_failure, retry, timeout_secs) live in <StepCommonFields/>; this file only
 * renders the type-specific tail.
 */
import { useEffect, useState } from "react";
import type { McpServerSummary, RoutineStep } from "@omp-deck/protocol";

import { mcpApi } from "@/lib/mcp-api";
import {
	type ArgField,
	argFieldsFromSchema,
	argText,
	coerceArgText,
	parseArgsJson,
	withArg,
} from "@/lib/mcp-args-form";
import { skillsApi } from "@/lib/skills-api";

import {
	ComboSelect,
	Field,
	KeyValueEditor,
	NumInput,
	Select,
	TagInput,
	TextArea,
	TextInput,
} from "./form-primitives";

type Extract2<T extends RoutineStep["type"]> = Extract<RoutineStep, { type: T }>;

interface FormProps<T extends RoutineStep["type"]> {
	step: Extract2<T>;
	onChange: (next: Extract2<T>) => void;
}

/** Loads `load(key)` once per `key` (not per render or keystroke); `undefined` loads nothing. */
function useFetched<T>(
	key: string | undefined,
	load: (key: string) => Promise<T>,
): { data?: T; error?: string; loading: boolean } {
	const [state, setState] = useState<{ key: string; data?: T; error?: string }>();
	useEffect(() => {
		if (key === undefined) return;
		let live = true;
		load(key).then(
			(data) => {
				if (live) setState({ key, data });
			},
			(e: unknown) => {
				if (live) setState({ key, error: e instanceof Error ? e.message : String(e) });
			},
		);
		return () => {
			live = false;
		};
	}, [key]);
	if (key === undefined) return { loading: false };
	if (!state || state.key !== key) return { loading: true };
	return { data: state.data, error: state.error, loading: false };
}

// ─── run ──────────────────────────────────────────────────────────────────

export function RunStepForm({ step, onChange }: FormProps<"run">) {
	return (
		<div className="space-y-2">
			<Field label="command">
				<TextArea
					value={step.command}
					onChange={(v) => onChange({ ...step, command: v })}
					rows={2}
					placeholder="echo hello"
				/>
			</Field>
			<Field label="cwd (optional)">
				<TextInput
					value={step.cwd ?? ""}
					onChange={(v) => {
						const next = { ...step };
						if (v.trim() === "") delete next.cwd;
						else next.cwd = v;
						onChange(next);
					}}
					placeholder="C:/path/to/repo"
					mono
				/>
			</Field>
		</div>
	);
}

// ─── agent ────────────────────────────────────────────────────────────────

export function AgentStepForm({ step, onChange }: FormProps<"agent">) {
	// Suggestions only: a failed load leaves free typing.
	const servers = useFetched("mcp-servers", () => mcpApi.list());
	const skills = useFetched("skills", () => skillsApi.list());
	const serverNames = servers.data?.map((s) => s.name);
	const skillNames = skills.data && [...new Set(skills.data.skills.filter((s) => s.enabled).map((s) => s.name))];
	function patch(p: Partial<Extract2<"agent">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-2">
			<Field label="prompt">
				<TextArea
					value={step.prompt}
					onChange={(v) => patch({ prompt: v })}
					rows={6}
					placeholder="Summarize {{ steps.fetch_tasks.json }} in 2 sentences."
					ariaLabel="prompt"
				/>
			</Field>
			<Field label="model (optional)">
				<TextInput
					value={step.model ?? ""}
					onChange={(v) => {
						const next = { ...step };
						if (v.trim() === "") delete next.model;
						else next.model = v;
						onChange(next);
					}}
					placeholder="claude-sonnet-4-5 (defaults to omp's active model)"
					ariaLabel="model"
					mono
				/>
			</Field>
			<div className="grid grid-cols-2 gap-2">
				<Field label="skills_allowed">
					<TagInput
						values={step.skills_allowed ?? []}
						onChange={(v) => {
							const next = { ...step };
							if (v.length === 0) delete next.skills_allowed;
							else next.skills_allowed = v;
							onChange(next);
						}}
						placeholder="skill-name"
						suggestions={skillNames}
						ariaLabel="skills_allowed"
					/>
				</Field>
				<Field label="mcp_servers_allowed">
					<TagInput
						values={step.mcp_servers_allowed ?? []}
						onChange={(v) => {
							const next = { ...step };
							if (v.length === 0) delete next.mcp_servers_allowed;
							else next.mcp_servers_allowed = v;
							onChange(next);
						}}
						placeholder="server-name"
						suggestions={serverNames}
						ariaLabel="mcp_servers_allowed"
					/>
				</Field>
			</div>
		</div>
	);
}

// ─── write ────────────────────────────────────────────────────────────────

export function WriteStepForm({ step, onChange }: FormProps<"write">) {
	function patch(p: Partial<Extract2<"write">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-2">
			<Field label="path">
				<TextInput
					value={step.path}
					onChange={(v) => patch({ path: v })}
					placeholder="inbox/captures/{{ run.date }}-briefing.md"
					mono
				/>
			</Field>
			<Field label="content">
				<TextArea
					value={step.content}
					onChange={(v) => patch({ content: v })}
					rows={5}
					placeholder="# Heading\n\n{{ steps.summarize.stdout }}"
				/>
			</Field>
			<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
				<input
					type="checkbox"
					checked={step.append === true}
					onChange={(e) => {
						const next = { ...step };
						if (e.target.checked) next.append = true;
						else delete next.append;
						onChange(next);
					}}
				/>
				<span>append (otherwise overwrite)</span>
			</label>
		</div>
	);
}

// ─── http ─────────────────────────────────────────────────────────────────

const HTTP_METHODS: Array<{ value: Extract2<"http">["method"]; label: string }> = [
	{ value: "GET", label: "GET" },
	{ value: "POST", label: "POST" },
	{ value: "PUT", label: "PUT" },
	{ value: "PATCH", label: "PATCH" },
	{ value: "DELETE", label: "DELETE" },
];

export function HttpStepForm({ step, onChange }: FormProps<"http">) {
	function patch(p: Partial<Extract2<"http">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-[5rem_1fr] gap-2">
				<Field label="method">
					<select
						value={step.method}
						onChange={(e) => patch({ method: e.target.value as Extract2<"http">["method"] })}
						className="field h-7 w-full px-2 font-mono text-2xs"
					>
						{HTTP_METHODS.map((m) => (
							<option key={m.value} value={m.value}>
								{m.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="url">
					<TextInput
						value={step.url}
						onChange={(v) => patch({ url: v })}
						placeholder="http://127.0.0.1:8787/api/tasks"
						mono
					/>
				</Field>
			</div>
			<Field label="headers">
				<KeyValueEditor
					pairs={(step.headers as Record<string, string>) ?? {}}
					onChange={(v) => {
						const next = { ...step };
						if (Object.keys(v).length === 0) delete next.headers;
						else next.headers = v;
						onChange(next);
					}}
					keyPlaceholder="X-Header"
					valuePlaceholder="value"
				/>
			</Field>
			<Field label="query">
				<KeyValueEditor
					pairs={objToStringMap(step.query)}
					onChange={(v) => {
						const next = { ...step };
						if (Object.keys(v).length === 0) delete next.query;
						else next.query = v;
						onChange(next);
					}}
					keyPlaceholder="param"
					valuePlaceholder="value"
				/>
			</Field>
			{step.method !== "GET" && step.method !== "DELETE" ? (
				<Field label="body (JSON or template)">
					<TextArea
						value={bodyToString(step.body)}
						onChange={(v) => {
							const next = { ...step };
							if (v.trim() === "") delete next.body;
							else next.body = v;
							onChange(next);
						}}
						rows={3}
						placeholder='{ "title": "{{ run.id }}" }'
					/>
				</Field>
			) : null}
			<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
				<input
					type="checkbox"
					checked={step.expect_json !== false}
					onChange={(e) => {
						const next = { ...step };
						if (e.target.checked) delete next.expect_json;
						else next.expect_json = false;
						onChange(next);
					}}
				/>
				<span>expect JSON response (writes to steps.{step.id}.json)</span>
			</label>
		</div>
	);
}

function objToStringMap(o: unknown): Record<string, string> {
	if (!o || typeof o !== "object") return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(o)) {
		out[k] = String(v);
	}
	return out;
}

function bodyToString(b: unknown): string {
	if (b === undefined) return "";
	if (typeof b === "string") return b;
	try {
		return JSON.stringify(b, null, 2);
	} catch {
		return String(b);
	}
}


// ─── deck ─────────────────────────────────────────────────────────────────

type DeckStep = Extract2<"deck">;

export function DeckStepForm({ step, onChange }: FormProps<"deck">) {
	function swapAction(action: DeckStep["action"]): void {
		const common = {
			id: step.id,
			type: "deck" as const,
			when: step.when,
			on_failure: step.on_failure,
			retry: step.retry,
			timeout_secs: step.timeout_secs,
		};
		switch (action) {
			case "create_inbox_item":
				onChange({
					...common,
					action,
					kind: "capture",
					title: step.action === action ? step.title : "routine-output-{{ run.date }}",
					body:
						step.action === action
							? step.body
							: step.action === "create_task"
								? step.body
								: "{{ steps.X.stdout }}",
					source: step.action === action ? step.source : "routine:{{ run.id }}",
				});
				return;
			case "create_task":
				onChange({
					...common,
					action,
					title: step.action === action ? step.title : "Follow up on {{ run.date }}",
					body:
						step.action === action
							? step.body
							: step.action === "create_inbox_item"
								? step.body
								: "{{ steps.X.stdout }}",
					state_ref: step.action === action ? step.state_ref : undefined,
					cwd: step.action === action ? step.cwd : undefined,
				});
				return;
			case "move_task":
				onChange({
					...common,
					action,
					task_ref: step.action === action ? step.task_ref : "T-1",
					state_ref: step.action === action ? step.state_ref : "done",
					index: step.action === action ? step.index : 0,
				});
				return;
			case "promote_inbox_item_to_task":
				onChange({
					...common,
					action,
					inbox_ref: step.action === action ? step.inbox_ref : "i_...",
					state_ref: step.action === action ? step.state_ref : undefined,
					mark_processed: step.action === action ? step.mark_processed : undefined,
				});
				return;
			case "list_tasks":
				onChange({
					...common,
					action,
					state_ref: step.action === action ? step.state_ref : "active",
					since_hours: step.action === action ? step.since_hours : undefined,
					include_archived: step.action === action ? step.include_archived : undefined,
					limit: step.action === action ? step.limit : undefined,
				});
				return;
			case "list_inbox":
				onChange({
					...common,
					action,
					kind: step.action === action ? step.kind : undefined,
					since_hours: step.action === action ? step.since_hours : 24,
					include_processed: step.action === action ? step.include_processed : undefined,
					limit: step.action === action ? step.limit : undefined,
				});
				return;
			case "get_task":
				onChange({
					...common,
					action,
					task_ref: step.action === action ? step.task_ref : "T-1",
				});
				return;
			case "get_inbox_item":
				onChange({
					...common,
					action,
					inbox_ref: step.action === action ? step.inbox_ref : "i_...",
				});
				return;
		}
	}

	return (
		<div className="space-y-2">
			<Field label="action">
				<select
					value={step.action}
					onChange={(e) => swapAction(e.target.value as DeckStep["action"])}
					className="field h-7 w-full px-2 font-mono text-2xs"
				>
					<option value="create_inbox_item">create_inbox_item</option>
					<option value="create_task">create_task</option>
					<option value="move_task">move_task</option>
					<option value="promote_inbox_item_to_task">promote_inbox_item_to_task</option>
					<option value="list_tasks">list_tasks</option>
					<option value="list_inbox">list_inbox</option>
					<option value="get_task">get_task</option>
					<option value="get_inbox_item">get_inbox_item</option>
				</select>
			</Field>
			{step.action === "create_inbox_item" ? (
				<div className="space-y-2">
					<Field label="kind">
						<select
							value={step.kind}
							onChange={(e) => onChange({ ...step, kind: e.target.value as Extract<DeckStep, { action: "create_inbox_item" }>["kind"] })}
							className="field h-7 w-full px-2 font-mono text-2xs"
						>
							<option value="capture">capture</option>
							<option value="email">email</option>
							<option value="ticket">ticket</option>
							<option value="idea">idea</option>
							<option value="decision">decision</option>
							<option value="investigation">investigation</option>
						</select>
					</Field>
					<Field label="title">
						<TextInput value={step.title} onChange={(v) => onChange({ ...step, title: v })} placeholder="Morning briefing - {{ run.date }}" mono />
					</Field>
					<Field label="body">
						<TextArea value={step.body ?? ""} onChange={(v) => onChange({ ...step, body: v === "" ? undefined : v })} rows={5} placeholder="{{ steps.write_briefing.stdout }}" />
					</Field>
					<Field label="source (optional)">
						<TextInput value={step.source ?? ""} onChange={(v) => onChange({ ...step, source: v === "" ? undefined : v })} placeholder="routine:daily-briefing" mono />
					</Field>
				</div>
			) : null}
			{step.action === "create_task" ? (
				<div className="space-y-2">
					<Field label="title">
						<TextInput value={step.title} onChange={(v) => onChange({ ...step, title: v })} placeholder="Follow up on {{ run.date }}" mono />
					</Field>
					<Field label="body (optional)">
						<TextArea value={step.body ?? ""} onChange={(v) => onChange({ ...step, body: v === "" ? undefined : v })} rows={4} placeholder="{{ steps.digest.stdout }}" />
					</Field>
					<Field label="state_ref (optional)">
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="backlog or s_backlog" mono />
					</Field>
					<Field label="cwd (optional)">
						<TextInput value={step.cwd ?? ""} onChange={(v) => onChange({ ...step, cwd: v === "" ? undefined : v })} placeholder="C:/path/to/repo" mono />
					</Field>
				</div>
			) : null}
			{step.action === "move_task" ? (
				<div className="space-y-2">
					<Field label="task_ref">
						<TextInput value={step.task_ref} onChange={(v) => onChange({ ...step, task_ref: v })} placeholder="T-58 or t_01..." mono />
					</Field>
					<Field label="state_ref">
						<TextInput value={step.state_ref} onChange={(v) => onChange({ ...step, state_ref: v })} placeholder="done or s_done" mono />
					</Field>
					<Field label="index (0 = top of destination column)">
						<NumInput value={step.index} onChange={(v) => onChange({ ...step, index: v ?? 0 })} placeholder="0" />
					</Field>
				</div>
			) : null}
			{step.action === "promote_inbox_item_to_task" ? (
				<div className="space-y-2">
					<Field label="inbox_ref">
						<TextInput value={step.inbox_ref} onChange={(v) => onChange({ ...step, inbox_ref: v })} placeholder="i_..." mono />
					</Field>
					<Field label="state_ref (optional)">
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="backlog or s_backlog" mono />
					</Field>
					<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
						<input
							type="checkbox"
							checked={step.mark_processed !== false}
							onChange={(e) => {
								const next = { ...step };
								if (e.target.checked) delete next.mark_processed;
								else next.mark_processed = false;
								onChange(next);
							}}
						/>
						<span>mark inbox item processed after promotion</span>
					</label>
				</div>
			) : null}
			{step.action === "list_tasks" ? (
				<div className="space-y-2">
					<Field label="state_ref (optional — name like 'active' or id like 's_active')">
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="active" mono />
					</Field>
					<Field label="since_hours (optional — only tasks updated in last N hours)">
						<NumInput value={step.since_hours} onChange={(v) => onChange({ ...step, since_hours: v ?? undefined })} placeholder="24" />
					</Field>
					<Field label="limit (optional)">
						<NumInput value={step.limit} onChange={(v) => onChange({ ...step, limit: v ?? undefined })} placeholder="50" />
					</Field>
					<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
						<input
							type="checkbox"
							checked={step.include_archived === true}
							onChange={(e) => {
								const next = { ...step };
								if (e.target.checked) next.include_archived = true;
								else delete next.include_archived;
								onChange(next);
							}}
						/>
						<span>include archived tasks</span>
					</label>
				</div>
			) : null}
			{step.action === "list_inbox" ? (
				<div className="space-y-2">
					<Field label="kind (optional)">
						<select
							value={step.kind ?? ""}
							onChange={(e) => {
								const v = e.target.value;
								const next = { ...step };
								if (v === "") delete next.kind;
								else next.kind = v as Extract<DeckStep, { action: "list_inbox" }>["kind"];
								onChange(next);
							}}
							className="field h-7 w-full px-2 font-mono text-2xs"
						>
							<option value="">(any)</option>
							<option value="capture">capture</option>
							<option value="email">email</option>
							<option value="ticket">ticket</option>
							<option value="idea">idea</option>
							<option value="decision">decision</option>
							<option value="investigation">investigation</option>
						</select>
					</Field>
					<Field label="since_hours (optional)">
						<NumInput value={step.since_hours} onChange={(v) => onChange({ ...step, since_hours: v ?? undefined })} placeholder="24" />
					</Field>
					<Field label="limit (optional)">
						<NumInput value={step.limit} onChange={(v) => onChange({ ...step, limit: v ?? undefined })} placeholder="50" />
					</Field>
					<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
						<input
							type="checkbox"
							checked={step.include_processed === true}
							onChange={(e) => {
								const next = { ...step };
								if (e.target.checked) next.include_processed = true;
								else delete next.include_processed;
								onChange(next);
							}}
						/>
						<span>include already-processed items</span>
					</label>
				</div>
			) : null}
			{step.action === "get_task" ? (
				<div className="space-y-2">
					<Field label="task_ref">
						<TextInput value={step.task_ref} onChange={(v) => onChange({ ...step, task_ref: v })} placeholder="T-58 or t_01..." mono />
					</Field>
				</div>
			) : null}
			{step.action === "get_inbox_item" ? (
				<div className="space-y-2">
					<Field label="inbox_ref">
						<TextInput value={step.inbox_ref} onChange={(v) => onChange({ ...step, inbox_ref: v })} placeholder="i_..." mono />
					</Field>
				</div>
			) : null}
		</div>
	);
}

// ─── mcp ──────────────────────────────────────────────────────────────────

function serverLabel(s: McpServerSummary): string {
	if (!s.enabled) return `${s.name} (disabled)`;
	return s.status === "connected" ? s.name : `${s.name} (${s.status})`;
}

type Hint = { text?: string; tone?: "danger" | "warn" };

export function McpStepForm({ step, onChange }: FormProps<"mcp">) {
	const servers = useFetched("mcp-servers", () => mcpApi.list());
	const server = servers.data?.find((s) => s.name === step.server);
	// Only installed names load tools, so typing a free-text name never fetches per keystroke.
	const tools = useFetched(server?.name, (name) => mcpApi.tools(name));
	const tool = tools.data?.find((t) => t.name === step.tool);
	const fields = tool ? argFieldsFromSchema(tool.inputSchema) : [];
	const args = step.args ?? {};

	// The textarea keeps its own text so invalid JSON stays visible; the spec keeps the last valid args.
	const argsJson = JSON.stringify(args);
	const [text, setText] = useState(() => JSON.stringify(args, null, 2));
	const [jsonError, setJsonError] = useState<string>();
	const [syncedJson, setSyncedJson] = useState(argsJson);
	if (argsJson !== syncedJson) {
		// args changed outside the textarea (a generated input, another step): show them unless the text already says the same.
		setSyncedJson(argsJson);
		const current = parseArgsJson(text);
		if (!("args" in current) || JSON.stringify(current.args) !== argsJson) {
			setText(JSON.stringify(args, null, 2));
			setJsonError(undefined);
		}
	}

	function patch(p: Partial<Extract2<"mcp">>): void {
		onChange({ ...step, ...p });
	}

	let serverHint: Hint = {};
	if (servers.loading) serverHint = { text: "loading…" };
	else if (servers.error) serverHint = { text: servers.error, tone: "danger" };
	else if (servers.data?.length === 0) serverHint = { text: "none installed (see Integrations)", tone: "warn" };
	else if (!server) serverHint = step.server ? { text: "not installed", tone: "warn" } : {};
	else if (!server.enabled) serverHint = { text: "disabled", tone: "warn" };
	else if (server.error) serverHint = { text: server.error, tone: "danger" };
	else serverHint = { text: `${server.status} · ${server.toolCount} tools` };

	let toolHint: Hint = {};
	if (!server) toolHint = {};
	else if (tools.loading) toolHint = { text: "loading…" };
	else if (tools.error) toolHint = { text: tools.error, tone: "danger" };
	else if (tools.data?.length === 0) toolHint = { text: "server lists no tools", tone: "warn" };
	else if (step.tool && !tool) toolHint = { text: "not on this server", tone: "warn" };

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-2 gap-2">
				<Field label="server" hint={serverHint.text} tone={serverHint.tone}>
					<ComboSelect
						value={step.server}
						onChange={(v) => patch({ server: v })}
						options={(servers.data ?? []).map((s) => ({ value: s.name, label: serverLabel(s) }))}
						placeholder="pick a server…"
						ariaLabel="server"
					/>
				</Field>
				<Field label="tool" hint={toolHint.text} tone={toolHint.tone}>
					<ComboSelect
						value={step.tool}
						onChange={(v) => patch({ tool: v })}
						options={(tools.data ?? []).map((t) => ({ value: t.name, label: t.name }))}
						placeholder="pick a tool…"
						ariaLabel="tool"
					/>
				</Field>
			</div>
			{tool?.description ? (
				<div className="line-clamp-3 text-2xs text-ink-3" title={tool.description}>
					{tool.description}
				</div>
			) : null}
			{fields.map((f) => (
				<ArgInput
					key={f.name}
					field={f}
					value={args[f.name]}
					onChange={(v) => patch({ args: withArg(args, f.name, v) })}
				/>
			))}
			<Field label="args (JSON)" hint={jsonError} tone="danger">
				<TextArea
					value={text}
					onChange={(v) => {
						setText(v);
						const parsed = parseArgsJson(v);
						if ("error" in parsed) {
							setJsonError(parsed.error);
							return;
						}
						setJsonError(undefined);
						patch({ args: parsed.args });
					}}
					rows={4}
					placeholder='{ "path": "{{ run.date }}.md" }'
					ariaLabel="args (JSON)"
				/>
			</Field>
		</div>
	);
}

// Select value for "type a template"; real option values are indexes.
const TEMPLATE = "template";

/** A generated input for one primitive tool param. A choice field holding a value outside its options (a template included) edits as text. */
function ArgInput({
	field,
	value,
	onChange,
}: {
	field: ArgField;
	value: unknown;
	onChange: (next: unknown) => void;
}) {
	const ariaLabel = field.required ? `${field.name} (required)` : field.name;
	const { options } = field;
	const idx = options ? options.findIndex((o) => o === value) : -1;
	const numeric = field.kind === "number" || field.kind === "integer";
	return (
		<Field label={field.required ? `${field.name} *` : field.name}>
			{options && (value === undefined || idx >= 0) ? (
				<Select
					value={value === undefined ? "" : String(idx)}
					onChange={(v) => onChange(v === "" ? undefined : v === TEMPLATE ? "{{ }}" : options[Number(v)])}
					ariaLabel={ariaLabel}
					options={[
						{ value: "", label: field.required ? "— required —" : "— not set —" },
						...options.map((o, i) => ({ value: String(i), label: String(o) })),
						{ value: TEMPLATE, label: "{{ template }}…" },
					]}
				/>
			) : (
				<TextInput
					value={argText(value)}
					onChange={(t) => onChange(coerceArgText(field, t))}
					placeholder={numeric ? `${field.kind} or {{ … }}` : undefined}
					ariaLabel={ariaLabel}
					mono
				/>
			)}
			{field.description ? (
				<div className="mt-0.5 line-clamp-2 text-2xs text-ink-4" title={field.description}>
					{field.description}
				</div>
			) : null}
		</Field>
	);
}

// ─── transform ────────────────────────────────────────────────────────────

export function TransformStepForm({ step, onChange }: FormProps<"transform">) {
	return (
		<div className="space-y-2">
			<Field label="body (JS expression, returns the json output)">
				<TextArea
					value={step.body}
					onChange={(v) => onChange({ ...step, body: v })}
					rows={6}
					placeholder={"const tasks = steps.fetch_tasks.json.tasks;\nreturn { count: tasks.length };"}
				/>
			</Field>
			<div className="font-mono text-2xs text-ink-3">
				Sandboxed (quickjs, 100ms cap). Globals: <code>run</code>, <code>trigger</code>,{" "}
				<code>steps</code>, <code>state</code>, <code>env</code>, <code>secrets</code>.
			</div>
		</div>
	);
}

// ─── wait ─────────────────────────────────────────────────────────────────

export function WaitStepForm({ step, onChange }: FormProps<"wait">) {
	return (
		<Field label="duration_secs">
			<NumInput
				value={step.duration_secs}
				onChange={(v) => onChange({ ...step, duration_secs: v ?? 0 })}
				placeholder="5"
			/>
		</Field>
	);
}

// ─── set_state ────────────────────────────────────────────────────────────

export function SetStateStepForm({ step, onChange }: FormProps<"set_state">) {
	return (
		<Field label="state (keys to upsert, values may use {{ template }})">
			<KeyValueEditor
				pairs={objToStringMap(step.state)}
				onChange={(v) => onChange({ ...step, state: v })}
				keyPlaceholder="last_run_date"
				valuePlaceholder="{{ run.date }}"
			/>
		</Field>
	);
}
