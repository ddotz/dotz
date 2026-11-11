// HTTP routes of the notices (read, resolve, reopen, dismiss, ignore, viewing). Split out of routes.ts, called there at the same place of the chain.
import { droppedDraftRefs, restoreReopenedDrafts } from "./draft-restore.ts";
import { log } from "./config.ts";
import { viewConversation } from "./push.ts";
import { allNotices, dismissNotice, handledNotice, ignoreNotice, undismissNotice, markNoticesRead, reopenNotices, resolveNotices, unignoreNotice } from "./notices.ts";
import { json, body } from "./routes-util.ts";

export async function routeNotices(req: Request, url: URL): Promise<Response | undefined> {
	if (req.method === "POST" && url.pathname === "/api/notices/read") return json(markNoticesRead(await body(req)));
	// The bot closes the questions whose matter is over (ids, match text, conv or all): they are answered, read and off 답변 필요.
	if (req.method === "POST" && url.pathname === "/api/notices/resolve") return json(resolveNotices(await body(req)));
	// 되돌리기 after 보내지 않기 also puts the mail reply draft back in its store (the peer act notice reopen lands here too).
	if (req.method === "POST" && url.pathname === "/api/notices/reopen") {
		const ids = (await body(req)).ids, refs = droppedDraftRefs(allNotices(), ids);
		const r = reopenNotices(ids);
		await restoreReopenedDrafts(refs, r.reopened, log);
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
