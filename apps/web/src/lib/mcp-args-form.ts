/** Schema → generated-input helpers for the routine `mcp` step form (V1.5 F3). */

export type ArgFieldKind = "string" | "number" | "integer" | "boolean" | "enum";

export type ArgPrimitive = string | number | boolean;

/** One top-level primitive property of a tool's `inputSchema`. */
export interface ArgField {
	name: string;
	kind: ArgFieldKind;
	required: boolean;
	description?: string;
	/** The fixed choices of a `boolean` (`[true, false]`) or `enum` field. */
	options?: readonly ArgPrimitive[];
}

/** The JSON Schema keywords read here. Tool schemas come from arbitrary servers, so each keyword is checked before use. */
interface PropSchema {
	type?: unknown;
	enum?: unknown;
	anyOf?: unknown;
	description?: unknown;
}

function isPrimitive(v: unknown): v is ArgPrimitive {
	return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Unwraps the nullable forms Python MCP servers emit for optional params: `type: [T, "null"]` and `anyOf: [{…}, {type: "null"}]`. */
function unwrapNullable(prop: PropSchema): PropSchema {
	if (Array.isArray(prop.anyOf)) {
		const nonNull = prop.anyOf.filter((s) => (s as PropSchema | null)?.type !== "null");
		const only: unknown = nonNull.length === 1 ? nonNull[0] : undefined;
		if (typeof only !== "object" || only === null) return prop;
		const inner = only as PropSchema;
		return { ...inner, description: prop.description ?? inner.description };
	}
	if (Array.isArray(prop.type)) {
		const nonNull = prop.type.filter((t) => t !== "null");
		if (nonNull.length === 1) return { ...prop, type: nonNull[0] };
	}
	return prop;
}

/** Generated inputs for `schema`: primitive top-level properties only; objects, arrays and unknown types stay in the JSON textarea. */
export function argFieldsFromSchema(schema: unknown): ArgField[] {
	if (typeof schema !== "object" || schema === null) return [];
	const { properties, required } = schema as { properties?: unknown; required?: unknown };
	if (typeof properties !== "object" || properties === null) return [];
	const requiredNames = new Set(Array.isArray(required) ? required : []);
	const fields: ArgField[] = [];
	for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
		if (typeof raw !== "object" || raw === null) continue;
		const prop = unwrapNullable(raw as PropSchema);
		const base = {
			name,
			required: requiredNames.has(name),
			...(typeof prop.description === "string" ? { description: prop.description } : {}),
		};
		if (Array.isArray(prop.enum)) {
			if (!prop.enum.every((v) => v === null || isPrimitive(v))) continue;
			const options = prop.enum.filter(isPrimitive);
			if (options.length > 0) fields.push({ ...base, kind: "enum", options });
		} else if (prop.type === "boolean") {
			fields.push({ ...base, kind: "boolean", options: [true, false] });
		} else if (prop.type === "string" || prop.type === "number" || prop.type === "integer") {
			fields.push({ ...base, kind: prop.type });
		}
	}
	return fields;
}

/** The text a generated input shows for an arg value. */
export function argText(value: unknown): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The arg value for text typed into a generated input; `undefined` removes the key.
 * Templates and non-numeric text stay strings: `{{ … }}` renders on the server.
 */
export function coerceArgText(field: ArgField, text: string): unknown {
	// A required string may legitimately be empty; anything else empty means "not set".
	if (text === "") return field.required && field.kind === "string" ? "" : undefined;
	if (field.options) return field.options.find((o) => String(o) === text) ?? text;
	if (field.kind === "number" || field.kind === "integer") {
		const n = Number(text);
		// Only canonical numbers convert, so partial input like "1." or "-" stays text until it completes.
		return Number.isFinite(n) && String(n) === text ? n : text;
	}
	return text;
}

/** `args` with `name` set to `value`, or without `name` when `value` is `undefined`. */
export function withArg(args: Record<string, unknown>, name: string, value: unknown): Record<string, unknown> {
	const next = { ...args };
	if (value === undefined) delete next[name];
	else next[name] = value;
	return next;
}

/** Parses the args textarea: the object, or the message to show inline. Blank text means no args. */
export function parseArgsJson(text: string): { args: Record<string, unknown> } | { error: string } {
	if (text.trim() === "") return { args: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "args must be a JSON object" };
	}
	return { args: parsed as Record<string, unknown> };
}
