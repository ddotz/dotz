// HTTP routes of the notices (read, resolve, reopen, dismiss, ignore, viewing). Split out of routes.ts, called there at the same place of the chain.
import { log } from "./config.ts";
import { draftActionOf } from "./draft-approval.ts";
import { replies } from "./reply-wire.ts";
import { viewConversation } from "./push.ts";
import { type Notice, allNotices, dismissNotice, handledNotice, ignoreNotice, undismissNotice, markNoticesRead, reopenNotices, resolveNotices, unignoreNotice } from "./notices.ts";
import { json, body } from "./routes-util.ts";

// notice id -> draft ref, for the asked ids whose last answer was the drop option. Read before reopenNotices clears the answer.
function droppedDraftRefs(items: Notice[], ids: unknown): Map<string, string> {
	const want = new Set(Array.isArray(ids) ? ids.map(String) : []), out = new Map<string, string>();
	for (const n of items) {
		const d = n.decision, ref = d?.draft?.ref;
		if (!want.has(n.id) || !d || !ref) continue;
		const m = /^\s*(\d+)\)/.exec(String(d.answer ?? "")), o = m && d.options.find(x => x.n === Number(m[1]));
		if (o && draftActionOf(o.label) === "drop") out.set(n.id, ref);
	}
	return out;
}

export async function routeNotices(req: Request, url: URL): Promise<Response | undefined> {
	if (req.method === "POST" && url.pathname === "/api/notices/read") return json(markNoticesRead(await body(req)));
	// The bot closes the questions whose matter is over (ids, match text, conv or all): they are answered, read and off 답변 필요.
	if (req.method === "POST" && url.pathname === "/api/notices/resolve") return json(resolveNotices(await body(req)));
	// 되돌리기 after 보내지 않기 also puts the dropped draft back in its store through the one reply flow's restore (the peer act notice reopen lands here too).
	if (req.method === "POST" && url.pathname === "/api/notices/reopen") {
		const ids = (await body(req)).ids, refs = droppedDraftRefs(allNotices(), ids);
		const r = reopenNotices(ids);
		for (const ref of r.reopened.flatMap(id => refs.get(id) ?? [])) {
			const back = await replies.act({ ref, action: "restore" }, { surface: "web" });
			if (!back.body.ok) log(`draft ${ref}: 되돌리기 not applied to the store: ${back.body.error}`);
		}
		return json(r);
	}
	// The page reports the conversation it shows ("" = hidden): answers there make no unread message item (hub/notices.ts).
	if (req.method === "POST" && url.pathname === "/api/viewing") {
		const b = await body(req);
		const r = viewConversation(b.id, b.conv);
		return json(r, r.ok ? 200 : 400);
	}
	const dismiss = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/dismiss$/.exec(url.pathname) : null;
	if (dismiss) {
		const r = dismissNotice(decodeURIComponent(dismiss[1]!));
		return json(r, r.ok ? 200 : r.held ? 409 : 404);
	}
	// The ✕ on a failure that waits (handled) and the undo of a dismiss (the toast's 실행 취소).
	const settle = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/(handled|undismiss)$/.exec(url.pathname) : null;
	if (settle) {
		const r = (settle[2] === "handled" ? handledNotice : undismissNotice)(decodeURIComponent(settle[1]!));
		return json(r.body, r.status);
	}
	// The x (무시) on a question that waits, and its undo: off the badge and 답변 필요, kept in the history, nothing sent to the bot.
	const ignore = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/(ignore|unignore)$/.exec(url.pathname) : null;
	if (ignore) {
		const r = (ignore[2] === "ignore" ? ignoreNotice : unignoreNotice)(decodeURIComponent(ignore[1]!));
		return json(r.body, r.status);
	}
	return undefined;
}
