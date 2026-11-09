/**
 * Host + Origin allow-list for every request the server handles.
 *
 * The deck has no auth of its own; loopback binding keeps other machines out,
 * but not other *websites*. Without this, any page open in the user's browser
 * could open `ws://127.0.0.1:8787/ws` (browsers allow cross-origin WebSockets)
 * and drive an agent with tools, POST `text/plain` bodies that Hono parses as
 * JSON, or read the API through DNS rebinding.
 *
 * - `Host` must name loopback, the configured bind host, or an entry in
 *   `OMP_DECK_ALLOWED_HOSTS` (blocks DNS rebinding).
 * - `Origin`, when present, must name one of the same hosts, any port (the Vite
 *   dev server forwards its own origin). Requests without `Origin` are
 *   non-browser clients (curl, the Telegram bridge, routine http steps) and
 *   pass — browsers always send it on cross-site POSTs and WebSocket upgrades.
 */

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function buildAllowedHosts(bindHost: string, extraHosts: string[]): Set<string> {
	const hosts = new Set(LOOPBACK_HOSTS);
	const bind = bindHost.trim().toLowerCase();
	if (bind && !WILDCARD_BIND_HOSTS.has(bind)) hosts.add(bind);
	for (const h of extraHosts) {
		const name = h.trim().toLowerCase();
		if (name) hosts.add(name);
	}
	return hosts;
}

/** Returns a reason string when the request must be rejected, else `undefined`. */
export function rejectReason(req: Request, allowedHosts: Set<string>): string | undefined {
	const host = new URL(req.url).hostname.toLowerCase();
	if (!allowedHosts.has(host)) return `host "${host}" not allowed`;

	const origin = req.headers.get("origin");
	if (origin === null) return undefined;
	let originHost: string;
	try {
		originHost = new URL(origin).hostname.toLowerCase();
	} catch {
		// Includes the opaque `Origin: null` sent by sandboxed iframes and file:// pages.
		return `origin "${origin}" not allowed`;
	}
	return allowedHosts.has(originHost) ? undefined : `origin "${origin}" not allowed`;
}
