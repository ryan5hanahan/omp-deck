import { describe, expect, it } from "bun:test";

import { buildAllowedHosts, rejectReason } from "./request-guard.ts";

const hosts = buildAllowedHosts("127.0.0.1", ["mybox.tailnet.ts.net"]);
const req = (url: string, origin?: string) =>
	new Request(url, origin === undefined ? {} : { headers: { origin } });

describe("request guard", () => {
	it("allows loopback with no Origin (curl, bridges, routine http steps)", () => {
		expect(rejectReason(req("http://127.0.0.1:8787/api/health"), hosts)).toBeUndefined();
		expect(rejectReason(req("http://localhost:8787/ws"), hosts)).toBeUndefined();
		expect(rejectReason(req("http://[::1]:8787/api/tasks"), hosts)).toBeUndefined();
	});

	it("allows the Vite dev origin and configured extra hosts", () => {
		expect(rejectReason(req("http://127.0.0.1:8787/ws", "http://127.0.0.1:5173"), hosts)).toBeUndefined();
		expect(
			rejectReason(req("https://mybox.tailnet.ts.net/api/tasks", "https://MyBox.tailnet.ts.net"), hosts),
		).toBeUndefined();
	});

	it("rejects a foreign Origin (CSRF / cross-site WebSocket)", () => {
		expect(rejectReason(req("http://127.0.0.1:8787/ws", "https://evil.example"), hosts)).toMatch(/origin/);
		expect(rejectReason(req("http://127.0.0.1:8787/api/routines", "null"), hosts)).toMatch(/origin/);
		// Lookalike suffix must not match.
		expect(rejectReason(req("http://127.0.0.1:8787/ws", "http://127.0.0.1.evil.example"), hosts)).toMatch(/origin/);
	});

	it("rejects a foreign Host (DNS rebinding)", () => {
		expect(rejectReason(req("http://evil.example:8787/api/kb/file"), hosts)).toMatch(/host/);
	});

	it("does not treat a wildcard bind host as an allowed name", () => {
		const docker = buildAllowedHosts("0.0.0.0", []);
		expect(docker.has("0.0.0.0")).toBe(false);
		expect(rejectReason(req("http://127.0.0.1:8787/api/health"), docker)).toBeUndefined();
	});
});
