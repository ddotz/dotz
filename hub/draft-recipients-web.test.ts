import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { offerMailDraft } from "../features/reply-drafts/lib/offer.ts";
import { dataDir, paths } from "../features/reply-drafts/lib/settings.ts";
import { listDrafts, setStatus } from "../features/reply-drafts/lib/store.ts";
import { draftRecipientsRoute } from "./draft-recipients.ts";
import { emit } from "./events.ts";
import { postMail, type MailDeps } from "./mail.ts";
import { setOwnAddresses } from "./mail-state.ts";
import { listNotices, markNoticesRead, resetNoticesForTest, unreadCount } from "./notices.ts";
import { fakeHub, json, waitFor, type View } from "./test-web.ts";

// The send sheet of a mail reply draft (web/js/10-decision-card.js draftToNode): 답장 | 전체 답장, the 받는이·참조 chips, x to take one off and
// one add field per row. Headless browser against the real draft store, notice store and the recipients route; nothing is sent.
const BODY = "확인했습니다. 그때 봬요.";
const reply = (to: string) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "answers a meeting", to, subject: "Re: 회의", body: BODY, questions: [] })}\n\`\`\``;
const posts: { path: string; body: Record<string, unknown> }[] = [];

const hub = fakeHub({
	api: async (req, url) => {
		const recipients = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/recipients$/.exec(url.pathname);
		if (recipients) {
			if (req.method === "POST") {
				const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
				posts.push({ path: url.pathname, body });
			}
			return draftRecipientsRoute(req, recipients[1]!);
		}
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unreadCount() });
		if (url.pathname === "/api/notices" && req.method === "GET") return json(listNotices(100));
		if (url.pathname === "/api/notices/read") return json(markNoticesRead(await req.json()));
	},
});
const base = `${hub.origin}/`;
const texts = async (v: View, sel: string): Promise<string[]> => JSON.parse(await v.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim()))`));
const click = (v: View, sel: string) => v.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const settled = (v: View) => v.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => 0))).then(() => true)`);
const chips = (v: View, row: string) => texts(v, `.fs-body .dr-rcrow[data-row="${row}"] .dr-rc-t`);

const deps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: () => undefined, wake: () => undefined };
let ref = "";
const draftId = () => listDrafts().find(d => d.ref === ref)!.id;
const notice = () => listNotices(300).items.find(n => n.decision?.draft?.ref === draftId())!;
const openSheet = async (v: View) => {
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(notice().id))})`);
	await waitFor(v, `document.querySelector(".fs-body .dr-seg") && document.querySelector(".fs-body .dr-rcrow[data-row='to'] .dr-rc-add")`);
	await settled(v);
};

beforeAll(async () => {
	resetNoticesForTest();
	setOwnAddresses("config", ["me@example.net"]);
	const mailed = await postMail({ source: "zele", id: "web-1", subject: "회의", from: "Kim <kim@example.com>", to: "Me <me@example.net>, Lee <lee@example.com>", cc: "Park <park@example.com>", body: "회의 일정 문의" }, deps);
	ref = mailed.key;
	mkdirSync(join(paths.config(), ".."), { recursive: true });
	writeFileSync(paths.config(), JSON.stringify({ enabled: true }));
	const offered = await offerMailDraft(
		{ key: ref, target: "main", source: "zele", id: "web-1", subject: "회의", from: "Kim <kim@example.com>", to: "Me <me@example.net>, Lee <lee@example.com>", cc: "Park <park@example.com>", body: "회의 일정 문의" },
		{ send: (_t, text) => void emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text }), call: async () => reply("kim@example.com") },
	);
	if (offered !== "offered") throw new Error(`draft not offered: ${offered}`);
	markNoticesRead({ all: true });
});
afterAll(() => {
	hub.stop();
	// The draft flow also leaves the feature's personal switch (<data>/features/reply-drafts), which later tests read as a feature of the owner's.
	for (const p of [paths.config(), paths.drafts(), join(dataDir(), "features", "reply-drafts")]) rmSync(p, { force: true, recursive: true });
});

test("전체 답장, a chip off and one added: each is one request and the card shows the same list", async () => {
	expect(notice().decision!.state).toBe("open");
	const v = await hub.view({ width: 390, height: 844 });
	await v.navigate(base);
	await openSheet(v);
	expect(await texts(v, ".fs-body .dr-seg button")).toEqual(["답장", "전체 답장"]);
	expect(await v.evaluate(`document.querySelector(".fs-body .dr-seg button[data-k='mode-reply']").getAttribute("aria-pressed")`)).toBe("true");
	expect(await chips(v, "to")).toEqual(["kim@example.com"]);
	expect(await chips(v, "cc")).toEqual([]);

	await click(v, ".fs-body .dr-seg button[data-k='mode-all']");
	await waitFor(v, `document.querySelectorAll(".fs-body .dr-rcrow[data-row='to'] .dr-rc-t").length === 2 && document.querySelectorAll(".fs-body .dr-rcrow[data-row='cc'] .dr-rc-t").length === 1`);
	expect(await chips(v, "to")).toEqual(["kim@example.com", "lee@example.com"]);
	expect(await chips(v, "cc")).toEqual(["park@example.com"]);
	expect(posts.at(-1)).toEqual({ path: `/api/drafts/${draftId()}/recipients`, body: { mode: "all" } });
	expect(await v.evaluate(`document.querySelector(".fs-body .dr-seg button[data-k='mode-all']").getAttribute("aria-pressed")`)).toBe("true");

	await click(v, ".fs-body .dr-rcrow[data-row='cc'] .dr-rc-x");
	await waitFor(v, `document.querySelectorAll(".fs-body .dr-rcrow[data-row='cc'] .dr-rc-t").length === 0`);
	expect(posts.at(-1)!.body).toEqual({ cc: [] });

	await click(v, ".fs-body .dr-rcrow[data-row='to'] .dr-rc-add");
	await waitFor(v, `document.querySelector(".fs-body .dr-rcrow[data-row='to'] .dr-rc-in")`);
	await v.evaluate(`(() => { document.querySelector(".fs-body .dr-rcrow[data-row='to'] .dr-rc-in").value = "new@example.org"; })()`);
	await click(v, ".fs-body .dr-rcrow[data-row='to'] .dr-rc-go");
	await waitFor(v, `[...document.querySelectorAll(".fs-body .dr-rcrow[data-row='to'] .dr-rc-t")].some(e => e.textContent === "new@example.org")`);
	expect(posts.at(-1)!.body).toEqual({ to: ["kim@example.com", "lee@example.com", "new@example.org"] });
	expect(await chips(v, "to")).toEqual(["kim@example.com", "lee@example.com", "new@example.org"]);

	await click(v, ".fs-body .dr-seg button[data-k='mode-reply']");
	await waitFor(v, `document.querySelectorAll(".fs-body .dr-rcrow[data-row='to'] .dr-rc-t").length === 1`);
	expect(await chips(v, "to")).toEqual(["kim@example.com"]);
	expect(await chips(v, "cc")).toEqual([]);
	expect(posts.at(-1)!.body).toEqual({ mode: "reply" });

	// The stored card and its text hold the last state, so every other view and a restart read the same list.
	const d = listDrafts().find(x => x.id === draftId())!;
	expect(d).toMatchObject({ to: "kim@example.com", cc: [], mode: "reply" });
	expect(notice().decision!.draft).toMatchObject({ to: "kim@example.com", mode: "reply" });
	expect(notice().text).toContain("> 받는이: kim@example.com\n");
	expect(notice().text).not.toContain("> 참조:");
});

test("a draft that is no longer pending shows its 받는이·참조 read only, and the route refuses it", async () => {
	setStatus(draftId(), "sent");
	const v = await hub.view({ width: 390, height: 844 });
	await v.navigate(base);
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(notice().id))})`);
	await waitFor(v, `document.querySelector(".fs-body .dr-rcrow[data-row='to'] .dr-rc-t")`);
	expect(await chips(v, "to")).toEqual(["kim@example.com"]);
	expect(await v.evaluate(`!!document.querySelector(".fs-body .dr-rc-add, .fs-body .dr-rc-x")`)).toBe(false);
	expect((await fetch(`${base}api/drafts/${draftId()}/recipients`).then(r => r.json())) as object).toMatchObject({ editable: false, reply: true });
	const r = await fetch(`${base}api/drafts/${draftId()}/recipients`, { method: "POST", body: JSON.stringify({ to: ["lee@example.com"] }) });
	expect(r.status).toBe(409);
});
