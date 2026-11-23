import type { AddMcpServerRequest, McpServerSummary, McpToolSummary } from "@omp-deck/protocol";

const BASE = "/api";

/** `{ url }` when the user must finish OAuth consent in a browser tab. */
export type McpReauthResponse = { url: string } | { ok: true };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		// The MCP routes answer `{ error }`; surface just that so forms can show it inline.
		let message = `HTTP ${res.status} ${path}: ${body}`;
		try {
			const parsed = JSON.parse(body) as { error?: unknown };
			if (typeof parsed.error === "string") message = parsed.error;
		} catch {
			// Not JSON: keep the raw body.
		}
		throw new Error(message);
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

function serverPath(name: string): string {
	return `/mcp/servers/${encodeURIComponent(name)}`;
}

export const mcpApi = {
	list(): Promise<McpServerSummary[]> {
		return req<McpServerSummary[]>("/mcp/servers");
	},
	tools(name: string): Promise<McpToolSummary[]> {
		return req<McpToolSummary[]>(`${serverPath(name)}/tools`);
	},
	add(body: AddMcpServerRequest): Promise<McpServerSummary> {
		return req<McpServerSummary>("/mcp/servers", { method: "POST", body: JSON.stringify(body) });
	},
	remove(name: string, scope: AddMcpServerRequest["scope"]): Promise<void> {
		return req<void>(`${serverPath(name)}?scope=${scope}`, { method: "DELETE" });
	},
	setEnabled(name: string, enabled: boolean): Promise<McpServerSummary> {
		return req<McpServerSummary>(`${serverPath(name)}/enabled`, {
			method: "POST",
			body: JSON.stringify({ enabled }),
		});
	},
	reconnect(name: string): Promise<McpServerSummary> {
		return req<McpServerSummary>(`${serverPath(name)}/reconnect`, { method: "POST" });
	},
	reauth(name: string): Promise<McpReauthResponse> {
		return req<McpReauthResponse>(`${serverPath(name)}/reauth`, { method: "POST" });
	},
};
