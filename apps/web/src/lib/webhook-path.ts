/** A fresh webhook trigger path. `h-` supplies the leading letter `^/hooks/[a-z]` requires; base-36 digits are valid after it. */
export function newWebhookPath(): string {
	return `/hooks/h-${Math.random().toString(36).slice(2, 10)}`;
}
