import { describe, expect, test } from "bun:test";

import { type ArgField, argFieldsFromSchema, argText, coerceArgText, parseArgsJson, withArg } from "./mcp-args-form";

describe("argFieldsFromSchema", () => {
	test("primitive props become fields with required flags and descriptions", () => {
		expect(
			argFieldsFromSchema({
				type: "object",
				required: ["query"],
				properties: {
					query: { type: "string", description: "Gmail search query" },
					page_size: { type: "integer" },
					ratio: { type: "number" },
					unread: { type: "boolean" },
				},
			}),
		).toEqual([
			{ name: "query", kind: "string", required: true, description: "Gmail search query" },
			{ name: "page_size", kind: "integer", required: false },
			{ name: "ratio", kind: "number", required: false },
			{ name: "unread", kind: "boolean", required: false, options: [true, false] },
		]);
	});

	test("enum becomes a choice field; null choices drop, non-primitive choices skip the field", () => {
		expect(
			argFieldsFromSchema({
				properties: {
					order: { type: "string", enum: ["asc", "desc", null] },
					weird: { enum: [{ a: 1 }] },
					empty: { enum: [] },
				},
			}),
		).toEqual([{ name: "order", kind: "enum", required: false, options: ["asc", "desc"] }]);
	});

	test("objects, arrays, unknown and missing types stay out", () => {
		expect(
			argFieldsFromSchema({
				properties: {
					meta: { type: "object" },
					to: { type: "array", items: { type: "string" } },
					any: {},
					union: { anyOf: [{ type: "string" }, { type: "number" }] },
					bad: "string",
				},
			}),
		).toEqual([]);
	});

	test("nullable forms unwrap; the outer description wins", () => {
		expect(
			argFieldsFromSchema({
				properties: {
					a: { type: ["integer", "null"] },
					b: { anyOf: [{ type: "string", description: "inner" }, { type: "null" }], description: "outer" },
					c: { anyOf: [{ type: "boolean", description: "inner" }, { type: "null" }] },
				},
			}),
		).toEqual([
			{ name: "a", kind: "integer", required: false },
			{ name: "b", kind: "string", required: false, description: "outer" },
			{ name: "c", kind: "boolean", required: false, description: "inner", options: [true, false] },
		]);
	});

	test("non-object schema or properties yield nothing", () => {
		expect(argFieldsFromSchema(undefined)).toEqual([]);
		expect(argFieldsFromSchema("x")).toEqual([]);
		expect(argFieldsFromSchema({ type: "object" })).toEqual([]);
	});
});

describe("coerceArgText", () => {
	const str: ArgField = { name: "q", kind: "string", required: false };
	const num: ArgField = { name: "n", kind: "number", required: false };
	const int: ArgField = { name: "i", kind: "integer", required: true };
	const bool: ArgField = { name: "b", kind: "boolean", required: false, options: [true, false] };
	const en: ArgField = { name: "e", kind: "enum", required: false, options: ["a", 2] };

	test("empty text removes the key, except a required string keeps it", () => {
		expect(coerceArgText(str, "")).toBeUndefined();
		expect(coerceArgText(int, "")).toBeUndefined();
		expect(coerceArgText({ ...str, required: true }, "")).toBe("");
	});

	test("numeric text becomes a number; templates and partial input stay strings", () => {
		expect(coerceArgText(num, "1.5")).toBe(1.5);
		expect(coerceArgText(int, "-3")).toBe(-3);
		expect(coerceArgText(int, "{{ steps.a.json.n }}")).toBe("{{ steps.a.json.n }}");
		expect(coerceArgText(num, "1.")).toBe("1.");
		expect(coerceArgText(num, "-")).toBe("-");
		expect(coerceArgText(num, "007")).toBe("007");
		expect(coerceArgText(num, "Infinity")).toBe("Infinity");
	});

	test("choice text maps back to the matching option, else stays a string", () => {
		expect(coerceArgText(bool, "true")).toBe(true);
		expect(coerceArgText(bool, "{{ state.flag }}")).toBe("{{ state.flag }}");
		expect(coerceArgText(en, "2")).toBe(2);
		expect(coerceArgText(en, "b")).toBe("b");
	});

	test("string fields keep text as typed", () => {
		expect(coerceArgText(str, "42")).toBe("42");
	});
});

describe("argText", () => {
	test("strings as-is, unset empty, others as JSON", () => {
		expect(argText("x")).toBe("x");
		expect(argText(undefined)).toBe("");
		expect(argText(50)).toBe("50");
		expect(argText(false)).toBe("false");
	});
});

describe("withArg", () => {
	test("sets or removes without mutating", () => {
		const args = { a: 1 };
		expect(withArg(args, "b", "x")).toEqual({ a: 1, b: "x" });
		expect(withArg(args, "a", undefined)).toEqual({});
		expect(args).toEqual({ a: 1 });
	});
});

describe("parseArgsJson", () => {
	test("object parses; blank is no args", () => {
		expect(parseArgsJson('{ "q": "is:unread" }')).toEqual({ args: { q: "is:unread" } });
		expect(parseArgsJson("  \n")).toEqual({ args: {} });
	});

	test("invalid JSON and non-objects return an error", () => {
		expect(parseArgsJson("{ q: 1 }")).toHaveProperty("error");
		expect(parseArgsJson("[1]")).toEqual({ error: "args must be a JSON object" });
		expect(parseArgsJson("null")).toEqual({ error: "args must be a JSON object" });
	});
});
