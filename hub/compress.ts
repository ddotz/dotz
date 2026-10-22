// gzip for the text the web app loads (page, script, styles, JSON): the phone reaches the hub over Tailscale, where the
// 430 KB script and the first history/activity answers dominate a cold open. Event streams, already-compressed bodies and
// small answers pass through untouched. A body with a `key` (the script and styles, computed once per version) goes out as
// brotli when the client takes it: about a fifth smaller than gzip.
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

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
	const br = !!key && /\bbr\b/i.test(req.headers.get("accept-encoding") ?? "");
	headers.set("Content-Encoding", br ? "br" : "gzip");
	headers.set("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
	headers.delete("content-length");
	const k = key && `${key}:${raw.length}:${br ? "br" : "gz"}`;
	let z = k ? memo.get(k) : undefined;
	if (!z) {
		z = br ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : gzipSync(raw, { level: 6 });
		if (k) { if (memo.size > 16) memo.clear(); memo.set(k, z); }
	}
	return new Response(req.method === "HEAD" ? null : z, { status: 200, headers });
}
