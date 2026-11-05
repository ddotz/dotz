// The gateway's own replies while a session waits on dotz_auth (hub/auth-wait.ts), against the real pending requests of hub/auth.ts.
import { afterEach, expect, test } from "bun:test";
import { type AuthWait, authRoute, cancelAuth, pendingWaits, setAuthOpened } from "./auth.ts";
import { cancelReply, openedText, untilText, waitNotice, type WaitDeps } from "./auth-wait.ts";
import { sessionKeyOf } from "./session-key.ts";

const call = (path: string, method = "GET", body?: unknown) =>
	authRoute(new Request(`http://local${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), new URL(`http://local${path}`))!;
const status = async (id: string) => ((await (await call(`/api/auth/${id}`)).json()) as { status: string }).status;

const opened: { w: AuthWait; discord: boolean }[] = [];
setAuthOpened((w, discord) => void opened.push({ w, discord }));
const made: string[] = [];
async function ask(target: string, site: string): Promise<string> {
	const r = await call("/api/auth", "POST", { site, kind: "secret", purpose: "ICON 로그인", target, timeout_minutes: 15 });
	const { id } = (await r.json()) as { id: string };
	made.push(id);
	return id;
}
afterEach(() => {
	for (const id of made.splice(0)) cancelAuth(id);
});

function deps() {
	const posts: { target: string; text: string; replyTo?: string }[] = [];
	const d: WaitDeps = {
		pending: pendingWaits,
		sameSession: (a, b) => sessionKeyOf(a, { on: true }) === sessionKeyOf(b, { on: true }),
		cancel: cancelAuth,
		post: (target, text, replyTo) => void posts.push({ target, text, replyTo }),
	};
	return { d, posts };
}

test("while the main session waits on dotz_auth, an owner message from JANDI gets one gateway notice with the purpose and the time it ends", async () => {
	const id = await ask("chat", "icon-wait");
	const at = opened.find(o => o.w.id === id);
	expect(at?.w.target).toBe("chat");
	expect(openedText(at!.w, "https://app.example/")).toContain("https://app.example/");
	const { d, posts } = deps();
	expect(waitNotice({ target: "web", text: "작동하고 있니?", owner: true, replyTo: "m1" }, d)).toBe(true);
	expect(posts).toHaveLength(1);
	expect(posts[0].target).toBe("web");
	expect(posts[0].replyTo).toBe("m1");
	expect(posts[0].text).toContain("ICON 로그인");
	expect(posts[0].text).toContain(untilText(at!.w.expiresAt));
	expect(await status(id)).toBe("pending");
});

test("no notice when nothing is pending for that session: none at all, or only another conversation's or a lane's", async () => {
	const { d, posts } = deps();
	expect(waitNotice({ target: "web", text: "대답", owner: true }, d)).toBe(false);
	await ask("ch:111", "icon-other");
	await ask("lane:build", "icon-lane");
	expect(waitNotice({ target: "web", text: "대답", owner: true }, d)).toBe(false);
	expect(cancelReply({ target: "web", text: "취소", owner: true }, d)).toBe(false);
	expect(posts).toEqual([]);
});

test("the owner's 취소 closes the pending request like DELETE /api/auth/<id>, and the session gets nothing", async () => {
	const id = await ask("chat", "icon-cancel");
	const { d, posts } = deps();
	expect(cancelReply({ target: "web", text: " 취소 ", owner: true, replyTo: "m2" }, d)).toBe(true);
	expect(await status(id)).toBe("cancelled");
	expect(posts).toHaveLength(1);
	expect(posts[0].text).toContain("ICON 로그인");
	expect(cancelReply({ target: "web", text: "취소", owner: true }, d)).toBe(false);
});

test("취소 from anyone but the owner is ignored and the request stays pending", async () => {
	const id = await ask("chat", "icon-stranger");
	const { d, posts } = deps();
	expect(cancelReply({ target: "web", text: "취소", owner: false }, d)).toBe(false);
	expect(waitNotice({ target: "web", text: "취소", owner: false }, d)).toBe(false);
	expect(await status(id)).toBe("pending");
	expect(posts).toEqual([]);
});
