// HTTP for the one reply flow (the reply unification design, 1.9): GET /api/reply/queue and POST /api/reply/act. Who the caller is
// (`agent`: a request with the hub token that is not the owner's other computer) is decided by the caller of this route, which already knows.
import type { createReplyActions } from "./reply-actions.ts";
import { body, json } from "./routes-util.ts";

type Replies = ReturnType<typeof createReplyActions>;
export type ReplyRouteDeps = { replies: Replies | undefined; login: string; agent?: boolean; triageMin?: number; undoSec?: number; surface?: "web" | "peer" };

/** The reply routes; undefined for any other path. */
export async function replyRoute(req: Request, url: URL, deps: ReplyRouteDeps): Promise<Response | undefined> {
	const queue = url.pathname === "/api/reply/queue" && req.method === "GET";
	const act = url.pathname === "/api/reply/act" && req.method === "POST";
	if (!queue && !act) return undefined;
	if (!deps.replies) return json({ ok: false, code: "not_wired", error: "답장 기능이 아직 준비되지 않았어요" }, 503);
	const ctx = { surface: deps.surface ?? ("web" as const), login: deps.login, agent: deps.agent === true };
	if (queue) {
		const refs = url.searchParams.get("refs")?.split(",").filter(Boolean);
		const all = await deps.replies.list();
		const items = refs ? all.filter(i => refs.includes(i.ref)) : all;
		const st = (s: string) => items.filter(i => i.send?.state === s).length;
		const midnight = new Date().setHours(0, 0, 0, 0);
		const counts = { waiting: items.filter(i => i.draft.state === "pending" && !i.send).length, failed: st("failed"), unsure: st("unsure"), sending: st("undo") + st("queued") + st("sending"), sentToday: items.filter(i => i.send?.state === "sent" && i.send.at >= midnight).length };
		return json({ items, counts, triageMin: deps.triageMin ?? 1, undoSec: deps.undoSec ?? 10 });
	}
	const b = await body(req);
	if (Array.isArray(b.items)) {
		const r = await deps.replies.batch(b.items, ctx);
		return json(r.body, r.status);
	}
	const r = await deps.replies.act(b as Parameters<Replies["act"]>[0], ctx);
	return json(r.body, r.status);
}
