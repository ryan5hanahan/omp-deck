import type {
	AgentMessageJson,
	AgentSessionEventJson,
	ContextUsage,
	ExecLang,
	ExtUiDialogResponse,
	ImageAttachment,
	ModelInfo,
	ModelRef,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	ServerFrame,
	SessionSnapshot,
	SessionSummary,
} from "@omp-deck/protocol";

/**
 * Abstract bridge to omp. The in-process impl embeds @oh-my-pi/pi-coding-agent
 * directly; a future RPC impl will spawn `omp --mode rpc` subprocesses behind
 * the same surface. Anything the server needs from omp MUST flow through this.
 */
export interface AgentBridge {
	createSession(opts: CreateSessionOpts): Promise<SessionHandle>;
	resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle>;
	getSession(sessionId: string): SessionHandle | undefined;
	listSessions(opts: { cwd?: string }): Promise<SessionSummary[]>;
	/** Pin a session against the idle reaper while a client is subscribed. */
	trackSubscriberAdded(sessionId: string, connectionId: string): void;
	/** Drop a subscriber; once subscribers hit zero and idle window elapses, the reaper claims it. */
	trackSubscriberRemoved(sessionId: string, connectionId: string): void;
	/** Bump last-activity-ts; called for explicit user actions outside subscribe. */
	bumpActivity(sessionId: string): void;
	/** Hot-apply runtime env values that do not require process restart. */
	applyEnvUpdate?(update: RuntimeEnvUpdate): void;
	/** Catalog of models the SDK knows about, plus a marker on the current one when sessionId is given. */
	listModels(opts?: { sessionId?: string }): Promise<ModelInfo[]>;
	/**
	 * Subscribe to extension-UI dialog frames for `sessionId` (open + cancel).
	 * Returns an unsubscribe function. Implementations MAY immediately replay
	 * any already-open dialogs to a new subscriber so a late client (page
	 * reload, second tab) does not miss an active modal.
	 */
	subscribeUiFrames(
		sessionId: string,
		listener: (frame: Extract<ServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>) => void,
	): () => void;
	/** Settle a previously-emitted dialog with the client's response. */
	respondToUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void;
	/**
	 * Subscribe to plan-mode frames for `sessionId` (mode-changed + proposed +
	 * resolved). Returns an unsubscribe function. Implementations MAY replay
	 * the current `plan_mode_changed` and any pending `plan_proposed` to a
	 * late subscriber so a page-reload during plan mode re-renders the pill
	 * and the approval card immediately.
	 */
	subscribePlanModeFrames(
		sessionId: string,
		listener: (
			frame: Extract<
				ServerFrame,
				{ type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }
			>,
		) => void,
	): () => void;
	/**
	 * Settle a previously-emitted plan-approval proposal with the client's
	 * response. Returns `"settled"` on success, `"unknown"` when the
	 * proposalId is unknown or already resolved (caller surfaces a 409 to
	 * the client so optimistic UI can roll back).
	 */
	respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown">;
	dispose(): Promise<void>;
	/**
	 * One-shot agent run for routine `agent` steps: an in-memory session with no
	 * UI and no deck prelude, disposed when the run ends. Throws before any LLM
	 * call on an unknown model or an allowlisted MCP server that isn't installed.
	 */
	runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult>;
}

export interface RuntimeEnvUpdate {
	idleTimeoutMs?: number;
	autoStartCommand?: string | null;
}

export interface HeadlessRunOptions {
	cwd: string;
	prompt: string;
	/** Log prefix, e.g. `agent step write_briefing`. */
	label: string;
	/** Model selector as `omp --model` takes it (bare id, `provider/id`, role); omitted = the SDK default. */
	model?: string;
	/** Skill names. Omitted = all discovered, `[]` = none. */
	skills?: string[];
	/** MCP server names. Omitted = the SDK's own discovery, `[]` = MCP off. */
	mcpServers?: string[];
	/** JSON Schema the model's `yield` result is checked against by the SDK. */
	outputSchema?: unknown;
	signal: AbortSignal;
}

export interface HeadlessRunResult {
	/** Final assistant text. */
	text: string;
	/** `data` of the last successful `yield` call; undefined when the model never yielded. */
	json?: unknown;
	/** Set when the run ended on a model error or abort; usage still counts what was spent. */
	error?: string;
	usage: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		/** USD. */
		cost: number;
	};
	/** `provider/id` the session ran on. */
	model: string;
}

export interface CreateSessionOpts {
	cwd: string;
	model?: ModelRef;
	suppressAutoStart?: boolean;
}

export interface ResumeSessionOpts {
	sessionPath: string;
}

export type EventListener = (event: AgentSessionEventJson) => void;

export interface SessionHandle {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly cwd: string;

	subscribe(listener: EventListener): () => void;
	snapshot(): SessionSnapshot;
	prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
	): Promise<void>;
	/** True iff a turn is currently in-flight. Used by the WS layer to decide
	 *  whether a freshly-arrived prompt is being queued vs. running immediately. */
	isStreamingNow(): boolean;
	/** Number of prompts the SDK currently has queued (steering + follow-up +
	 *  hidden next-turn). */
	queuedMessageCount(): number;
	/** Drop every queued prompt. Returns the per-bucket counts that were
	 *  cleared so the caller can surface a `queue_cleared` event. */
	clearQueue(): { steering: number; followUp: number };
	/**
	 * Snapshot of the bridge-tracked shadow queue (the user-visible queue
	 * mirrored from the SDK). Includes stable `id`s the client can use to
	 * target a specific entry for cancel/edit. Empty when no turn is in flight.
	 */
	getQueueSnapshot(): import("@omp-deck/protocol").QueuedPromptWire[];
	/**
	 * Cancel a single queued prompt by its `id`. Returns true if an entry
	 * was removed, false if the id was unknown (already drained, etc).
	 * Emits a synthetic `queue_state` event on success so subscribers
	 * reconcile their `queuedPrompts` list.
	 */
	cancelQueuedById(id: string): Promise<boolean>;
	/**
	 * Replace a queued prompt's text (and optionally images) in place.
	 * Returns true if the edit landed, false if the id was unknown.
	 * Implementation pops every SDK queue entry synchronously then
	 * re-enqueues survivors with the edited entry substituted — order
	 * preserved. Emits a synthetic `queue_state` event on success.
	 */
	editQueuedById(
		id: string,
		text: string,
		images?: import("@omp-deck/protocol").ImageAttachment[],
	): Promise<boolean>;
	abort(): Promise<void>;
	/**
	 * Composer `!` / `$` execution via the SDK's `executeBash` / `executePython`.
	 * Emits `exec_start`, `exec_chunk`s, then the recorded message as synthetic
	 * `message_start` + `message_end` (both with `execId`) or one `exec_error`.
	 * Resolves when the execution ends; failures are reported as `exec_error`.
	 */
	execute(lang: ExecLang, code: string, opts: { excludeFromContext: boolean }): Promise<void>;
	/** Abort the running composer execution; no-op when none is running. */
	abortExec(): Promise<void>;
	setName(name: string): Promise<void>;
	/**
	 * Trigger manual compaction with optional focus instructions. Resolves once
	 * the SDK acknowledges the call; the actual compaction event arrives via
	 * the regular session event stream so the deck UI can react.
	 */
	compact(focus?: string): Promise<void>;
	/** Swap the live agent session to a different model. Throws on unknown ref or missing auth. */
	setModel(ref: ModelRef): Promise<void>;
	/**
	 * Try to dispatch a leading slash command via the omp SDK's text-mode
	 * dispatcher. Returns `"fallthrough"` when nothing matched — caller should
	 * forward the original text via `prompt()`. `"consumed"` means the SDK ran
	 * the command and there is no follow-up turn. `"rewritten"` means the
	 * command produced a new prompt string the caller should send instead.
	 */
	dispatchSlashCommand(text: string): Promise<SlashDispatchResult>;
	/**
	 * Try to dispatch a leading slash command via the deck's own registry
	 * (kanban operations etc). Same return shape as `dispatchSlashCommand` so
	 * the WS hub can branch identically.
	 */
	dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult>;
	/**
	 * Snapshot of context-window utilization. Returns `undefined` when the
	 * underlying model has no declared context window.
	 */
	getContextUsage(): ContextUsage | undefined;
	dispose(): Promise<void>;
	/** Idempotent enter/exit. No-op when state already matches. */
	setPlanMode(enabled: boolean): Promise<void>;
	/** Read the bridge's plan-mode context for snapshot replay. */
	getPlanModeContext(): PlanModeContextWire | undefined;
	/** Read the unresolved plan-approval card for snapshot replay. */
	getPendingPlanApproval(): PendingPlanApprovalWire | undefined;
	/**
	 * Settle a plan-approval proposal. Returns `"settled"` on success,
	 * `"unknown"` when the proposalId does not match the pending entry
	 * (already resolved by a sibling tab; second clicker gets a 409).
	 */
	respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown">;
}

export type SlashDispatchResult =
	| { kind: "fallthrough" }
	| { kind: "consumed"; output: string }
	| { kind: "rewritten"; output: string; prompt: string };

export interface AgentMessagePassthrough extends AgentMessageJson {}
/**
 * Decision the user made on a `plan_proposed` card. `approved=false` is the
 * reject path (no rename, no synthetic prompt — just exit plan mode); the
 * other fields apply only when approving.
 */
export interface PlanApprovalResponse {
	approved: boolean;
	/** Optional rename: `local://*.md`. When absent, uses the suggested final path. */
	finalPath?: string;
	/** Optional edited plan body. When present, overwrites `local://PLAN.md` before the rename. */
	editedContent?: string;
}
