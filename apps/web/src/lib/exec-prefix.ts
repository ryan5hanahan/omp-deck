import type { ExecLang } from "@omp-deck/protocol";

export interface ExecPrefix {
	lang: ExecLang;
	code: string;
	excludeFromContext: boolean;
}

// Copied from omp 19.1.0 `modes/controllers/input-controller.ts`, where the parser is module-private.
const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const OMP_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

function looksLikePastedShellPrompt(code: string): boolean {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return SHELL_PROMPT_COMMAND_RE.test(firstLine) || SHELL_PROMPT_OPERATOR_RE.test(firstLine) || OMP_STATUS_LINE_RE.test(code);
}

/**
 * `!cmd` / `!!cmd` → bash, `$ code` / `$$ code` → Python; the doubled sigil keeps the
 * result out of the model's context. Returns null for prose, including `$HOME` (no
 * whitespace after the sigil), a `$ ` pasted shell prompt, or a sigil with nothing after it.
 */
export function parseExecPrefix(text: string): ExecPrefix | null {
	const trimmed = text.trim();
	if (trimmed.startsWith("!")) {
		const excludeFromContext = trimmed.startsWith("!!");
		const code = trimmed.slice(excludeFromContext ? 2 : 1).trim();
		return code ? { lang: "bash", code, excludeFromContext } : null;
	}
	if (!trimmed.startsWith("$")) return null;
	const prefixLength = trimmed[1] === "$" ? 2 : 1;
	// Text is fully trimmed, so a whitespace sigil terminator guarantees non-empty code.
	if (!/^[ \t\n\r]/.test(trimmed.slice(prefixLength))) return null;
	const code = trimmed.slice(prefixLength).trim();
	if (prefixLength === 1 && looksLikePastedShellPrompt(code)) return null;
	return { lang: "python", code, excludeFromContext: prefixLength === 2 };
}
