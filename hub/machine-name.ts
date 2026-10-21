// The name of this computer as the owner sees it in the web app's computer switcher (hub/peers.ts) and in setup. Pure: no config, no network.
// web.machine_name in config.json wins; empty or missing falls back to friendlyName(hostname).

export const MAX_NAME = 24;

export const label = (dns: string) => dns.replace(/\.$/, "").split(".")[0] ?? "";

// "hyuns-macbookpro" -> 맥북, "hyuns-mac-mini" -> 맥미니; any other host keeps its hostname.
export function friendlyName(host: string): string {
	const h = label(host).toLowerCase();
	if (/mac[\s-]?mini/.test(h)) return "맥미니";
	if (/mac[\s-]?studio/.test(h)) return "맥 스튜디오";
	if (/mac[\s-]?book/.test(h)) return "맥북";
	if (/imac/.test(h)) return "아이맥";
	return label(host) || host;
}

// A name the owner typed: control characters out, runs of blanks folded, trimmed, at most MAX_NAME characters. Anything that is not a string is "".
export function cleanName(v: unknown): string {
	if (typeof v !== "string") return "";
	return [...v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()].slice(0, MAX_NAME).join("").trim();
}

// The chosen name, else the one derived from the hostname.
export const resolveName = (configured: unknown, host: string): string => cleanName(configured) || friendlyName(host);

// The name out of another gateway's GET /api/peer-info answer; undefined for an older gateway or any other shape.
export function peerInfoName(body: unknown): string | undefined {
	return cleanName((body as { name?: unknown } | null)?.name) || undefined;
}
