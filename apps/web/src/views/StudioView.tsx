import { useState } from "react";

import { Layout } from "@/components/Layout";

const STUDIO_URL = "http://127.0.0.1:7860";

/**
 * Embeds the local Studio app (the image/video tools in ~/Models) running on its
 * own server at :7860. Studio is a separate process — start it with
 * Studio.command. The iframe loads Studio's own origin directly, so its
 * same-origin-guarded API keeps working; the deck adds no server routes for it.
 */
export function StudioView() {
	const [nonce, setNonce] = useState(0);

	return (
		<Layout
			sidebar={
				<div className="p-3 text-sm text-ink-3">
					<div className="meta mb-2">Studio</div>
					<p className="mb-2">
						Local front end for the image and video tools in <code>~/Models</code> — FLUX.2, Z-Image, LTX-2.
					</p>
					<p>
						Results land in <code>~/Models/out/studio</code>.
					</p>
				</div>
			}
			inspector={
				<div className="p-3 text-sm text-ink-3">
					Studio runs separately on <code>:7860</code>. Start it with <code>Studio.command</code> in{" "}
					<code>~/Models/studio</code>. One run at a time. If the panel is blank, start Studio and press Reload.
				</div>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Studio</div>
						<div className="truncate text-xs text-ink-3">{STUDIO_URL}</div>
						<div className="flex-1" />
						<button type="button" onClick={() => setNonce((n) => n + 1)} className="btn-ghost h-7 px-2 text-xs">
							Reload
						</button>
						<a href={STUDIO_URL} target="_blank" rel="noreferrer" className="btn-ghost h-7 px-2 text-xs">
							Open
						</a>
					</div>
					<iframe key={nonce} title="Studio" src={STUDIO_URL} className="min-h-0 flex-1 border-0" />
				</div>
			}
		/>
	);
}
