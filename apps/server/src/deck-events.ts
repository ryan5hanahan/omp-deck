/**
 * In-process deck event bus feeding routine `event` triggers (V1.5 F7).
 * Emitters: db/inbox.ts createInbox, db/tasks.ts moveTask (cross-column only),
 * RoutinesRunner.fireV1 (routine_finished), POST /api/events/telegram.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./log.ts";

const log = logger("deck-events");

export type DeckEventSource = "deck_inbox" | "deck_task" | "routine_finished" | "telegram";

/** The routine run an event was emitted from, if any. */
export interface DeckEventOrigin {
	routineId: string;
	chainDepth: number;
}

export interface DeckEvent {
	source: DeckEventSource;
	type: string;
	payload: Record<string, unknown>;
	origin?: DeckEventOrigin;
}

/** Set by RoutinesRunner.fireV1 around a pipeline run; events emitted inside it carry it as `origin`. */
export const routineRunScope = new AsyncLocalStorage<DeckEventOrigin>();

type Listener = (event: DeckEvent) => void;
const listeners = new Set<Listener>();

export function onDeckEvent(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function emitDeckEvent(source: DeckEventSource, type: string, payload: Record<string, unknown>): void {
	const event: DeckEvent = { source, type, payload, origin: routineRunScope.getStore() };
	for (const listener of listeners) {
		// emitters sit in db writes; a listener failure must never fail the write
		try {
			listener(event);
		} catch (err) {
			log.warn(`listener failed for ${source}/${type}`, err);
		}
	}
}
