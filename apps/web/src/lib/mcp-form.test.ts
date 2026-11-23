import { describe, expect, test } from "bun:test";

import { buildMcpServerConfig, EMPTY_MCP_FORM, GOOGLE_WORKSPACE_FORM } from "./mcp-form";

describe("buildMcpServerConfig", () => {
	test("stdio: single args line splits on spaces; multiple lines are one arg each", () => {
		expect(buildMcpServerConfig({ ...EMPTY_MCP_FORM, command: " npx ", args: "-y  pkg /tmp" })).toEqual({
			command: "npx",
			args: ["-y", "pkg", "/tmp"],
		});
		expect(buildMcpServerConfig({ ...EMPTY_MCP_FORM, command: "run", args: "--dir\n\n/path with space\r\n" })).toEqual({
			command: "run",
			args: ["--dir", "/path with space"],
		});
	});

	test("stdio: env skips blank lines, keeps = inside values, omits empty args/env", () => {
		expect(buildMcpServerConfig({ ...EMPTY_MCP_FORM, command: "x", env: "\nA=1\n\nB=a=b==\nC=\n" })).toEqual({
			command: "x",
			env: { A: "1", B: "a=b==", C: "" },
		});
		expect(buildMcpServerConfig({ ...EMPTY_MCP_FORM, command: "x", args: "  \n", env: "\n" })).toEqual({ command: "x" });
	});

	test("stdio: env line without a key is rejected by line number", () => {
		expect(() => buildMcpServerConfig({ ...EMPTY_MCP_FORM, command: "x", env: "A=1\n\nsecret" })).toThrow(
			"Env line 3: expected KEY=VALUE",
		);
		expect(() => buildMcpServerConfig({ ...EMPTY_MCP_FORM, command: "x", env: "=v" })).toThrow("Env line 1");
	});

	test("http/sse: bearer header only when a token is given", () => {
		expect(buildMcpServerConfig({ ...EMPTY_MCP_FORM, transport: "http", url: " https://x/mcp ", token: "  " })).toEqual({
			type: "http",
			url: "https://x/mcp",
		});
		expect(buildMcpServerConfig({ ...EMPTY_MCP_FORM, transport: "sse", url: "https://x/sse", token: "abc" })).toEqual({
			type: "sse",
			url: "https://x/sse",
			headers: { Authorization: "Bearer abc" },
		});
		expect(buildMcpServerConfig({ ...EMPTY_MCP_FORM, transport: "http", url: "u", token: "Bearer abc" })).toEqual({
			type: "http",
			url: "u",
			headers: { Authorization: "Bearer abc" },
		});
	});

	test("Google Workspace preset builds the documented uvx config", () => {
		expect(buildMcpServerConfig(GOOGLE_WORKSPACE_FORM)).toEqual({
			command: "uvx",
			args: ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
			env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "", USER_GOOGLE_EMAIL: "" },
		});
		expect(GOOGLE_WORKSPACE_FORM.scope).toBe("user");
	});
});
