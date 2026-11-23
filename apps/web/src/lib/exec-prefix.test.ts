import { describe, expect, test } from "bun:test";

import { parseExecPrefix } from "./exec-prefix";

describe("parseExecPrefix", () => {
	test("bash: ! runs, !! excludes from context", () => {
		expect(parseExecPrefix("!ls")).toEqual({ lang: "bash", code: "ls", excludeFromContext: false });
		expect(parseExecPrefix("!!ls")).toEqual({ lang: "bash", code: "ls", excludeFromContext: true });
	});

	test("python: $ and $$ need whitespace after the sigil", () => {
		expect(parseExecPrefix("$ x")).toEqual({ lang: "python", code: "x", excludeFromContext: false });
		expect(parseExecPrefix("$$ x")).toEqual({ lang: "python", code: "x", excludeFromContext: true });
		expect(parseExecPrefix("$HOME")).toBeNull();
	});

	test("single $ before a pasted shell prompt stays prose", () => {
		expect(parseExecPrefix("$ git status")).toBeNull();
		expect(parseExecPrefix("$ echo hi | wc")).toBeNull();
		expect(parseExecPrefix("$$ git status")).toEqual({ lang: "python", code: "git status", excludeFromContext: true });
	});

	test("a sigil with nothing after it is prose", () => {
		expect(parseExecPrefix("!")).toBeNull();
		expect(parseExecPrefix("!  ")).toBeNull();
		expect(parseExecPrefix("$")).toBeNull();
	});
});
