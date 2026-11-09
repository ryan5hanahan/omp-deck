import { describe, expect, it } from "bun:test";

import { REDACTED, scrubbableValues, scrubSecrets, splitEnv } from "./secrets.ts";

describe("routine secrets", () => {
	it("moves sensitive env vars out of env into secrets", () => {
		const { env, secrets } = splitEnv({
			ANTHROPIC_API_KEY: "sk-ant-abcdef123456",
			TELEGRAM_BOT_TOKEN: "123:telegram-token",
			DECK_INTERNAL_RUNNER_SECRET: "x".repeat(40),
			TELEGRAM_ALLOWED_USERS: "42",
			TZ: "UTC",
			PATH: "/usr/bin",
		});
		expect(Object.keys(secrets).sort()).toEqual(
			["ANTHROPIC_API_KEY", "DECK_INTERNAL_RUNNER_SECRET", "TELEGRAM_BOT_TOKEN"].sort(),
		);
		expect(env).toEqual({ TELEGRAM_ALLOWED_USERS: "42", TZ: "UTC", PATH: "/usr/bin" });
	});

	it("scrubs secret values from nested step results without mutating the input", () => {
		const values = scrubbableValues({ A: "sk-ant-abcdef123456", B: "short" });
		const result = {
			stdoutExcerpt: "key=sk-ant-abcdef123456\n",
			json: { headers: ["Bearer sk-ant-abcdef123456"], n: 3 },
			error: undefined,
		};
		const scrubbed = scrubSecrets(result, values);
		expect(scrubbed.stdoutExcerpt).toBe(`key=${REDACTED}\n`);
		expect(scrubbed.json).toEqual({ headers: [`Bearer ${REDACTED}`], n: 3 });
		expect(result.stdoutExcerpt).toContain("sk-ant");
		// Values under the minimum length are left alone.
		expect(values).toEqual(["sk-ant-abcdef123456"]);
	});

	it("redacts the longer of two overlapping secrets fully", () => {
		const values = scrubbableValues({ A: "abcdefgh", B: "abcdefgh-longer" });
		expect(scrubSecrets("x abcdefgh-longer y", values)).toBe(`x ${REDACTED} y`);
	});
});
