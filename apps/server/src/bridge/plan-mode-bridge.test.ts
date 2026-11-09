/**
 * PlanModeBridge tests — Slice A of T-105 (plan mode in deck).
 *
 * Exercises the per-session plan-mode state machine end-to-end without
 * spinning up a real `AgentSession`. The session-facing surface is small
 * enough that a hand-rolled stub captures it cleanly; the SDK helpers we
 * compose (`resolveApprovedPlan`, `listPlanFiles`, `local://` resolver)
 * run against a real temporary artifacts directory so the rename +
 * file-read paths exercise actual filesystem behavior.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ServerFrame } from "@omp-deck/protocol";

import { PlanModeBridge, type PlanModeFrame, type PlanModeSessionSurface } from "./plan-mode-bridge.ts";

type PromptCall = {
	text: string;
	options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" };
};

type ProposalHandler = Parameters<PlanModeSessionSurface["setPlanProposalHandler"]>[0] & {};

class StubSession implements PlanModeSessionSurface {
	private activeTools: string[];
	planModeStateCalls: Array<
		{ enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined
	> = [];
	proposalHandlerCalls: Array<ProposalHandler | null> = [];
	proposalHandler: ProposalHandler | null = null;
	planReferencePaths: string[] = [];
	markPlanReferenceSentCount = 0;
	promptCalls: PromptCall[] = [];
	setActiveToolsCalls: string[][] = [];
	isStreaming = true;

	constructor(initialTools: string[] = ["read", "search", "find", "lsp", "web_search", "edit"]) {
		this.activeTools = [...initialTools];
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		this.activeTools = [...toolNames];
		this.setActiveToolsCalls.push([...toolNames]);
	}

	setPlanModeState(
		state: { enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined,
	): void {
		this.planModeStateCalls.push(state);
	}

	setPlanProposalHandler(handler: ProposalHandler | null): void {
		this.proposalHandlerCalls.push(handler);
		this.proposalHandler = handler;
	}

	setPlanReferencePath(path: string): void {
		this.planReferencePaths.push(path);
	}

	markPlanReferenceSent(): void {
		this.markPlanReferenceSentCount += 1;
	}

	async prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<boolean> {
		this.promptCalls.push({ text, ...(options ? { options } : {}) });
		return true;
	}
}

function collect(bridge: PlanModeBridge): { frames: PlanModeFrame[]; unsub: () => void } {
	const frames: PlanModeFrame[] = [];
	const unsub = bridge.subscribeFrames((frame) => {
		frames.push(frame);
	});
	return { frames, unsub };
}

type ProposalResult = {
	content: Array<{ type: "text"; text: string }>;
	details: { planFilePath: string; title: string; planExists: boolean };
};

interface Harness {
	dir: string;
	planFile: string;
	session: StubSession;
	bridge: PlanModeBridge;
	frames: PlanModeFrame[];
	openFrames: ServerFrame[]; // for assertions on the wire-level types
	cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-mode-bridge-test-"));
	// The SDK's `local://` resolver scopes paths to `<artifactsDir>/local/`.
	const localDir = path.join(dir, "local");
	await fs.mkdir(localDir, { recursive: true });
	const session = new StubSession();
	const bridge = new PlanModeBridge({
		sessionId: "s_test",
		session,
		getArtifactsDir: () => dir,
		getSessionId: () => "s_test",
	});
	const { frames } = collect(bridge);
	return {
		dir,
		planFile: path.join(localDir, "PLAN.md"),
		session,
		bridge,
		frames,
		openFrames: frames as unknown as ServerFrame[],
		async cleanup() {
			// Await the exit so the bridge's internal awaits drain before the
			// next test starts — `dispose()` fires `void exit()` which is fine
			// for real shutdown but leaks microtasks under bun's fast loop.
			await bridge.exit("session_disposed");
			bridge.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/** Simulate the agent writing `title` to `xd://propose`. */
async function invokePropose(h: Harness, title = ""): Promise<{
	resultPromise: Promise<ProposalResult>;
}> {
	expect(h.session.proposalHandler).not.toBeNull();
	const handler = h.session.proposalHandler!;
	const resultPromise = handler(title) as Promise<ProposalResult>;
	// Don't let bun flag this as an unhandled rejection while the caller is
	// still chaining off it — the test attaches its own assertions later.
	resultPromise.catch(() => {});
	// Poll on hasPendingApproval. Real timers (not setImmediate) — bun's
	// test loop can starve the fs.promises pool under microtask-only yields,
	// leaving the broadcast pending until after the test has already failed.
	const deadline = Date.now() + 2000;
	while (!h.bridge.hasPendingApproval() && Date.now() < deadline) {
		await new Promise<void>((r) => setTimeout(r, 1));
	}
	return { resultPromise };
}

describe("PlanModeBridge", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness();
	});

	afterEach(async () => {
		await harness.cleanup();
	});

	it("enter() snapshots tools, splices in write, and broadcasts plan_mode_changed", async () => {
		const previousTools = harness.session.getActiveToolNames();
		expect(previousTools.includes("write")).toBe(false);

		await harness.bridge.enter();

		expect(harness.session.getActiveToolNames()).toEqual([...previousTools, "write"]);
		expect(harness.session.planModeStateCalls).toEqual([
			{ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" },
		]);
		expect(harness.session.proposalHandler).toBeTypeOf("function");
		expect(harness.frames).toEqual([
			{
				type: "plan_mode_changed",
				sessionId: "s_test",
				enabled: true,
				planFilePath: "local://PLAN.md",
			},
		]);
		expect(harness.bridge.isEnabled()).toBe(true);
		expect(harness.bridge.getPlanModeContext()).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
		});
	});

	it("enter() is idempotent — second call is a no-op", async () => {
		await harness.bridge.enter();
		const framesAfterFirst = harness.frames.length;
		const stateCallsAfterFirst = harness.session.planModeStateCalls.length;

		await harness.bridge.enter();

		expect(harness.frames.length).toBe(framesAfterFirst);
		expect(harness.session.planModeStateCalls.length).toBe(stateCallsAfterFirst);
	});

	it("does not duplicate write when it is already in the active tool set", async () => {
		const session = new StubSession(["read", "write"]);
		const bridge = new PlanModeBridge({
			sessionId: "s_with_write",
			session,
			getArtifactsDir: () => harness.dir,
			getSessionId: () => "s_with_write",
		});
		await bridge.enter();
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		bridge.dispose();
	});

	it("exit() restores tools, clears SDK state, broadcasts off, and is idempotent", async () => {
		await harness.bridge.enter();
		const previousTools = harness.session
			.getActiveToolNames()
			.filter((t) => t !== "write");
		await harness.bridge.exit("user_cancelled");

		expect(harness.session.getActiveToolNames()).toEqual(previousTools);
		expect(harness.session.proposalHandler).toBeNull();
		// First non-undefined state was the enter state; second was undefined on exit.
		expect(harness.session.planModeStateCalls.at(-1)).toBeUndefined();
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: false,
		});
		expect(harness.bridge.isEnabled()).toBe(false);

		// Second exit is a no-op.
		const framesAfter = harness.frames.length;
		await harness.bridge.exit("user_cancelled");
		expect(harness.frames.length).toBe(framesAfter);
	});

	it("propose throws a ToolError when plan-mode is no longer active", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		// Toggle off the SDK-tracked state directly to simulate a race
		// (the bridge `enabled` flag was set by enter() above).
		harness.session.planModeStateCalls.push(undefined);
		await harness.bridge.exit("user_cancelled");

		const handler = harness.session.proposalHandlerCalls.find((h) => h !== null) ?? null;
		expect(handler).not.toBeNull();
		await expect(handler!("ready")).rejects.toThrow(/plan mode/i);
	});

	it("propose throws a ToolError when the plan file is missing", async () => {
		await harness.bridge.enter();
		// No PLAN.md written.
		const handler = harness.session.proposalHandler!;
		await expect(handler("ready")).rejects.toThrow(/Plan file not found/i);
	});

	it("approve happy path: broadcasts proposal, keeps the plan file, restores tools, queues followUp", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# My feature\n\nDo a thing.\n");

		const initialFrameCount = harness.frames.length;
		const { resultPromise } = await invokePropose(harness, "My feature");

		// Proposal broadcast should have arrived inside the handler.
		const proposedFrame = harness.frames.find((f) => f.type === "plan_proposed");
		expect(proposedFrame).toBeDefined();
		const proposed = proposedFrame as Extract<PlanModeFrame, { type: "plan_proposed" }>;
		expect(proposed.suggestedTitle).toBe("My-feature");
		// SDK 18 never renames: the suggested path is the plan the agent wrote.
		expect(proposed.suggestedFinalPath).toBe("local://PLAN.md");
		expect(proposed.planContent).toMatch(/Do a thing/);

		// Pending approval is exposed for snapshot replay.
		const pending = harness.bridge.getPendingPlanApproval();
		expect(pending?.proposalId).toBe(proposed.proposalId);
		const replay = harness.bridge.getReplayFrames();
		expect(replay.map((f) => f.type as string).sort()).toEqual(
			["plan_mode_changed", "plan_proposed"].sort(),
		);

		// User clicks Approve.
		const outcome = harness.bridge.respond(proposed.proposalId, { approved: true });
		expect(outcome).toBe("settled");

		const result = await resultPromise;
		expect(result.details.planFilePath).toBe("local://PLAN.md");
		expect(result.details.planExists).toBe(true);

		// File left in place.
		await expect(fs.access(harness.planFile)).resolves.toBeNull();

		// Tools restored.
		const lastSet = harness.session.setActiveToolsCalls.at(-1);
		expect(lastSet?.includes("write")).toBe(false);

		// Proposal handler cleared.
		expect(harness.session.proposalHandler).toBeNull();

		// Plan mode exited.
		expect(harness.bridge.isEnabled()).toBe(false);
		expect(harness.bridge.hasPendingApproval()).toBe(false);

		// Synthetic execute-prompt queued as followUp.
		expect(harness.session.promptCalls.length).toBe(1);
		const queued = harness.session.promptCalls[0]!;
		expect(queued.text).toMatch(/^Plan approved\./);
		expect(queued.text).toMatch(/<plan path="local:\/\/PLAN\.md">/);
		expect(queued.text).toMatch(/Do a thing/);
		expect(queued.options?.streamingBehavior).toBe("followUp");

		// Plan reference pinned, and marked sent by the synthetic prompt.
		expect(harness.session.planReferencePaths).toEqual(["local://PLAN.md"]);
		expect(harness.session.markPlanReferenceSentCount).toBe(1);

		// Resolved frame broadcast.
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: false,
		});
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> =>
				f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("approved");
		// And there were strictly more frames after approval than before.
		expect(harness.frames.length).toBeGreaterThan(initialFrameCount);
	});

	it("approve with edited content writes it back to the plan file", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Orig\n");

		const { resultPromise } = await invokePropose(harness, "Edited plan");
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		harness.bridge.respond(proposed.proposalId, {
			approved: true,
			editedContent: "# Replaced\n\nNew body.\n",
		});
		await resultPromise;

		const written = await fs.readFile(harness.planFile, "utf-8");
		expect(written).toBe("# Replaced\n\nNew body.\n");
		expect(harness.session.promptCalls[0]!.text).toMatch(/New body\./);
	});

	it("approve honors a sanitized client-supplied finalPath", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Whatever\n");

		const { resultPromise } = await invokePropose(harness);
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		harness.bridge.respond(proposed.proposalId, {
			approved: true,
			finalPath: "local://custom_name.md",
		});
		const result = await resultPromise;
		expect(result.details.planFilePath).toBe("local://custom_name.md");
		await expect(fs.access(path.join(harness.dir, "local", "custom_name.md"))).resolves.toBeNull();
		await expect(fs.access(harness.planFile)).rejects.toThrow();
		expect(harness.session.planReferencePaths).toEqual(["local://custom_name.md"]);
	});

	it("approve refuses to rename over an existing file", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Whatever\n");
		await fs.writeFile(path.join(harness.dir, "local", "taken.md"), "keep me\n");

		const { resultPromise } = await invokePropose(harness);
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		harness.bridge.respond(proposed.proposalId, { approved: true, finalPath: "local://taken.md" });

		await expect(resultPromise).rejects.toThrow(/already exists/);
		expect(await fs.readFile(path.join(harness.dir, "local", "taken.md"), "utf-8")).toBe("keep me\n");
		await expect(fs.access(harness.planFile)).resolves.toBeNull();
	});

	it("approve falls back to suggested path when finalPath fails sanitization", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n");

		const { resultPromise } = await invokePropose(harness, "fallback case");
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		// `..` path-escape attempt; bridge must reject it and use the suggested path.
		harness.bridge.respond(proposed.proposalId, {
			approved: true,
			finalPath: "local://../escape.md",
		});
		const result = await resultPromise;
		expect(result.details.planFilePath).toBe("local://PLAN.md");
		await expect(fs.access(harness.planFile)).resolves.toBeNull();
	});

	it("reject path exits plan mode, broadcasts rejected resolution, and surfaces a rejection result", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Foo\n");

		const { resultPromise } = await invokePropose(harness);
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;
		harness.bridge.respond(proposed.proposalId, { approved: false });
		const result = await resultPromise;

		expect(result.content[0]!.text).toMatch(/User rejected the plan/i);
		expect(harness.bridge.isEnabled()).toBe(false);
		expect(harness.session.promptCalls.length).toBe(0);
		expect(harness.session.markPlanReferenceSentCount).toBe(0);
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> =>
				f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("rejected");
		// PLAN.md still exists (no rename on reject).
		await expect(fs.access(harness.planFile)).resolves.toBeNull();
	});

	it("respond() returns 'unknown' for stale / mismatched proposalIds (double-click safety)", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Hi\n");

		const { resultPromise } = await invokePropose(harness);
		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		)!;

		// Wrong id.
		expect(harness.bridge.respond("pa_bogus_99", { approved: true })).toBe("unknown");

		// Correct id wins.
		expect(harness.bridge.respond(proposed.proposalId, { approved: true })).toBe("settled");
		await resultPromise;

		// Second click on the same (now-resolved) id is unknown.
		expect(harness.bridge.respond(proposed.proposalId, { approved: true })).toBe("unknown");
	});

	it("exit() mid-approval rejects the pending promise so the proposal handler fails cleanly", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Hi\n");

		const { resultPromise } = await invokePropose(harness);
		expect(harness.bridge.hasPendingApproval()).toBe(true);

		await harness.bridge.exit("user_cancelled");

		await expect(resultPromise).rejects.toThrow(/cancelled|user/i);
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.bridge.isEnabled()).toBe(false);
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> =>
				f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("rejected");
	});

	it("dispose() while approval is pending rejects the promise and clears state", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Hi\n");
		const { resultPromise } = await invokePropose(harness);

		harness.bridge.dispose();
		await expect(resultPromise).rejects.toThrow(/abandoned|disposed/i);
		expect(harness.bridge.hasPendingApproval()).toBe(false);
	});

	it("snapshot replay frames cover both mode-changed and pending proposal", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n");

		// Before any proposal: only the mode-changed replay.
		expect(harness.bridge.getReplayFrames().map((f) => f.type)).toEqual(["plan_mode_changed"]);

		const { resultPromise } = await invokePropose(harness);
		const replay = harness.bridge.getReplayFrames();
		expect(replay.map((f) => f.type as string).sort()).toEqual(
			["plan_mode_changed", "plan_proposed"].sort(),
		);

		// Tear down without resolving so the test exits cleanly.
		harness.bridge.dispose();
		await expect(resultPromise).rejects.toThrow();
	});
});
