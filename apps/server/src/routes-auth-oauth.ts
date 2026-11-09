/**
 * OAuth login routes — drives provider sign-in from the deck UI without
 * requiring the user to run `omp /login` in a terminal first.
 *
 * Architecture (verified against the SDK in docs/oauth-deck-sdk-findings.md):
 *
 * - Canonical entry point is `AuthStorage.login(providerId, ctrl)`. The SDK
 *   dispatches per-provider internally AND persists the resulting credential
 *   via `.set()` — we do NOT call `upsertAuthCredentialForProvider` ourselves.
 * - SDK spawns its own short-lived loopback listener on hard-coded ports
 *   (Anthropic 54545, Codex 1455). The deck never receives the provider
 *   callback. No `/callback` route here.
 * - One in-flight flow per provider — port collisions on the SDK's
 *   `Bun.serve({ port, reusePort: false })` would otherwise throw.
 * - 5-minute hard timeout lives in the SDK (`DEFAULT_TIMEOUT` in
 *   `callback-server.ts`). Cancel triggers the controller's AbortSignal.
 * - On success: `models_changed` WS frame + belt-and-suspenders
 *   `registry.refreshProvider(provider, "online")` for dynamic-discovery
 *   providers (no-op for Anthropic/Codex which ship static catalogs).
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getEnvApiKey, getOAuthProviders } from "@oh-my-pi/pi-ai";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai";
import type {
	ListProvidersResponse,
	OAuthManualCodeRequest,
	OAuthPromptReplyRequest,
	ProviderAuthState,
	ProviderInfo,
	StartOAuthResponse,
} from "@omp-deck/protocol";

import { broadcastBus } from "./broadcast-bus.ts";
import { API_KEY_PROVIDERS } from "./env-schema.ts";
import { getDeckAuthStorage, getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";

/**
 * ES2023-safe deferred helper. `Promise.withResolvers` is ES2024; the deck's
 * tsconfig targets ES2023 so we roll our own. Cheap, correct, no library.
 */
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}
function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const log = logger("oauth-routes");

interface ActiveFlow {
	flowId: string;
	provider: string;
	ac: AbortController;
	consentReady: Deferred<{ url: string; instructions?: string }>;
	manualCode: Deferred<string>;
	promptResolvers: Map<string, (answer: string) => void>;
	consent?: { url: string; instructions?: string };
	status: "awaiting-consent" | "consent-ready" | "exchanging" | "done" | "errored";
	error?: string;
}

// One in-flight flow per provider — second `start` 409s while the first is
// alive. flowsById is the WS lookup index.
const flows = new Map<string, ActiveFlow>();
const flowsById = new Map<string, ActiveFlow>();

function deriveAuthState(entry: unknown): { state: ProviderAuthState; count: number } {
	if (!entry) return { state: "unconfigured", count: 0 };
	const arr = Array.isArray(entry) ? entry : [entry];
	if (arr.length === 0) return { state: "unconfigured", count: 0 };
	// AuthCredentialEntry is `AuthCredential | AuthCredential[]`; the discriminator
	// on each entry is `type: "oauth" | "api_key"`. We surface the FIRST credential's
	// type — multi-credential is uncommon for the subscription providers we care
	// about; the count badge tells the user there's more if so.
	const first = arr[0] as { type?: string } | undefined;
	const state: ProviderAuthState = first?.type === "oauth" ? "oauth" : "api-key";
	return { state, count: arr.length };
}

/**
 * Translate the SDK's port-collision error into something actionable.
 * `Bun.serve({ port, reusePort: false })` throws an `EADDRINUSE` when the
 * provider's hard-coded port is already bound (typical cause: a separate
 * `omp /login` running in a terminal). The default message is opaque.
 */
function humanizeError(provider: string, raw: unknown): string {
	const msg = raw instanceof Error ? raw.message : String(raw);
	if (/EADDRINUSE/i.test(msg) || /address already in use/i.test(msg)) {
		// Provider-specific port hint — Anthropic 54545, Codex 1455.
		const port =
			provider === "anthropic" ? "54545" : provider === "openai-codex" ? "1455" : "the OAuth callback port";
		return `Port ${port} in use — close any running 'omp /login' or other OAuth flow and retry.`;
	}
	return msg;
}

export function buildAuthOAuthRouter(): Hono {
	const app = new Hono();

	app.get("/providers", async (c) => {
		const auth = await getDeckAuthStorage();
		const sdkProviders: OAuthProviderInfo[] = getOAuthProviders();
		const data = auth.credentials.all() as Record<string, unknown>;
		const providers: ProviderInfo[] = sdkProviders
			.filter((p) => p.available)
			.map((p) => ({
				id: String(p.id),
				name: p.name,
				...deriveAuthState(data[String(p.id)]),
			}));
		const oauthIds = new Set(providers.map((p) => p.id));
		for (const p of API_KEY_PROVIDERS) {
			if (oauthIds.has(p.id)) continue;
			const stored = deriveAuthState(data[p.id]);
			const hasKey = stored.count > 0 || Boolean(getEnvApiKey(p.id));
			providers.push({
				id: p.id,
				name: p.name,
				kind: "api-key",
				envKey: p.envKey,
				state: hasKey ? "api-key" : "unconfigured",
				count: Math.max(stored.count, hasKey ? 1 : 0),
			});
		}
		const body: ListProvidersResponse = { providers };
		return c.json(body);
	});

	app.post("/:provider/start", async (c) => {
		const provider = c.req.param("provider");
		if (flows.has(provider)) {
			return c.json(
				{
					error: "already-in-flight",
					message: `An OAuth flow for ${provider} is already in progress. Cancel it first.`,
				},
				409,
			);
		}

		const auth = await getDeckAuthStorage();
		const registry = await getDeckModelRegistry();
		const flowId = randomUUID();
		const flow: ActiveFlow = {
			flowId,
			provider,
			ac: new AbortController(),
			consentReady: defer<{ url: string; instructions?: string }>(),
			manualCode: defer<string>(),
			promptResolvers: new Map(),
			status: "awaiting-consent",
		};
		// Manual-code deferred may be rejected on cancel even when the SDK never
		// awaited it (loopback won the race) — silence the unhandled rejection
		// instead of letting Bun's postmortem surface it as a spurious server error.
		flow.manualCode.promise.catch(() => {});
		flows.set(provider, flow);
		flowsById.set(flowId, flow);

		const loginPromise = auth
			.oauth.login(provider as Parameters<typeof auth.oauth.login>[0], {
				onAuth: (info) => {
					flow.consent = info;
					flow.status = "consent-ready";
					broadcastBus.broadcast({
						type: "oauth_consent",
						flowId,
						provider,
						url: info.url,
						...(info.instructions ? { instructions: info.instructions } : {}),
					});
					flow.consentReady.resolve(info);
				},
				onPrompt: async (p) => {
					const promptId = randomUUID();
					const deferred = defer<string>();
					flow.promptResolvers.set(promptId, deferred.resolve);
					broadcastBus.broadcast({
						type: "oauth_prompt",
						flowId,
						provider,
						promptId,
						message: p.message,
						...(p.placeholder ? { placeholder: p.placeholder } : {}),
					});
					return deferred.promise;
				},
				onProgress: (message) => {
					broadcastBus.broadcast({ type: "oauth_progress", flowId, provider, message });
				},
				// Mobile/Tailscale fallback — racer against the SDK's loopback listener.
				// Resolves only when the client POSTs `/manual-code`.
				onManualCodeInput: () => flow.manualCode.promise,
				signal: flow.ac.signal,
			})
			.then(
				() => {
					flow.status = "done";
					broadcastBus.broadcast({ type: "oauth_complete", flowId, provider });
					// Static providers (Anthropic/Codex) need no refresh — `hasAuth` is
					// live-read. Dynamic-discovery providers need this to enumerate.
					// Fire-and-forget; failure here doesn't block the client.
					void registry.refreshProvider(provider, "online").catch((err) => {
						log.debug(`refreshProvider(${provider}) after login failed: ${err}`);
					});
					broadcastBus.broadcast({ type: "models_changed" });
				},
				(err) => {
					flow.status = "errored";
					flow.error = humanizeError(provider, err);
					broadcastBus.broadcast({
						type: "oauth_failed",
						flowId,
						provider,
						message: flow.error,
					});
					// Reject the consentReady deferred too — otherwise the awaiting HTTP
					// response below would hang on a login that never produced a URL.
					flow.consentReady.reject(err);
				},
			)
			.finally(() => {
				flows.delete(provider);
				flowsById.delete(flowId);
			});
		// Keep the unhandled-rejection inspector quiet — we attached handlers above.
		loginPromise.catch(() => {});

		try {
			const info = await flow.consentReady.promise;
			const body: StartOAuthResponse = {
				flowId,
				url: info.url,
				...(info.instructions ? { instructions: info.instructions } : {}),
			};
			return c.json(body);
		} catch (err) {
			return c.json({ error: humanizeError(provider, err) }, 500);
		}
	});

	app.post("/:provider/cancel", async (c) => {
		const provider = c.req.param("provider");
		const flow = flows.get(provider);
		if (!flow) return c.json({ ok: true, message: "no flow in progress" });
		flow.ac.abort();
		// Also reject the manual-code deferred so a hung "waiting for paste"
		// promise resolves the SDK's race and lets `.finally()` cleanup run.
		flow.manualCode.reject(new Error("cancelled"));
		return c.json({ ok: true });
	});

	app.post("/manual-code/:flowId", async (c) => {
		const flowId = c.req.param("flowId");
		const flow = flowsById.get(flowId);
		if (!flow) return c.json({ error: "flow not found" }, 404);
		let body: OAuthManualCodeRequest;
		try {
			body = (await c.req.json()) as OAuthManualCodeRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.code || typeof body.code !== "string") {
			return c.json({ error: "code is required" }, 400);
		}
		flow.manualCode.resolve(body.code);
		return c.json({ ok: true });
	});

	app.post("/prompt-reply/:flowId", async (c) => {
		const flowId = c.req.param("flowId");
		const flow = flowsById.get(flowId);
		if (!flow) return c.json({ error: "flow not found" }, 404);
		let body: OAuthPromptReplyRequest;
		try {
			body = (await c.req.json()) as OAuthPromptReplyRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const resolver = flow.promptResolvers.get(body.promptId);
		if (!resolver) return c.json({ error: "prompt not found" }, 404);
		flow.promptResolvers.delete(body.promptId);
		resolver(body.answer);
		return c.json({ ok: true });
	});

	app.delete("/:provider", async (c) => {
		const provider = c.req.param("provider");
		const auth = await getDeckAuthStorage();
		try {
			await auth.credentials.remove(provider);
			broadcastBus.broadcast({ type: "models_changed" });
			return c.json({ ok: true });
		} catch (err) {
			log.error(`revoke ${provider} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	return app;
}
