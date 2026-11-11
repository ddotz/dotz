// The gateway's own replies while a session waits on dotz_auth (hub/auth-wait.ts), against the real pending requests of hub/auth.ts.
import { afterEach, expect, test } from "bun:test";
import { type AuthWait, authRoute, cancelAuth, pendingWaits, setAuthOpened } from "./auth.ts";
import { bareText, cancelReply, openedText, untilText, waitNotice, type WaitDeps } from "./auth-wait.ts";
import { orch } from "./orchestrator.ts";
import { flush, intake, sendWeb } from "./intake.ts";
import { msg } from "./i18n.ts";
import { asksPersonalInChat } from "./personal-ask.ts";
import { advance } from "./runtime/test-clock.ts";
import { sessionKeyOf } from "./session-key.ts";

const call = (path: string, method = "GET", body?: unknown) =>
	authRoute(new Request(`http://local${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), new URL(`http://local${path}`))!;
const status = async (id: string) => ((await (await call(`/api/auth/${id}`)).json()) as { status: string }).status;

const opened: { w: AuthWait; discord: boolean }[] = [];
setAuthOpened((w, discord) => void opened.push({ w, discord }));
const made: string[] = [];
// session: what the dotz_auth tool sends (extension/index.ts); a lane and kakao onboarding send none.
async function ask(target: string, site: string, session?: string): Promise<string> {
	const r = await call("/api/auth", "POST", { site, kind: "secret", purpose: "사이트 로그인", target, session, timeout_minutes: 15 });
	const { id } = (await r.json()) as { id: string };
	made.push(id);
	return id;
}
afterEach(() => {
	for (const id of made.splice(0)) cancelAuth(id);
});

function deps(busy = true) {
	const posts: { target: string; text: string; replyTo?: string }[] = [];
	const d: WaitDeps = {
		pending: pendingWaits,
		sessionOf: target => sessionKeyOf(target, { on: true }),
		busy: () => busy,
		cancel: cancelAuth,
		post: (target, text, replyTo) => void posts.push({ target, text, replyTo }),
	};
	return { d, posts };
}

test("while the main session waits on dotz_auth, an owner message from JANDI gets one gateway notice with the purpose and the time it ends", async () => {
	const id = await ask("chat", "icon-wait", "main");
	const at = opened.find(o => o.w.id === id);
	expect(at?.w.target).toBe("chat");
	expect(openedText(at!.w, "https://app.example/")).toContain("https://app.example/");
	const { d, posts } = deps();
	expect(waitNotice({ target: "web", text: "작동하고 있니?", owner: true, replyTo: "m1" }, d)).toBe(true);
	expect(posts).toHaveLength(1);
	expect(posts[0].target).toBe("web");
	expect(posts[0].replyTo).toBe("m1");
	expect(posts[0].text).toContain("사이트 로그인");
	expect(posts[0].text).toContain(untilText(at!.w.expiresAt));
	expect(await status(id)).toBe("pending");
});

test("no notice when no turn of that session waits: nothing pending, another session's, a lane's, or a session no longer in a turn", async () => {
	const { d, posts } = deps();
	expect(waitNotice({ target: "web", text: "대답", owner: true }, d)).toBe(false);
	await ask("ch:111", "icon-other", "ch:111");
	await ask("lane:build", "icon-lane");
	await ask("chat", "kakao");
	expect(opened.some(o => o.w.site === "icon-lane" || o.w.site === "kakao")).toBe(false);
	expect(waitNotice({ target: "web", text: "대답", owner: true }, d)).toBe(false);
	expect(cancelReply({ target: "web", text: "취소", owner: true }, d)).toBe(false);
	expect(posts).toEqual([]);
	const stopped = deps(false);
	expect(waitNotice({ target: "ch:111", text: "대답", owner: true }, stopped.d)).toBe(false);
	expect(stopped.posts).toEqual([]);
});

test("a request belongs to the session that asked, not to the target it named: a project's session asking with the default target", async () => {
	const id = await ask("chat", "icon-project", "ch:222");
	const { d, posts } = deps();
	expect(waitNotice({ target: "web", text: "대답", owner: true }, d)).toBe(false);
	expect(cancelReply({ target: "web", text: "취소", owner: true }, d)).toBe(false);
	expect(await status(id)).toBe("pending");
	expect(waitNotice({ target: "ch:222", text: "대답", owner: true }, d)).toBe(true);
	expect(posts.map(p => p.target)).toEqual(["ch:222"]);
});

test("separate messages hear the notice once per request and conversation, and again only after five minutes", async () => {
	await ask("chat", "icon-spam", "main");
	const { d, posts } = deps();
	for (const text of ["작동하고 있니?", "대답", "왜 안 해"]) waitNotice({ target: "web", text, owner: true }, d);
	expect(posts).toHaveLength(1);
	waitNotice({ target: "dm", text: "대답", owner: true }, d);
	expect(posts).toHaveLength(2);
	await advance(5 * 60_000);
	waitNotice({ target: "web", text: "대답", owner: true }, d);
	expect(posts).toHaveLength(3);
});

test("only one typed message is bare: a reply, quote, forward, decision answer, attachment or burst is not", () => {
	const typed = { text: "취소", attachments: [] };
	expect(bareText([typed])).toBe("취소");
	for (const extra of [{ reply: { author: "x", content: "y" } }, { quoted: true }, { reply_to: "m" }, { decision: "n1" }, { picks: [{ n: 1 }] }, { elements: [{}] }, { refs: ["r"] }, { attachments: [{ name: "a" }] }]) expect(bareText([{ ...typed, ...extra }])).toBe("");
	expect(bareText([typed, typed])).toBe("");
});

test("no notice reads as asking for personal data in chat, which would steer a false correction into the waiting session", () => {
	for (const l of [msg().authWaitNotice("카드 번호", "16:40 KST"), msg().authOpenNotice("카드 번호", "16:40 KST", msg().authOpenWhereApp), msg().authCancelledNotice("카드 번호")]) expect(asksPersonalInChat(l)).toBe(false);
});

test("the web composer's steer and a burst flushed by intake both close the request, and neither goes on to the session", async () => {
	const was = orch.status;
	orch.status = "working";
	try {
		const a = await ask("chat", "icon-steer", "main");
		await sendWeb({ channel: "web", text: "취소", mode: "steer", login: "local" });
		flush("web");
		expect(await status(a)).toBe("cancelled");
		const b = await ask("chat", "icon-flush", "main");
		intake({ kind: "message", source: "discord", channel: "chat", text: "취소", attachments: [] }, "chat");
		flush("chat");
		expect(await status(b)).toBe("cancelled");
	} finally {
		orch.status = was;
	}
});

test("the owner's 취소 closes the pending request like DELETE /api/auth/<id>, and the session gets nothing", async () => {
	const id = await ask("chat", "icon-cancel", "main");
	const { d, posts } = deps();
	expect(cancelReply({ target: "web", text: " 취소 ", owner: true, replyTo: "m2" }, d)).toBe(true);
	expect(await status(id)).toBe("cancelled");
	expect(posts).toHaveLength(1);
	expect(posts[0].text).toContain("사이트 로그인");
	expect(cancelReply({ target: "web", text: "취소", owner: true }, d)).toBe(false);
});

test("취소 from anyone but the owner is ignored and the request stays pending", async () => {
	const id = await ask("chat", "icon-stranger", "main");
	const { d, posts } = deps();
	expect(cancelReply({ target: "web", text: "취소", owner: false }, d)).toBe(false);
	expect(waitNotice({ target: "web", text: "취소", owner: false }, d)).toBe(false);
	expect(await status(id)).toBe("pending");
	expect(posts).toEqual([]);
});
