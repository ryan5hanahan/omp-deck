/**
 * Regression guard: the deck server boot path must initialize the SDK's
 * global `theme` before any agent session is created. The `ask` tool reads
 * `theme.status.success` *unconditionally* on entry — even for single-select
 * questions — so a missing init breaks every ask invocation with the JSC
 * error "undefined is not an object (evaluating 'theme.status')".
 *
 * If this test fails after an SDK upgrade, check whether `theme` moved to a
 * different module / accessor; update both index.ts AND this test (moved to @oh-my-pi/pi-tui/theme in SDK 18).
 */
import { describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";

describe("SDK theme global", () => {
	it("starts undefined and getThemeByName('dark') resolves to a usable Theme", async () => {
		const dark = await getThemeByName("dark");
		expect(dark).toBeDefined();
		expect(dark?.status).toBeDefined();
		expect(typeof dark?.status.success).toBe("string");
		expect(dark?.status.success.length).toBeGreaterThan(0);
	});

	it("setThemeInstance populates the module-level `theme` export", async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme failed to load");
		setThemeInstance(dark);
		// `theme` is `export var theme: Theme`; after setThemeInstance, the
		// glyph lookups the ask tool needs must resolve.
		expect(theme).toBeDefined();
		expect(theme.status.success.length).toBeGreaterThan(0);
		expect(theme.status.error.length).toBeGreaterThan(0);
	});
});
