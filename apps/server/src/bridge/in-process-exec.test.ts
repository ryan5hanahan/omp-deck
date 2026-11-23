/**
 * Composer `!` / `$` execution on InProcessSessionHandle, against a stub
 * session exposing only the SDK's executeBash / executePython surface.
 */
import { describe, expect, test } from "bun:test";

import { InProcessSessionHandle } from "./in-process.ts";

type ExecOpts = { excludeFromContext?: boolean; onRecorded?: (message: unknown) => void };
type Run = (code: string, onChunk: (chunk: string) => void, opts: ExecOpts) => Promise<unknown>;

class StubSession {
	isBashRunning = false;
	isEvalRunning = false;
	calls: { lang: "bash" | "python"; code: string; opts: ExecOpts }[] = [];
	aborted: string[] = [];
	run: Run = async (code, onChunk, opts) => {
		onChunk("out\n");
		opts.onRecorded?.({ role: "bashExecution", command: code, output: "out\n", exitCode: 0, timestamp: 1 });
	};

	executeBash(code: string, onChunk: (chunk: string) => void, opts: ExecOpts): Promise<unknown> {
		this.calls.push({ lang: "bash", code, opts });
		return this.run(code, onChunk, opts);
	}
	executePython(code: string, onChunk: (chunk: string) => void, opts: ExecOpts): Promise<unknown> {
		this.calls.push({ lang: "python", code, opts });
		return this.run(code, onChunk, opts);
	}
	abortBash(): void {
		this.aborted.push("bash");
	}
	abortEval(): void {
		this.aborted.push("eval");
	}
}

type Ev = { type: string; execId?: string; message?: unknown; chunk?: string; error?: string };

function makeHandle(): { handle: InProcessSessionHandle; session: StubSession; emitted: Ev[] } {
	const session = new StubSession();
	const emitted: Ev[] = [];
	const handle = new InProcessSessionHandle({
		session: session as unknown as never,
		sessionManager: {} as never,
		cwd: "/tmp/stub",
		sessionId: "stub-1",
		getModelRegistry: async () => ({}) as never,
		planBridge: { dispose() {}, getPlanModeContext: () => undefined, getPendingPlanApproval: () => undefined } as never,
		onDispose: () => {},
	});
	handle.subscribe((ev) => emitted.push(ev as Ev));
	return { handle, session, emitted };
}

describe("InProcessSessionHandle.execute", () => {
	test("bash: exec_start → exec_chunk → message_start/message_end with the recorded message", async () => {
		const { handle, session, emitted } = makeHandle();
		await handle.execute("bash", "ls", { excludeFromContext: true });
		expect(emitted.map((e) => e.type)).toEqual(["exec_start", "exec_chunk", "message_start", "message_end"]);
		const execId = emitted[0]!.execId;
		expect(execId).toBeString();
		expect(emitted.every((e) => e.execId === execId)).toBe(true);
		expect(emitted[1]!.chunk).toBe("out\n");
		expect(emitted[3]!.message).toMatchObject({ role: "bashExecution", command: "ls", exitCode: 0 });
		expect(emitted[2]!.message).toBe(emitted[3]!.message);
		expect(session.calls).toHaveLength(1);
		expect(session.calls[0]).toMatchObject({ lang: "bash", code: "ls", opts: { excludeFromContext: true } });
		// Never routes through the user's shell or a PTY.
		expect(Object.keys(session.calls[0]!.opts).sort()).toEqual(["excludeFromContext", "onRecorded"]);
	});

	test("python path calls executePython", async () => {
		const { handle, session, emitted } = makeHandle();
		await handle.execute("python", "print(1)", { excludeFromContext: false });
		expect(session.calls.map((c) => c.lang)).toEqual(["python"]);
		expect(emitted.at(-1)!.type).toBe("message_end");
	});

	test("refuses while a bash command or Python execution is running", async () => {
		for (const flag of ["isBashRunning", "isEvalRunning"] as const) {
			const { handle, session, emitted } = makeHandle();
			session[flag] = true;
			await handle.execute("bash", "ls", { excludeFromContext: false });
			expect(emitted.map((e) => e.type)).toEqual(["exec_start", "exec_error"]);
			expect(emitted[1]!.execId).toBe(emitted[0]!.execId);
			expect(session.calls).toHaveLength(0);
		}
	});

	test("a throw before recording ends with exactly one exec_error", async () => {
		const { handle, session, emitted } = makeHandle();
		session.run = async () => {
			throw new Error("kernel unavailable");
		};
		await handle.execute("python", "x", { excludeFromContext: false });
		expect(emitted.map((e) => e.type)).toEqual(["exec_start", "exec_error"]);
		expect(emitted[1]!.error).toBe("kernel unavailable");
	});

	test("resolving without onRecorded emits exec_error; a throw after recording emits nothing more", async () => {
		const silent = makeHandle();
		silent.session.run = async () => undefined;
		await silent.handle.execute("bash", "ls", { excludeFromContext: false });
		expect(silent.emitted.map((e) => e.type)).toEqual(["exec_start", "exec_error"]);

		const late = makeHandle();
		late.session.run = async (_code, _onChunk, opts) => {
			opts.onRecorded?.({ role: "bashExecution", timestamp: 2 });
			throw new Error("late");
		};
		await late.handle.execute("bash", "ls", { excludeFromContext: false });
		expect(late.emitted.map((e) => e.type)).toEqual(["exec_start", "message_start", "message_end"]);
	});

	test("abortExec aborts whichever execution is running", async () => {
		const { handle, session } = makeHandle();
		await handle.abortExec();
		expect(session.aborted).toEqual([]);
		session.isBashRunning = true;
		await handle.abortExec();
		session.isBashRunning = false;
		session.isEvalRunning = true;
		await handle.abortExec();
		expect(session.aborted).toEqual(["bash", "eval"]);
	});
});
