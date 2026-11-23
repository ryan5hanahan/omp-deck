import { describe, expect, test } from "bun:test";

import { formatDurationMs } from "./utils";

describe("formatDurationMs", () => {
	test("rounds fractional sub-second values", () => {
		expect(formatDurationMs(732.5444580000185)).toBe("733ms");
		expect(formatDurationMs(732.544)).toBe("733ms");
		expect(formatDurationMs(0)).toBe("0ms");
		expect(formatDurationMs(999.6)).toBe("1.0s");
	});

	test("seconds and minutes branches", () => {
		expect(formatDurationMs(1_500)).toBe("1.5s");
		expect(formatDurationMs(59_000)).toBe("59.0s");
		expect(formatDurationMs(125_000)).toBe("2m 5s");
	});

	test("invalid input renders a dash", () => {
		expect(formatDurationMs(-1)).toBe("—");
		expect(formatDurationMs(Number.NaN)).toBe("—");
		expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("—");
	});
});
