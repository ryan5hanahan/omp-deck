import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
	ChevronRight,
	ExternalLink,
	KeyRound,
	Loader2,
	Plus,
	Power,
	PowerOff,
	RefreshCw,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import type { McpServerStatus, McpServerSummary, McpToolSummary } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { mcpApi } from "@/lib/mcp-api";
import { buildMcpServerConfig, EMPTY_MCP_FORM, GOOGLE_WORKSPACE_FORM, type McpServerForm } from "@/lib/mcp-form";
import { cn } from "@/lib/utils";

const SETUP_GUIDE_URL = "https://github.com/ryan5hanahan/omp-deck/blob/main/docs/integrations.md";
const CONSENT_POLL_MS = 3_000;
const CONSENT_POLL_LIMIT_MS = 120_000;

const STATUS_DOT: Record<McpServerStatus, string> = {
	connected: "bg-success",
	connecting: "bg-accent animate-pulse",
	disconnected: "bg-ink-4",
	error: "bg-danger",
};

const INPUT = "field h-8 w-full px-2 font-mono text-xs";
const TEXTAREA = "field block w-full resize-y px-2 py-1.5 font-mono text-xs";
const ERROR_BOX = "rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger";

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** /integrations — installed MCP servers, the add form and the recommended presets. */
export function IntegrationsView() {
	const [servers, setServers] = useState<McpServerSummary[] | null>(null);
	const [error, setError] = useState<string | undefined>();
	const [busyName, setBusyName] = useState<string | undefined>();
	const [addPreset, setAddPreset] = useState<McpServerForm | null>(null);
	const [consent, setConsent] = useState<{ name: string; url: string } | null>(null);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			setServers(await mcpApi.list());
		} catch (e) {
			setError(errorText(e));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// The reauth route returns before consent completes; poll so the status flips without a manual refresh.
	useEffect(() => {
		if (!consent) return;
		const started = Date.now();
		const id = setInterval(() => {
			if (Date.now() - started > CONSENT_POLL_LIMIT_MS) setConsent(null);
			else void refresh();
		}, CONSENT_POLL_MS);
		return () => clearInterval(id);
	}, [consent, refresh]);

	async function act(name: string, fn: () => Promise<unknown>): Promise<void> {
		setBusyName(name);
		setError(undefined);
		try {
			await fn();
			await refresh();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusyName(undefined);
		}
	}

	function remove(server: McpServerSummary): void {
		const scope = server.scope;
		if (scope === "external") return;
		if (!confirm(`Remove MCP server "${server.name}" from the ${scope} config?`)) return;
		void act(server.name, () => mcpApi.remove(server.name, scope));
	}

	function reauth(name: string): void {
		void act(name, async () => {
			const res = await mcpApi.reauth(name);
			if (!("url" in res)) return;
			window.open(res.url, "_blank", "noopener,noreferrer");
			setConsent({ name, url: res.url });
		});
	}

	const workspaceInstalled = servers?.some((s) => s.name === GOOGLE_WORKSPACE_FORM.name) ?? false;

	return (
		<>
			<Layout
				sidebar={<IntegrationsSidebar />}
				inspector={null}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
							<div className="meta">MCP servers</div>
							<div className="text-xs text-ink-3">{servers ? servers.length : "loading..."}</div>
							<div className="flex-1" />
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7"
								onClick={() => {
									setError(undefined);
									void refresh();
								}}
								aria-label="Refresh servers"
								title="Refresh servers"
							>
								<RotateCcw className="h-3.5 w-3.5" />
							</Button>
							<Button variant="primary" size="sm" onClick={() => setAddPreset(EMPTY_MCP_FORM)}>
								<Plus className="h-3.5 w-3.5" />
								Add server
							</Button>
						</div>
						{error ? <div className={cn("mx-3 mt-2", ERROR_BOX)}>{error}</div> : null}
						{consent ? (
							<div className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-ink">
								<span className="min-w-0 flex-1">
									Finish authorizing <span className="font-mono">{consent.name}</span> in the consent tab. This list
									refreshes while you do.
								</span>
								<a
									href={consent.url}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
								>
									Open consent screen
									<ExternalLink className="h-3 w-3" />
								</a>
								<Button
									variant="ghost"
									size="icon"
									className="h-6 w-6"
									onClick={() => setConsent(null)}
									aria-label="Dismiss"
								>
									<X className="h-3.5 w-3.5" />
								</Button>
							</div>
						) : null}
						<div className="min-h-0 flex-1 overflow-y-auto p-3">
							<div className="mx-auto max-w-3xl space-y-4">
								<p className="text-xs text-ink-3">
									New chat sessions see changes immediately; a running session picks them up after{" "}
									<code className="paper-code px-1 py-0.5 text-2xs">/mcp reload</code>.
								</p>
								{servers === null && !error ? (
									<div className="px-3 py-6 text-center text-sm text-ink-3">Loading MCP servers...</div>
								) : null}
								{servers?.length === 0 ? (
									<div className="rounded-md border border-dashed border-line bg-paper-2 p-6 text-center">
										<div className="meta">No MCP servers yet</div>
										<p className="mt-1 text-sm text-ink-3">
											Add one with “Add server”, or start from a recommended server below.
										</p>
									</div>
								) : null}
								{servers && servers.length > 0 ? (
									<div className="space-y-2">
										{servers.map((server) => (
											<ServerCard
												key={`${server.scope}:${server.name}`}
												server={server}
												busy={busyName === server.name}
												onToggle={() =>
													void act(server.name, () => mcpApi.setEnabled(server.name, !server.enabled))
												}
												onTest={() => void act(server.name, () => mcpApi.reconnect(server.name))}
												onReauth={() => reauth(server.name)}
												onRemove={() => remove(server)}
											/>
										))}
									</div>
								) : null}
								<section className="space-y-2">
									<h2 className="meta">Recommended</h2>
									<GoogleWorkspaceTile
										installed={workspaceInstalled}
										onSetUp={() => setAddPreset(GOOGLE_WORKSPACE_FORM)}
									/>
								</section>
							</div>
						</div>
					</div>
				}
			/>
			{addPreset ? (
				<AddServerModal initial={addPreset} onClose={() => setAddPreset(null)} onAdded={() => void refresh()} />
			) : null}
		</>
	);
}

function IntegrationsSidebar() {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-10 shrink-0 items-center border-b border-line px-3">
				<div className="meta">Integrations</div>
			</div>
			<div className="space-y-3 p-3 text-xs text-ink-3">
				<p>MCP servers add tools to chat sessions and to routine steps.</p>
				<dl className="space-y-2">
					<div>
						<dt className="meta">user</dt>
						<dd className="font-mono text-2xs">~/.omp/agent/mcp.json</dd>
					</div>
					<div>
						<dt className="meta">project</dt>
						<dd className="font-mono text-2xs">&lt;cwd&gt;/.omp/mcp.json</dd>
					</div>
					<div>
						<dt className="meta">external</dt>
						<dd>Found in another config (Claude, Cursor, VS Code, …). Read-only here, but can be enabled or disabled.</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

function ServerCard({
	server,
	busy,
	onToggle,
	onTest,
	onReauth,
	onRemove,
}: {
	server: McpServerSummary;
	busy: boolean;
	onToggle: () => void;
	onTest: () => void;
	onReauth: () => void;
	onRemove: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [tools, setTools] = useState<McpToolSummary[] | undefined>();
	const [toolsError, setToolsError] = useState<string | undefined>();

	async function toggleOpen(): Promise<void> {
		const next = !open;
		setOpen(next);
		if (!next || !server.enabled) return;
		setTools(undefined);
		setToolsError(undefined);
		try {
			setTools(await mcpApi.tools(server.name));
		} catch (e) {
			setToolsError(errorText(e));
		}
	}

	const oauthCapable = server.transport === "http" || server.transport === "sse";

	return (
		<div className="rounded-md border border-line bg-paper">
			<div className="flex flex-wrap items-center gap-2 px-3 py-2">
				<button
					type="button"
					onClick={() => void toggleOpen()}
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
				>
					<ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
					<span
						className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[server.status])}
						title={server.error ?? server.status}
					/>
					<span className="sr-only">{server.status}</span>
					<span className="truncate text-sm font-semibold text-ink">{server.name}</span>
					<Badge tone={server.scope === "external" ? "warn" : "muted"}>{server.scope}</Badge>
					{server.transport ? <Badge tone="muted">{server.transport}</Badge> : null}
					{server.enabled ? null : <Badge tone="danger">disabled</Badge>}
					<span className="shrink-0 font-mono text-2xs text-ink-3">
						{server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
					</span>
				</button>
				<div className="flex shrink-0 items-center gap-1">
					{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" aria-label="Working" /> : null}
					<Button variant="ghost" size="sm" disabled={busy} onClick={onToggle}>
						{server.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
						{server.enabled ? "Disable" : "Enable"}
					</Button>
					<Button variant="ghost" size="sm" disabled={busy || !server.enabled} onClick={onTest}>
						<RefreshCw className="h-3.5 w-3.5" />
						Test
					</Button>
					{oauthCapable ? (
						<Button variant="ghost" size="sm" disabled={busy || !server.enabled} onClick={onReauth}>
							<KeyRound className="h-3.5 w-3.5" />
							Reauthorize
						</Button>
					) : null}
					{server.scope === "external" ? null : (
						<Button variant="ghost" size="sm" className="hover:text-danger" disabled={busy} onClick={onRemove}>
							<Trash2 className="h-3.5 w-3.5" />
							Remove
						</Button>
					)}
				</div>
			</div>
			{server.scope === "external" && server.sourcePath ? (
				<div className="truncate border-t border-line px-3 py-1 font-mono text-2xs text-ink-3" title={server.sourcePath}>
					{server.sourcePath}
				</div>
			) : null}
			{open ? (
				<div className="space-y-2 border-t border-line px-3 py-2">
					{server.error ? <div className={ERROR_BOX}>{server.error}</div> : null}
					{!server.enabled ? (
						<div className="text-xs text-ink-3">Enable the server to list its tools.</div>
					) : toolsError ? (
						<div className={ERROR_BOX}>{toolsError}</div>
					) : tools === undefined ? (
						<div className="text-xs text-ink-3">Loading tools...</div>
					) : tools.length === 0 ? (
						<div className="text-xs text-ink-3">No tools.</div>
					) : (
						<ul className="space-y-1.5">
							{tools.map((tool) => (
								<li key={tool.name}>
									<div className="font-mono text-xs text-ink">{tool.name}</div>
									{tool.description ? <div className="line-clamp-2 text-xs text-ink-3">{tool.description}</div> : null}
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}

function GoogleWorkspaceTile({ installed, onSetUp }: { installed: boolean; onSetUp: () => void }) {
	return (
		<div className="flex items-start gap-3 rounded-md border border-line bg-paper px-3 py-2">
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium text-ink">Google Workspace</div>
				<div className="mt-0.5 font-mono text-2xs text-ink-3">uvx workspace-mcp --tools gmail drive calendar</div>
				<div className="mt-1 text-xs text-ink-3">
					Gmail, Drive and Calendar tools. Needs a Google Cloud OAuth client ID and secret.{" "}
					<a
						href={SETUP_GUIDE_URL}
						target="_blank"
						rel="noopener noreferrer"
						title="docs/integrations.md"
						className="inline-flex items-center gap-1 text-accent hover:underline"
					>
						Setup guide
						<ExternalLink className="h-3 w-3" />
					</a>
				</div>
			</div>
			{installed ? (
				<Badge tone="success">installed</Badge>
			) : (
				<Button variant="primary" size="sm" onClick={onSetUp}>
					<Plus className="h-3.5 w-3.5" />
					Set up
				</Button>
			)}
		</div>
	);
}

function AddServerModal({
	initial,
	onClose,
	onAdded,
}: {
	initial: McpServerForm;
	onClose: () => void;
	onAdded: () => void;
}) {
	const [form, setForm] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	function set<K extends keyof McpServerForm>(key: K, value: McpServerForm[K]): void {
		setForm((prev) => ({ ...prev, [key]: value }));
	}

	const stdio = form.transport === "stdio";
	const ready = form.name.trim() !== "" && (stdio ? form.command : form.url).trim() !== "";

	async function submit(e: FormEvent): Promise<void> {
		e.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(undefined);
		try {
			await mcpApi.add({ name: form.name.trim(), scope: form.scope, config: buildMcpServerConfig(form) });
			onAdded();
			onClose();
		} catch (err) {
			setError(errorText(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal open onClose={onClose} widthClass="max-w-lg">
			<form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col">
				<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
					<div className="meta">Add MCP server</div>
					<div className="flex-1" />
					<Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close">
						<X className="h-4 w-4" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
					<Field label="Name">
						<input
							className={INPUT}
							value={form.name}
							onChange={(e) => set("name", e.target.value)}
							placeholder="my-server"
							autoFocus
							required
						/>
					</Field>
					<div className="grid grid-cols-2 gap-3">
						<Field label="Scope">
							<select
								className={INPUT}
								value={form.scope}
								onChange={(e) => set("scope", e.target.value as McpServerForm["scope"])}
							>
								<option value="user">user</option>
								<option value="project">project</option>
							</select>
						</Field>
						<Field label="Transport">
							<select
								className={INPUT}
								value={form.transport}
								onChange={(e) => set("transport", e.target.value as McpServerForm["transport"])}
							>
								<option value="stdio">stdio</option>
								<option value="http">http</option>
								<option value="sse">sse</option>
							</select>
						</Field>
					</div>
					{stdio ? (
						<>
							<Field label="Command">
								<input
									className={INPUT}
									value={form.command}
									onChange={(e) => set("command", e.target.value)}
									placeholder="npx"
									required
								/>
							</Field>
							<Field label="Args" hint="One per line; a single line is split on spaces.">
								<textarea
									className={TEXTAREA}
									rows={3}
									value={form.args}
									onChange={(e) => set("args", e.target.value)}
									spellCheck={false}
								/>
							</Field>
							<Field label="Env" hint="KEY=VALUE, one per line.">
								<textarea
									className={TEXTAREA}
									rows={3}
									value={form.env}
									onChange={(e) => set("env", e.target.value)}
									spellCheck={false}
								/>
							</Field>
						</>
					) : (
						<>
							<Field label="URL">
								<input
									className={INPUT}
									type="url"
									value={form.url}
									onChange={(e) => set("url", e.target.value)}
									placeholder="https://example.com/mcp"
									required
								/>
							</Field>
							<Field label="Bearer token" hint="Optional. Sent as the Authorization header.">
								<input
									className={INPUT}
									type="password"
									autoComplete="off"
									value={form.token}
									onChange={(e) => set("token", e.target.value)}
								/>
							</Field>
						</>
					)}
					{error ? (
						<div role="alert" className={cn("whitespace-pre-wrap", ERROR_BOX)}>
							{error}
						</div>
					) : null}
				</div>
				<div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-3">
					<Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" size="sm" disabled={busy || !ready}>
						{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
						Add
					</Button>
				</div>
			</form>
		</Modal>
	);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<label className="block space-y-1">
			<span className="meta">{label}</span>
			{children}
			{hint ? <span className="block font-mono text-2xs text-ink-3">{hint}</span> : null}
		</label>
	);
}
