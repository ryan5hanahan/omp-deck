import { describe, expect, test } from "bun:test";
import type { RoutineStep } from "@omp-deck/protocol";

import { allowlistHint, withAllowlist } from "./step-allowlist";

const base: Extract<RoutineStep, { type: "agent" }> = {
	id: "classify",
	type: "agent",
	prompt: "p",
	mcp_servers_allowed: [],
	tools_allowed: [],
};

describe("withAllowlist", () => {
	test("an empty list stays [] (none allowed), never omitted", () => {
		const next = withAllowlist({ ...base, skills_allowed: ["a"] }, "skills_allowed", []);
		expect(next.skills_allowed).toEqual([]);
		expect("skills_allowed" in next).toBe(true);
	});

	test("undefined omits only that key", () => {
		const next = withAllowlist(base, "tools_allowed", undefined);
		expect("tools_allowed" in next).toBe(false);
		expect(next.mcp_servers_allowed).toEqual([]);
	});

	test("sets a list without mutating the step", () => {
		expect(withAllowlist(base, "mcp_servers_allowed", ["gmail"]).mcp_servers_allowed).toEqual(["gmail"]);
		expect(base.mcp_servers_allowed).toEqual([]);
	});
});

describe("allowlistHint", () => {
	test("omitted shows the default, [] shows none allowed, a non-empty list shows nothing", () => {
		expect(allowlistHint(undefined, "all")).toBe("all");
		expect(allowlistHint([], "all")).toBe("none allowed");
		expect(allowlistHint(["read"], "all")).toBeUndefined();
	});
});
