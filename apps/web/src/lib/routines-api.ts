import type {
	CreateRoutineRequest,
	InstallTemplateResponse,
	ListRoutineRunsResponse,
	ListRoutineStepRunsResponse,
	ListRoutinesResponse,
	Routine,
	UpdateRoutineRequest,
} from "@omp-deck/protocol";

const BASE = "/api";

/** A non-ok response. `message` is the body's JSON `error` string when it has one. */
export class RoutinesApiError extends Error {
	readonly status: number;
	/** Parsed JSON body; `undefined` when the body is not JSON. */
	readonly body: unknown;

	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

/** 409 body from create/update when another routine owns the spec's webhook path. */
export interface WebhookConflictBody {
	error: string;
	path: string;
	routine: { id: string; name: string };
}

export function webhookConflict(e: unknown): WebhookConflictBody | undefined {
	if (!(e instanceof RoutinesApiError) || e.status !== 409) return undefined;
	const b = e.body as Partial<WebhookConflictBody> | null | undefined;
	return typeof b?.path === "string" && typeof b.routine?.name === "string" ? (b as WebhookConflictBody) : undefined;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		const error = typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
		throw new RoutinesApiError(typeof error === "string" ? error : `HTTP ${res.status} ${path}: ${text}`, res.status, body);
	}
	return (await res.json()) as T;
}

export interface RoutineMetrics {
	total: number;
	successCount: number;
	successRate30d: number;
	p50DurationMs: number | null;
	p95DurationMs: number | null;
	mtdCostMicros: number;
	last30: Array<{ runId: string; status: "success" | "failed" | "aborted" | "running"; durationMs: number | null }>;
}

export interface TemplateSummary {
	slug: string;
	name: string;
	description?: string;
	tags?: string[];
	steps: number;
	triggers: number;
}

export const routinesApi = {
	list(): Promise<ListRoutinesResponse> {
		return req<ListRoutinesResponse>("/routines");
	},
	get(id: string): Promise<Routine> {
		return req<Routine>(`/routines/${encodeURIComponent(id)}`);
	},
	create(body: CreateRoutineRequest & { specYaml?: string }): Promise<Routine> {
		return req<Routine>("/routines", { method: "POST", body: JSON.stringify(body) });
	},
	update(id: string, body: UpdateRoutineRequest & { specYaml?: string }): Promise<Routine> {
		return req<Routine>(`/routines/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	remove(id: string): Promise<{ ok: boolean }> {
		return req(`/routines/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	runNow(id: string, params?: Record<string, unknown>): Promise<{ ok: boolean; queued: boolean }> {
		return req(`/routines/${encodeURIComponent(id)}/run`, {
			method: "POST",
			body: JSON.stringify(params ?? {}),
		});
	},
	runs(id: string, limit = 10): Promise<ListRoutineRunsResponse> {
		return req<ListRoutineRunsResponse>(
			`/routines/${encodeURIComponent(id)}/runs?limit=${limit}`,
		);
	},
	steps(id: string, runId: string): Promise<ListRoutineStepRunsResponse> {
		return req<ListRoutineStepRunsResponse>(
			`/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/steps`,
		);
	},
	metrics(id: string): Promise<RoutineMetrics> {
		return req<RoutineMetrics>(`/routines/${encodeURIComponent(id)}/metrics`);
	},
	templates: {
		list(): Promise<{ templates: TemplateSummary[] }> {
			return req<{ templates: TemplateSummary[] }>("/routine-templates");
		},
		install(slug: string): Promise<InstallTemplateResponse> {
			return req<InstallTemplateResponse>(`/routine-templates/${encodeURIComponent(slug)}`, { method: "POST" });
		},
	},
	rotateWebhookSecret(id: string): Promise<{ ok: boolean; secret: string; path: string }> {
		return req(`/routines/${encodeURIComponent(id)}/webhook-secret/rotate`, { method: "POST" });
	},
};
