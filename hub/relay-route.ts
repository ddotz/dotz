import { adapters, get, RelayError, type RelayRow } from "./messenger.ts";

// The web app's chat with a computer that has no address of its own and is reached through a messenger (the adapter's `relay`, hub/messenger.ts):
//   GET  /api/relay/<adapter>/<key>/messages -> [{ id, at, me, text }]
//   POST /api/relay/<adapter>/<key>/send     { text } -> { ok: true }
//   GET  /api/relay/<adapter>/<key>/status   -> { snapshot: Snapshot | null, received_at? } (the computer's last status snapshot, hub/relay-snapshot.ts)
// and the old chat page's address, which now only leads to the app's chat view. hub/routes.ts calls this after the owner / device gate and only for a
// request that is not a peer's; these paths are not in the peer path lists of hub/peer-auth.ts.

const MAX_TEXT = 4000;
const MAX_BODY = 64 * 1024;
const API_RE = /^\/api\/relay\/([a-z0-9-]+)\/([^/]+)\/(messages|send|status)$/;
const OLD_PAGE_RE = /^\/jandi-peer\/([^/]+)\/?$/;

const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const decode = (s: string): string | undefined => {
	try {
		return decodeURIComponent(s);
	} catch {
		return undefined;
	}
};

/** The computer list's rows of every messenger that carries one; a messenger that fails leaves its rows out. */
export async function relayRows(): Promise<RelayRow[]> {
	const lists = await Promise.all(adapters().map(a => a.relay?.rows().catch(() => []) ?? []));
	return lists.flat();
}

/** The relay endpoints and the old page's redirect, or undefined for any other path. */
export async function relayRoute(req: Request, url: URL): Promise<Response | undefined> {
	const old = OLD_PAGE_RE.exec(url.pathname);
	if (old) {
		if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
		const key = decode(old[1]!);
		if (!key) return json({ error: "not found" }, 404);
		return new Response(null, { status: 302, headers: { Location: `/#chat/relay:jandi:${encodeURIComponent(key)}`, "Cache-Control": "no-store" } });
	}
	const m = API_RE.exec(url.pathname);
	if (!m) return undefined;
	const relay = get(m[1]!)?.relay;
	const key = decode(m[2]!);
	if (!relay || !key) return json({ error: "not found" }, 404);
	const isSend = m[3] === "send";
	if (m[3] === "status" && !relay.status) return json({ error: "not found" }, 404);
	if (req.method !== (isSend ? "POST" : "GET")) return json({ error: "method not allowed" }, 405);
	try {
		if (m[3] === "status") return json(await relay.status!(key));
		if (!isSend) return json(await relay.lines(key));
		if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "JSON으로 보내 주세요" }, 415);
		const raw = await req.text();
		if (raw.length > MAX_BODY) return json({ error: "너무 길어요" }, 413);
		let text = "";
		try {
			const b = JSON.parse(raw) as { text?: unknown };
			if (typeof b?.text === "string") text = b.text.trim();
		} catch {}
		if (!text || text.length > MAX_TEXT) return json({ error: `1~${MAX_TEXT}자로 적어 주세요` }, 400);
		await relay.send(key, text);
		return json({ ok: true });
	} catch (e) {
		if (e instanceof RelayError) return json({ error: e.message }, e.status);
		return json({ error: "연결하지 못했어요" }, 502);
	}
}
