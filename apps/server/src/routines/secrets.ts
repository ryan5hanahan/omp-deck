/**
 * Keep server secrets out of `context.env` and out of everything a run records.
 *
 * - `splitEnv` partitions the server environment: sensitive keys (flagged in
 *   ENV_SCHEMA, or named like a credential) go to `context.secrets`, which
 *   templates can still use (`{{ secrets.X }}`) and the JS sandbox redacts;
 *   everything else stays in `context.env`.
 * - `scrubSecrets` replaces secret values in a step result before it is
 *   persisted, broadcast, or handed to later steps — so a secret that reaches
 *   output by any path (template, `echo $KEY` in a run step, an echoing HTTP
 *   API) is recorded as `[REDACTED]`.
 *
 * `run` / `agent` subprocesses still inherit the real environment: shell
 * commands run as the user, and `omp -p` needs its provider keys.
 */
import { ENV_SCHEMA_BY_KEY } from "../env-schema.ts";

const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|PRIVATE/i;

// ponytail: shorter secret values aren't scrubbed — replacing e.g. "true"
// everywhere would mangle output. Raise if short secrets show up.
const MIN_SCRUB_LENGTH = 8;

export const REDACTED = "[REDACTED]";

export function isSecretEnvKey(key: string): boolean {
	return ENV_SCHEMA_BY_KEY.get(key)?.sensitive === true || SECRET_NAME_RE.test(key);
}

export function splitEnv(env: NodeJS.ProcessEnv): {
	env: Record<string, string>;
	secrets: Record<string, string>;
} {
	const out = { env: {} as Record<string, string>, secrets: {} as Record<string, string> };
	for (const [k, v] of Object.entries(env)) {
		if (typeof v !== "string") continue;
		(isSecretEnvKey(k) ? out.secrets : out.env)[k] = v;
	}
	return out;
}

/** Secret values worth scrubbing, longest first so overlapping values redact fully. */
export function scrubbableValues(secrets: Record<string, string>): string[] {
	return [...new Set(Object.values(secrets))]
		.filter((v) => v.length >= MIN_SCRUB_LENGTH)
		.sort((a, b) => b.length - a.length);
}

/** Deep-copy `value`, replacing every occurrence of a secret in any string. */
export function scrubSecrets<T>(value: T, values: readonly string[]): T {
	if (values.length === 0) return value;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			let s = v;
			for (const secret of values) if (s.includes(secret)) s = s.replaceAll(secret, REDACTED);
			return s;
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
		}
		return v;
	};
	return walk(value) as T;
}
