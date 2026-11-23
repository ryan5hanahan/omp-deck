import type { RoutineStep } from "@omp-deck/protocol";

type AgentStep = Extract<RoutineStep, { type: "agent" }>;

export type AllowlistKey = "skills_allowed" | "mcp_servers_allowed" | "tools_allowed";

/**
 * `step` with one allowlist replaced. `undefined` omits the key (unrestricted);
 * any array restricts, and `[]` means none allowed, so an empty list must never collapse to omitted.
 */
export function withAllowlist(step: AgentStep, key: AllowlistKey, list: string[] | undefined): AgentStep {
	const next = { ...step };
	if (list === undefined) delete next[key];
	else next[key] = list;
	return next;
}

/** Helper text under an allowlist; `unrestricted` says what omitting the key means for this list. */
export function allowlistHint(list: string[] | undefined, unrestricted: string): string | undefined {
	if (list === undefined) return unrestricted;
	return list.length === 0 ? "none allowed" : undefined;
}
