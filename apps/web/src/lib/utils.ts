import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
	return `${(n / 1000 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	// SDK 19 reports fractional ms; round before the branch so 999.6 reads "1.0s".
	const rounded = Math.round(ms);
	if (rounded < 1000) return `${rounded}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m ${s}s`;
}

export function shortPath(p: string | undefined, max = 64): string {
	if (!p) return "";
	if (p.length <= max) return p;
	const parts = p.split(/[\\/]/);
	if (parts.length <= 2) return p.slice(-max);
	return `…/${parts.slice(-2).join("/")}`;
}

export function truncate(text: string, max: number): string {
	if (!text || text.length <= max) return text ?? "";
	return `${text.slice(0, max - 1)}…`;
}
