// gzip for the text the web app loads (page, script, styles, JSON): the phone reaches the hub over Tailscale, where the
// 430 KB script and the first history/activity answers dominate a cold open. Event streams, already-compressed bodies and
// small answers pass through untouched.
import { gzipSync } from "node:zlib";

const TEXTY = /^(text\/(html|css|javascript)|application\/(json|javascript|manifest\+json))/;
const MIN_BYTES = 1024;
const memo = new Map<string, Uint8Array>();

// `key` names a body that stays the same while the key does (an asset's ETag): its gzip is computed once.
export async function compressResponse(req: Request, res: Response, key?: string): Promise<Response> {
	if ((req.method !== "GET" && req.method !== "HEAD") || res.status !== 200 || !res.body) return res;
	if (!/\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "")) return res;
	const type = res.headers.get("content-type") ?? "";
	if (!TEXTY.test(type) || res.headers.has("content-encoding")) return res;
	const raw = new Uint8Array(await res.arrayBuffer());
	const headers = new Headers(res.headers);
	if (raw.length < MIN_BYTES) return new Response(req.method === "HEAD" ? null : raw, { status: 200, headers });
	const vary = headers.get("vary");
	headers.set("Content-Encoding", "gzip");
	headers.set("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
	headers.delete("content-length");
	const k = key && `${key}:${raw.length}`;
	let z = k ? memo.get(k) : undefined;
	if (!z) {
		z = gzipSync(raw, { level: 6 });
		if (k) { if (memo.size > 16) memo.clear(); memo.set(k, z); }
	}
	return new Response(req.method === "HEAD" ? null : z, { status: 200, headers });
}
