/**
 * `mcp` step: deterministic call of one MCP server tool, no LLM involved.
 * Args are templated, validated against the tool's `inputSchema` from
 * `tools/list`, then sent with `tools/call`. The result's structured content
 * (or JSON text) becomes `steps.<id>.json`.
 *
 * No retries or timeouts here: a dropped call may already have run on the
 * server, the SDK owns the call deadline, and `on_failure: retry` covers the
 * rest.
 */

import { type RoutineStep, type ValidationResult, validateAgainstSchema } from "@omp-deck/protocol";
import { logger } from "../../log.ts";
import { deepRender } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";

const log = logger("routines-mcp");

const MAX_EXCERPT = 8 * 1024;

/** The slice of the deck MCP service an `mcp` step needs; tests inject a fake. */
export interface McpStepClient {
	listTools(
		server: string,
		signal?: AbortSignal,
	): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
	callTool(
		server: string,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown }>;
}

export async function executeMcpStep(
	step: Extract<RoutineStep, { type: "mcp" }>,
	context: RunContext,
	signal: AbortSignal,
	mcp: McpStepClient,
): Promise<StepResult> {
	const startedMs = Date.now();
	const label = `${step.server}/${step.tool}`;
	const fail = (error: string, status: "failed" | "aborted" = "failed"): StepResult => ({
		status,
		stdoutExcerpt: "",
		stderrExcerpt: "",
		error,
		durationMs: Date.now() - startedMs,
	});

	try {
		const args = deepRender(step.args ?? {}, context as unknown as Record<string, unknown>) as Record<
			string,
			unknown
		>;
		const tool = (await mcp.listTools(step.server, signal)).find((t) => t.name === step.tool);
		if (!tool) return fail(`unknown tool ${label}`);

		const argsError = validateArgs(tool.inputSchema, args, label);
		if (argsError) return fail(argsError);

		const result = await mcp.callTool(step.server, step.tool, args, signal);
		const texts = result.content.flatMap((block) =>
			block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		);
		const text = texts.join("\n");
		const stdoutExcerpt = text.length > MAX_EXCERPT ? text.slice(0, MAX_EXCERPT) + "\n…(truncated)" : text;
		if (result.isError) return fail(stdoutExcerpt || `${label} returned an error`);

		return {
			status: "success",
			stdoutExcerpt,
			stderrExcerpt: "",
			json: resultJson(result.structuredContent, texts[0], result.content),
			durationMs: Date.now() - startedMs,
		};
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), signal.aborted ? "aborted" : "failed");
	}
}

/** Error text when `args` violate the tool's input schema; undefined when valid or unvalidatable. */
function validateArgs(schema: unknown, args: Record<string, unknown>, label: string): string | undefined {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
	let result: ValidationResult;
	try {
		result = validateAgainstSchema(schema, args);
	} catch (err) {
		// A server's schema we can't compile shouldn't make its tool unusable.
		log.warn(`${label}: input schema did not compile, calling without validation`, err);
		return undefined;
	}
	if (result.valid) return undefined;
	const details = (result.errors ?? []).map((e) => `${e.path || "/"} ${e.message}`).join("; ");
	return `invalid args for ${label}: ${details}`;
}

function resultJson(structured: unknown, firstText: string | undefined, content: unknown): unknown {
	if (structured !== null && structured !== undefined) return structured;
	if (firstText !== undefined) {
		try {
			return JSON.parse(firstText);
		} catch {
			// Plain-text result: fall through to the raw content blocks.
		}
	}
	return content;
}
