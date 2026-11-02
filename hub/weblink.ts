// The web app's public address (set by main.ts once known) and links into it. No address, no link.
let base: string | undefined;

export const setWebBase = (url: string | undefined): void => {
	base = url?.replace(/\/+$/, "") || undefined;
};
/** https://<hostname> for web.cloudflare.hostname (a scheme and trailing slashes are tolerated), undefined when it is not a plain host name. */
export const cfBase = (hostname: string | undefined): string | undefined => {
	const h = hostname?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
	return h && /^[a-z0-9.-]+$/i.test(h) ? `https://${h}` : undefined;
};
export const webBase = (): string | undefined => base;

/** `path` ("/", "/api/file?..." or a "#..." route) on the web app's address, or undefined while there is none. */
export const webLink = (path = "/"): string | undefined => (base ? `${base}${path.startsWith("/") ? path : `/${path}`}` : undefined);

/** The web route that opens the conversation `target` (web/js/05-command-palette.js: #chat/<target>); undefined for targets the web has no chat route for. */
export function convPath(kind: string, target: string): string | undefined {
	if (kind === "main") return "/#chat/main";
	if (kind === "alert" || kind === "worklog") return `/#chat/${kind}`;
	return kind === "project" && /^ch:\d+$/.test(target) ? `/#chat/${target}` : undefined;
}
