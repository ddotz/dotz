// Web routes of the Instagram DM view (docs/ig-dm-api.md): /api/ig-dm/*. Read only: there is no route that sends. With the feature row
// "DM 읽기" off (hub/app-features.ts) nothing is listed and nothing is requested. The messages come from cache/ig-dm.json, which the watch
// `sns-ig-dm` and the refresh route fill (features/youtube-instagram/lib/ig-dm.ts).
import { type DmState, type SyncResult, PERMISSION_LINE } from "../features/youtube-instagram/lib/ig-dm.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export type IgDmDeps = {
	enabled: () => boolean;
	/** The connected account, or undefined when Instagram is not connected. */
	account: () => { id: string; username: string } | undefined;
	read: () => DmState;
	/** One poll (only the conversations that moved are read). Throws on a network or API failure. */
	sync: () => Promise<SyncResult>;
};

export function createIgDmWeb(deps: IgDmDeps) {
	function list() {
		if (!deps.enabled()) return { on: false, connected: false, perm: "unknown", convs: [] };
		const connected = deps.account() !== undefined;
		const s = deps.read();
		const convs = Object.values(s.convs)
			.sort((a, b) => b.lastAt - a.lastAt)
			.map(c => ({ id: c.id, peer: c.peer, lastAt: c.lastAt, last: c.last }));
		return { on: true, connected, perm: s.perm, ...(s.perm === "missing" ? { line: PERMISSION_LINE } : {}), checkedAt: s.checkedAt ?? null, convs };
	}

	async function route(req: Request, _url: URL, parts: string[]): Promise<Response | undefined> {
		if (parts[0] !== "api" || parts[1] !== "ig-dm") return undefined;
		if (parts.length === 2 && req.method === "GET") return json(list());
		if (parts.length === 3 && parts[2] === "refresh" && req.method === "POST") {
			if (!deps.enabled()) return json({ error: "DM 읽기가 꺼져 있어요" }, 409);
			if (!deps.account()) return json({ error: "인스타가 연결돼 있지 않아요" }, 409);
			try {
				await deps.sync();
			} catch (e) {
				return json({ ...list(), error: `DM을 불러오지 못했어요 · ${(e as Error).message}` }, 502);
			}
			return json(list());
		}
		if (parts.length === 3 && req.method === "GET") {
			if (!deps.enabled()) return json({ error: "DM 읽기가 꺼져 있어요" }, 409);
			const c = deps.read().convs[decodeURIComponent(parts[2]!)];
			if (!c) return json({ error: "그 대화를 찾지 못했어요" }, 404);
			return json({ id: c.id, peer: c.peer, messages: c.messages });
		}
		return undefined;
	}

	return { route, list };
}
