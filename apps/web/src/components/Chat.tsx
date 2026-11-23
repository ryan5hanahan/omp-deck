import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useStore, selectActiveSession } from "@/lib/store";
import type { ExecMsg } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChatHeader } from "./chat/ChatHeader";
import { SessionPicker } from "./chat/SessionPicker";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { Notice } from "./messages/Notice";
import { CompactionLine } from "./messages/CompactionLine";
import { TtsrLine } from "./messages/TtsrLine";
import { IrcLine } from "./messages/IrcLine";
import { QueuedMessage } from "./messages/QueuedMessage";
import { PlanApproval } from "./messages/PlanApproval";
import { Pre } from "./tools/shared";

export function Chat() {
	const session = useStore(selectActiveSession);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickyRef = useRef(true);

	const messages = session?.messages ?? [];
	const toolCalls = session?.toolCalls ?? {};
	const queuedPrompts = session?.queuedPrompts ?? [];

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stickyRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, toolCalls, queuedPrompts]);

	function handleScroll(): void {
		const el = scrollRef.current;
		if (!el) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		stickyRef.current = fromBottom < 100;
	}

	// No active session — show the picker as the main pane instead of a
	// dead-end "go to sidebar" message.
	if (!session) {
		return <SessionPicker />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<ChatHeader />
			<div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-10">
					{messages.length === 0 ? (
						<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
							Empty session — send a prompt below.
						</div>
					) : null}

					{messages.map((m) => {
						if ("kind" in m) return <ExecCard key={m.id} msg={m} />;
						switch (m.role) {
							case "user":
								return <UserMessage key={m.id} msg={m} />;
							case "assistant":
								return <AssistantMessage key={m.id} msg={m} toolCalls={toolCalls} />;
							case "notice":
								return <Notice key={m.id} msg={m} />;
							case "compaction":
								return <CompactionLine key={m.id} msg={m} />;
							case "ttsr":
								return <TtsrLine key={m.id} msg={m} />;
							case "irc":
								return <IrcLine key={m.id} msg={m} />;
							default:
								return null;
						}
					})}

					{queuedPrompts.map((q) => (
						<QueuedMessage key={q.id} msg={q} />
					))}
					{session.pendingPlanApproval ? (
						<PlanApproval session={session} />
					) : null}
				</div>
			</div>
		</div>
	);
}

/** Composer `!` / `$` execution: command header, streamed output, exit code. */
function ExecCard({ msg }: { msg: ExecMsg }) {
	const sigil = (msg.lang === "bash" ? "!" : "$").repeat(msg.excludeFromContext ? 2 : 1);
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
				<span className="text-ink-2">{msg.lang}</span>
				{msg.status === "running" ? <Loader2 className="h-3 w-3 animate-spin text-accent" /> : null}
				{msg.exitCode !== undefined ? (
					<span
						className={cn(
							"rounded bg-paper-3 px-1 py-0.5 normal-case tracking-normal",
							msg.exitCode === 0 ? "text-ink-3" : "text-danger",
						)}
					>
						exit {msg.exitCode}
					</span>
				) : null}
				{msg.cancelled ? <span className="text-warn">· cancelled</span> : null}
				{msg.truncated ? <span className="text-ink-4">· truncated</span> : null}
				{msg.excludeFromContext ? <span className="text-thinking">· not sent to model</span> : null}
			</div>
			<div className="flex gap-2 font-mono text-xs">
				<span className="shrink-0 text-accent">{sigil}</span>
				<span className="whitespace-pre-wrap break-words text-ink">{msg.code}</span>
			</div>
			{msg.output ? <Pre>{msg.output}</Pre> : null}
			{msg.error ? (
				<div className="border-l-2 border-danger pl-3 font-mono text-xs text-danger">{msg.error}</div>
			) : null}
		</div>
	);
}
