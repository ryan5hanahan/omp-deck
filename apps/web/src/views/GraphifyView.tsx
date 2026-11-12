import { useEffect, useState } from "react";

import { Layout } from "@/components/Layout";
import { Markdown } from "@/lib/markdown";
import { useStore } from "@/lib/store";
import { cn, shortPath } from "@/lib/utils";

type Tab = "graph" | "report";

/** Viewer for a workspace's `graphify-out/` (graph.html + GRAPH_REPORT.md). */
export function GraphifyView() {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const [cwd, setCwd] = useState("");
	const [tab, setTab] = useState<Tab>("graph");
	const [report, setReport] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const cwdInUse = cwd || defaultCwd;
	const q = `?cwd=${encodeURIComponent(cwdInUse)}`;

	useEffect(() => {
		if (!cwdInUse) return;
		let cancelled = false;
		setReport(null);
		setError(null);
		fetch(`/api/graphify/GRAPH_REPORT.md${q}`)
			.then(async (res) => {
				if (cancelled) return;
				if (res.ok) setReport(await res.text());
				else setError(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
			})
			.catch((e) => !cancelled && setError(String(e)));
		return () => {
			cancelled = true;
		};
	}, [cwdInUse, q]);

	return (
		<Layout
			sidebar={
				<div className="p-3">
					<div className="meta mb-2">Workspace</div>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							const v = new FormData(e.currentTarget).get("path");
							if (typeof v === "string" && v.trim()) setCwd(v.trim());
						}}
					>
						<input
							name="path"
							key={cwdInUse}
							defaultValue={cwdInUse}
							placeholder="/absolute/path (Enter)"
							aria-label="Workspace path"
							className="mb-2 w-full rounded-md border border-line bg-paper-2 px-2 py-1 text-xs text-ink focus:outline-none"
						/>
					</form>
					<div className="flex flex-col gap-1">
						{workspaces.map((w) => (
							<button
								key={w.cwd}
								type="button"
								onClick={() => setCwd(w.cwd)}
								title={w.cwd}
								className={cn(
									"truncate rounded-md px-2 py-1 text-left text-sm",
									w.cwd === cwdInUse ? "bg-accent-soft/40 text-accent" : "text-ink-2 hover:bg-paper-3",
								)}
							>
								{w.label}
								<div className="truncate text-xs text-ink-4">{shortPath(w.cwd)}</div>
							</button>
						))}
					</div>
				</div>
			}
			inspector={
				<div className="p-3 text-sm text-ink-3">
					Rebuild with <code>graphify extract .</code> in the workspace.
				</div>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Graphify</div>
						<div className="truncate text-xs text-ink-3">{shortPath(cwdInUse)}</div>
						<div className="flex-1" />
						{(["graph", "report"] as const).map((t) => (
							<button
								key={t}
								type="button"
								onClick={() => setTab(t)}
								className={cn("btn-ghost h-7 px-2 text-xs", tab === t && "bg-paper-3 text-ink")}
							>
								{t === "graph" ? "Graph" : "Report"}
							</button>
						))}
					</div>
					{error ? (
						<div className="p-4 text-sm text-ink-3">{error}</div>
					) : tab === "graph" ? (
						<iframe
							key={cwdInUse}
							title="graphify graph"
							src={`/api/graphify/graph.html${q}`}
							sandbox="allow-scripts"
							className="min-h-0 flex-1 border-0"
						/>
					) : (
						<div className="min-h-0 flex-1 overflow-auto p-4">
							{report === null ? <div className="text-sm text-ink-3">loading...</div> : <Markdown>{report}</Markdown>}
						</div>
					)}
				</div>
			}
		/>
	);
}
