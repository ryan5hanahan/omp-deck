/**
 * Per-session bridge for omp plan mode.
 *
 * Mirrors the TUI's `InteractiveMode.#enterPlanMode` lifecycle on top of
 * the deck's WebSocket protocol:
 *
 *   1. Client sends `set_plan_mode {enabled:true}` → `enter()`:
 *      - snapshot active tools, splice in `write` if missing (it is the
 *        `xd://propose` submission transport)
 *      - `setActiveToolsByName(planTools)`
 *      - `setPlanModeState({ enabled, planFilePath, workflow })`
 *      - `setPlanProposalHandler(#handlePlanProposal)`
 *      - broadcast `plan_mode_changed{enabled:true}`
 *
 *   2. Agent works under plan-mode restrictions (SDK's
 *      `#enforcePlanModeToolDecision` blocks writes via the system
 *      prompt + tool-decision intercept), writes `local://<slug>-plan.md`,
 *      then writes the plan title to `xd://propose`. The SDK invokes our
 *      proposal handler with that title.
 *
 *   3. `#handlePlanProposal`:
 *      - validates plan-mode is still active
 *      - locates the plan file + finalizes its title via the SDK's
 *        `resolveApprovedPlan` (handles a dropped/empty title)
 *      - broadcasts `plan_proposed` to the deck UI
 *      - **blocks** on a Promise the deck UI settles via
 *        `plan_response` → `respond(proposalId, response)`
 *
 *   4. On approve: write edited content (if any), rename the plan only
 *      when the user picked a different final path (SDK 18 never renames),
 *      exit plan mode (restoring the
 *      previous tool set + clearing handler + clearing SDK state),
 *      and queue the SDK's `planModeApprovedPrompt` as a follow-up
 *      so the next turn executes the plan with full tools.
 *
 *   5. On reject: exit plan mode and surface a clear rejection
 *      message to the agent.
 *
 *   6. On cancel (user toggles plan mode off mid-approval) or session
 *      dispose: reject the pending promise so the `xd://propose` write
 *      returns with an error the agent can recover from.
 *
 * SDK reference impls: `modes/acp/acp-agent.ts` (`#applyModeChange`,
 * `#handleAcpPlanProposal` — blocks in the handler like we do) and
 * `modes/interactive-mode.ts` (`#enterPlanMode`, `#approvePlan`).
 */
import * as fs from "node:fs/promises";

import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	type PlanApprovalDetails,
	resolveApprovedPlan,
} from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { listPlanFiles } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	PendingPlanApprovalWire,
	PlanModeContextWire,
	ServerFrame,
} from "@omp-deck/protocol";

import type { PlanApprovalResponse } from "./types.ts";

import { logger } from "../log.ts";

const log = logger("bridge:plan-mode");

/** Default plan file URL seeded into plan-mode state (SDK `DEFAULT_PLAN_FILE_URL`).
 *  The agent may pick its own `local://<slug>-plan.md`; `resolveApprovedPlan`
 *  finds whichever it wrote. */
const PLAN_FILE_URL = "local://PLAN.md";

/** Tool the SDK requires for plan-mode submission (`write` to `xd://propose`).
 *  Spliced into the active tool set on enter if it isn't already there. */
const PROPOSE_TOOL = "write";

/** Workflow flavor passed to `setPlanModeState`. MVP only supports
 *  `"parallel"`; `"iterative"` (TUI-only) is explicitly out of scope. */
const PLAN_WORKFLOW = "parallel" as const;

/**
 * Pre-rendered companion to
 * `@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-approved.md`
 * with the deck's fixed branches baked in:
 *   - `contextPreserved: true` (deck never compacts at the plan boundary;
 *     deferred to v1.1 — see design doc §"open questions" #2)
 *   - `tools` includes `todo` (deck's session tool set always has it)
 *
 * Inlined because the SDK's `exports` map doesn't expose `.md` assets, and
 * we want a stable contract that's visible alongside the lifecycle code
 * rather than a fragile runtime fetch. **Mirror SDK changes here on
 * upgrade.** Diff against the upstream file when bumping
 * `@oh-my-pi/pi-coding-agent`. (Last synced: 18.18.0.)
 */
const PLAN_APPROVED_PROMPT_TEMPLATE = `Plan approved.
- History usable; the plan below authoritative if it conflicts with earlier exploration.

<instruction>
Full plan inlined below; durable copy at \`{{planFilePath}}\` (identical content).
Execute plan step-by-step with full tool access; MUST verify each step before next.
NEVER re-read \`{{planFilePath}}\` while the inline plan is intact; the path is for subagent handoff and recovery only.
Before execution: initialize todo tracking with \`todo\`.
After each completed step: immediately update \`todo\`.
If \`todo\` fails: fix payload; retry before continuing.
</instruction>

<plan path="{{planFilePath}}">
{{planContent}}
</plan>

<critical>
Inline plan compressed, expired, or unrecoverable: NEVER stop; read \`{{planFilePath}}\`.
Read failure: report exact path and error; NEVER guess.
MUST continue until complete.
</critical>
`;

type PlanModeChangedFrame = Extract<ServerFrame, { type: "plan_mode_changed" }>;
type PlanProposedFrame = Extract<ServerFrame, { type: "plan_proposed" }>;
type PlanProposalResolvedFrame = Extract<ServerFrame, { type: "plan_proposal_resolved" }>;
export type PlanModeFrame = PlanModeChangedFrame | PlanProposedFrame | PlanProposalResolvedFrame;

type FrameListener = (frame: PlanModeFrame) => void;

interface PendingApproval {
	proposalId: string;
	planFilePath: string;
	planContent: string;
	suggestedTitle: string;
	suggestedFinalPath: string;
	resolve: (resp: PlanApprovalResponse) => void;
	reject: (err: Error) => void;
}

/**
 * Minimal `AgentSession` surface this bridge needs. Listed here as a
 * structural interface so tests can substitute a hand-rolled fake without
 * spinning up the full SDK.
 */
export interface PlanModeSessionSurface {
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	setPlanModeState(state: { enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined): void;
	setPlanProposalHandler(handler: ((title: string) => Promise<AgentToolResult<unknown>>) | null): void;
	setPlanReferencePath(path: string): void;
	markPlanReferenceSent(): void;
	readonly isStreaming: boolean;
	prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<boolean>;
}

export interface PlanModeBridgeArgs {
	sessionId: string;
	session: PlanModeSessionSurface;
	/** SDK `sessionManager.getArtifactsDir()` — feeds `local://` resolution. */
	getArtifactsDir: () => string | null;
	/** SDK `sessionManager.getSessionId()` — feeds `local://` resolution. */
	getSessionId: () => string | null;
}

/** Bridge over the SDK's plan-mode primitives, scoped to one session. */
export class PlanModeBridge {
	private readonly sessionId: string;
	private readonly session: PlanModeSessionSurface;
	private readonly getArtifactsDir: () => string | null;
	private readonly getSessionId: () => string | null;
	private readonly listeners = new Set<FrameListener>();
	private nextProposalCounter = 1;
	private enabled = false;
	private planFilePath: string = PLAN_FILE_URL;
	private previousTools: string[] = [];
	private pendingApproval: PendingApproval | undefined;
	private disposed = false;

	constructor(args: PlanModeBridgeArgs) {
		this.sessionId = args.sessionId;
		this.session = args.session;
		this.getArtifactsDir = args.getArtifactsDir;
		this.getSessionId = args.getSessionId;
	}

	// ─── Snapshot + replay surface (consumed by InProcessAgentBridge) ─────

	isEnabled(): boolean {
		return this.enabled;
	}

	hasPendingApproval(): boolean {
		return this.pendingApproval !== undefined;
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		if (!this.enabled) return undefined;
		return { enabled: true, planFilePath: this.planFilePath };
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		const p = this.pendingApproval;
		if (!p) return undefined;
		return {
			proposalId: p.proposalId,
			planFilePath: p.planFilePath,
			planContent: p.planContent,
			suggestedTitle: p.suggestedTitle,
			suggestedFinalPath: p.suggestedFinalPath,
		};
	}

	/** Replay frames sent verbatim to a late subscriber so a page-reload
	 *  during plan mode immediately re-renders the pill + any open card. */
	getReplayFrames(): PlanModeFrame[] {
		const out: PlanModeFrame[] = [];
		if (this.enabled) {
			out.push({
				type: "plan_mode_changed",
				sessionId: this.sessionId,
				enabled: true,
				planFilePath: this.planFilePath,
			});
		}
		const p = this.pendingApproval;
		if (p) {
			out.push({
				type: "plan_proposed",
				sessionId: this.sessionId,
				proposalId: p.proposalId,
				planFilePath: p.planFilePath,
				planContent: p.planContent,
				suggestedTitle: p.suggestedTitle,
				suggestedFinalPath: p.suggestedFinalPath,
			});
		}
		return out;
	}

	subscribeFrames(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	/** Enter plan mode. Idempotent — re-entry is a no-op. */
	async enter(): Promise<void> {
		if (this.disposed || this.enabled) return;

		const previousTools = this.session.getActiveToolNames();
		const planTools = previousTools.includes(PROPOSE_TOOL)
			? previousTools
			: [...previousTools, PROPOSE_TOOL];
		await this.session.setActiveToolsByName(planTools);

		this.previousTools = previousTools;
		this.planFilePath = PLAN_FILE_URL;
		this.enabled = true;

		this.session.setPlanModeState({
			enabled: true,
			planFilePath: this.planFilePath,
			workflow: PLAN_WORKFLOW,
		});
		this.session.setPlanProposalHandler((title) => this.#handlePlanProposal(title));

		this.#broadcast({
			type: "plan_mode_changed",
			sessionId: this.sessionId,
			enabled: true,
			planFilePath: this.planFilePath,
		});
		log.info(`plan mode entered for ${this.sessionId}`);
	}

	/**
	 * Exit plan mode. Idempotent. Rejects any pending approval first so the
	 * proposal handler unblocks with a clear error the agent sees as the
	 * `xd://propose` write's failure result.
	 *
	 * `reason` differentiates user-cancel (Shift+Tab off, Reject click) from
	 * server-side cleanup (session disposed, approve path that already did
	 * the rename + synthetic prompt).
	 */
	async exit(
		reason: "user_cancelled" | "session_disposed" | "approved" | "rejected" = "user_cancelled",
	): Promise<void> {
		if (this.disposed && reason !== "session_disposed") return;
		if (!this.enabled && !this.pendingApproval) return;

		if (this.pendingApproval) {
			const pending = this.pendingApproval;
			this.pendingApproval = undefined;
			if (reason === "user_cancelled" || reason === "session_disposed") {
				const message =
					reason === "user_cancelled"
						? "Plan approval cancelled: user exited plan mode."
						: "Plan approval abandoned: session disposed.";
				pending.reject(new Error(message));
				this.#broadcast({
					type: "plan_proposal_resolved",
					sessionId: this.sessionId,
					proposalId: pending.proposalId,
					outcome: reason === "user_cancelled" ? "rejected" : "expired",
				});
			}
		}

		if (this.enabled) {
			if (this.previousTools.length > 0) {
				try {
					await this.session.setActiveToolsByName(this.previousTools);
				} catch (err) {
					log.warn(`tool restore failed during exit for ${this.sessionId}`, err);
				}
			}
			this.session.setPlanProposalHandler(null);
			this.session.setPlanModeState(undefined);
			this.enabled = false;
			this.previousTools = [];

			this.#broadcast({
				type: "plan_mode_changed",
				sessionId: this.sessionId,
				enabled: false,
			});
		}

		log.info(`plan mode exited for ${this.sessionId} (${reason})`);
	}

	/**
	 * Settle the pending approval. Returns `"unknown"` when the proposalId
	 * does not match the live pending entry (already-resolved by a sibling
	 * tab; the caller surfaces a 409 + the client rolls back optimistic UI).
	 */
	respond(proposalId: string, response: PlanApprovalResponse): "settled" | "unknown" {
		const pending = this.pendingApproval;
		if (!pending || pending.proposalId !== proposalId) {
			return "unknown";
		}
		// Do NOT clear pendingApproval here — the apply callback clears it
		// after the promise resolves so any concurrent respond() racing
		// with the resolve still sees "settled" until the callback exits.
		pending.resolve(response);
		return "settled";
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		// Fire-and-forget — dispose is sync; the SDK call chain in exit() is
		// best-effort during teardown.
		void this.exit("session_disposed");
		this.listeners.clear();
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	#broadcast(frame: PlanModeFrame): void {
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`plan-mode frame listener threw`, err);
			}
		}
	}

	/**
	 * Plan-proposal handler. The SDK calls this when the agent writes the
	 * plan title to `xd://propose` while plan-mode is active. Blocks on the
	 * user's `plan_response` reply; the returned result is what the agent
	 * sees as the write's outcome. On approve, the deferred
	 * `session.prompt(..., followUp)` starts a fresh turn that executes the
	 * approved plan.
	 */
	async #handlePlanProposal(title: string): Promise<AgentToolResult<PlanApprovalDetails>> {
		if (!this.enabled) {
			throw new ToolError("Plan mode is not active.");
		}

		const resolved = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: this.planFilePath,
			readPlan: (url) => this.#readPlanFile(url),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: this.#localOptions() }),
		});
		const planFilePath = resolved.planFilePath;
		const planContent = resolved.planContent;
		const proposalId = this.#allocateProposalId();

		// Block on user approval. Stash the proposal so reconnects can
		// replay it and a parallel `set_plan_mode(false)` can reject it.
		const userResponse = await new Promise<PlanApprovalResponse>((resolve, reject) => {
			this.pendingApproval = {
				proposalId,
				planFilePath,
				planContent,
				suggestedTitle: resolved.title,
				suggestedFinalPath: planFilePath,
				resolve,
				reject,
			};
			this.#broadcast({
				type: "plan_proposed",
				sessionId: this.sessionId,
				proposalId,
				planFilePath,
				planContent,
				suggestedTitle: resolved.title,
				suggestedFinalPath: planFilePath,
			});
		});

		// Clear pending — anything after this point is post-decision.
		this.pendingApproval = undefined;

		if (!userResponse.approved) {
			this.#broadcast({
				type: "plan_proposal_resolved",
				sessionId: this.sessionId,
				proposalId,
				outcome: "rejected",
			});
			await this.exit("rejected");
			return {
				content: [
					{
						type: "text" as const,
						text: "User rejected the plan. Plan mode disabled; do not auto-execute.",
					},
				],
				details: { planFilePath, title: resolved.title, planExists: true },
			};
		}

		// Approve path: optionally write edited content, move the plan if
		// the user picked another name, exit plan mode, queue the synthetic
		// approved-prompt for the next turn.
		let finalContent = planContent;
		if (typeof userResponse.editedContent === "string") {
			await this.#writePlanFile(planFilePath, userResponse.editedContent);
			finalContent = userResponse.editedContent;
		}

		const finalPlanFilePath = sanitizeFinalPath(userResponse.finalPath) ?? planFilePath;
		if (finalPlanFilePath !== planFilePath) {
			await this.#movePlanFile(planFilePath, finalPlanFilePath);
		}

		this.#broadcast({
			type: "plan_proposal_resolved",
			sessionId: this.sessionId,
			proposalId,
			outcome: "approved",
		});

		await this.exit("approved");

		this.session.setPlanReferencePath(finalPlanFilePath);
		this.session.markPlanReferenceSent();
		const approvedPrompt = renderApprovedPrompt({
			planContent: finalContent,
			planFilePath: finalPlanFilePath,
		});

		// Fire-and-forget: the `xd://propose` write is still in flight at
		// this point (we haven't returned yet), so the SDK queues the prompt
		// as followUp and fires it once the current turn ends. The
		// `synthetic` flag is intentionally absent — the SDK's queue path
		// doesn't preserve it; we accept the resulting user-role bubble so
		// the user sees a visible "execute" handoff.
		void this.session
			.prompt(approvedPrompt, { streamingBehavior: "followUp" })
			.catch((err) => {
				log.warn(`synthetic approved-plan prompt failed for ${this.sessionId}`, err);
			});

		return {
			content: [
				{
					type: "text" as const,
					text: `Plan approved. Executing from ${finalPlanFilePath}.`,
				},
			],
			details: {
				planFilePath: finalPlanFilePath,
				title: stripMdExtension(extractFileName(finalPlanFilePath)),
				planExists: true,
			},
		};
	}

	#localOptions() {
		return { getArtifactsDir: this.getArtifactsDir, getSessionId: this.getSessionId };
	}

	/** Rename for a user-chosen final path (the SDK 18 rename helper is gone).
	 *  Refuses to overwrite an existing file. */
	async #movePlanFile(from: string, to: string): Promise<void> {
		const fromPath = resolveLocalUrlToPath(from, this.#localOptions());
		const toPath = resolveLocalUrlToPath(to, this.#localOptions());
		const exists = await fs.access(toPath).then(
			() => true,
			() => false,
		);
		if (exists) {
			throw new ToolError(`Cannot rename plan to ${to}: a file already exists there.`);
		}
		await fs.rename(fromPath, toPath);
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const fsPath = resolveLocalUrlToPath(planFilePath, this.#localOptions());
		try {
			return await fs.readFile(fsPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async #writePlanFile(planFilePath: string, content: string): Promise<void> {
		const fsPath = resolveLocalUrlToPath(planFilePath, this.#localOptions());
		await fs.writeFile(fsPath, content, "utf-8");
	}

	#allocateProposalId(): string {
		const id = `pa_${this.sessionId}_${this.nextProposalCounter}`;
		this.nextProposalCounter += 1;
		return id;
	}
}

function renderApprovedPrompt(args: { planContent: string; planFilePath: string }): string {
	return PLAN_APPROVED_PROMPT_TEMPLATE.replaceAll("{{planFilePath}}", args.planFilePath).replaceAll(
		"{{planContent}}",
		args.planContent,
	);
}

/**
 * Validate a client-supplied override of the final plan path. Returns
 * `undefined` when the input is missing or shaped wrong; the caller falls
 * back to the SDK-suggested path. We deliberately don't throw — a malformed
 * `finalPath` shouldn't fail the whole approval; falling back to the
 * suggested path is the user-friendly default.
 */
function sanitizeFinalPath(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const trimmed = input.trim();
	if (!trimmed.startsWith("local://")) return undefined;
	// Strip the scheme and reject anything that has path separators or `..`
	// anywhere — must be a single safe filename, NOT a nested path or
	// traversal attempt. (Stripping then taking the basename would silently
	// "sanitize" `local://../escape.md` into `escape.md`; reject instead.)
	const remainder = trimmed.replace(/^local:\/+/, "");
	if (remainder.includes("/") || remainder.includes("\\")) return undefined;
	if (remainder.includes("..")) return undefined;
	if (!remainder.endsWith(".md")) return undefined;
	const stem = remainder.slice(0, -".md".length);
	if (stem.length === 0) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(stem)) return undefined;
	return `local://${remainder}`;
}

function extractFileName(localUrl: string): string {
	return localUrl.replace(/^local:\/+/, "").split(/[\\/]/).pop() ?? "";
}

function stripMdExtension(fileName: string): string {
	return fileName.replace(/\.md$/i, "");
}
