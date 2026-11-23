import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { emit } from "./events.ts";
import { advanceTimers, ev, fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

const SHOTS = process.env.MAIL_B_SHOTS ?? "";
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const LISTED = "목록에서 지웠어요 · 원본은 그대로예요";
const NEWER = "새 답장이 와서 이 메일은 지우지 않았어요";

type Mail = { key: string; subject: string; from: string; at: string; read: boolean; mark: string };
const fresh = (): Mail[] => [
	{ key: "fx-a", subject: "sample-1 보고서", from: "Sample One <one@example.com>", at: ago(1), read: false, mark: "m-a1" },
	{ key: "fx-b", subject: "sample-2 일정", from: "Sample Two <two@example.com>", at: ago(2), read: false, mark: "m-b1" },
	{ key: "fx-c", subject: "sample-3 견적", from: "Sample Three <three@example.com>", at: ago(3), read: true, mark: "m-c1" },
];
let mails = fresh();
type Post = { path: string; body: unknown };
let posts = inbox<Post>();
let convAsks = inbox<string>();
type Gate = { p: Promise<void>; open: () => void };
const gateOf = (): Gate => { const { promise, resolve } = Promise.withResolvers<void>(); return { p: promise, open: resolve }; };
let gate: Gate | null = null;
let fail: Record<string, () => Response> = {};

const trash = (key: string, mark: unknown): Response => {
	const m = mails.find(x => x.key === key);
	if (!m) return json({ error: "이 메일을 찾지 못했어요", gone: true }, 404);
	if (mark !== undefined && mark !== m.mark) return json({ error: NEWER, newer: true }, 409);
	mails = mails.filter(x => x !== m);
	return json({ ok: true, synced: false });
};
const hub = fakeHub({
	slowTimers: true,
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: mails.filter(m => !m.read).length, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } }], available: [] });
		if (p === "/api/conversations") {
			convAsks.push(url.search);
			return json({ items: mails.map(m => ({ target: `mail:${m.key}`, unread: m.read ? 0 : 1, read: null, mail: { subject: m.subject, from: m.from, source: "acme", at: m.at, summary: m.subject, read: m.read, can: CAN, mark: m.mark }, last: { ts: m.at, text: m.subject, from: "bot" } })) });
		}
		const one = /^\/api\/mail\/([^/]+)\/action$/.exec(p);
		if (one && req.method === "POST") {
			const body = (await req.json()) as { action: string; mark?: string }; posts.push({ path: p, body });
			if (gate) await gate.p;
			const forced = fail[one[1]!];
			if (forced) { delete fail[one[1]!]; return forced(); }
			return trash(one[1]!, body.mark);
		}
		if (p === "/api/mail/actions" && req.method === "POST") {
			const body = (await req.json()) as { keys: string[]; action: string; marks?: Record<string, string> }; posts.push({ path: p, body });
			if (gate) await gate.p;
			const results = [];
			for (const key of body.keys) { const r = trash(key, body.marks?.[key]); const d = (await r.json()) as Record<string, unknown>; results.push(r.ok ? { key, ...d } : { key, ok: false, synced: false, note: d.error, ...(d.gone ? { gone: true } : {}), ...(d.newer ? { newer: true } : {}) }); }
			return json({ ok: true, results });
		}
	},
});
afterAll(() => hub.stop());
beforeEach(() => { mails = fresh(); posts = inbox<Post>(); convAsks = inbox<string>(); gate = null; fail = {}; });
afterEach(() => { gate?.open(); hub.release(); });

const rowJs = (title: string) => `[...document.querySelectorAll("#mon-tl > .mr")].find(r => r.querySelector(".rc-title").textContent === ${JSON.stringify(title)})`;
const tick = (v: View, title: string) => run(v, `${rowJs(title)}.querySelector(".mr-chk").click()`);
const pickBar = (v: View, label: string) => run(v, `[...document.querySelectorAll("#mbox-bar .mbox-b")].find(b => b.getAttribute("aria-label").startsWith(${JSON.stringify(label)})).click()`);
const snack = (v: View) => ev<{ text: string; act: string; bad: boolean } | null>(v, `(() => { const n = document.querySelector(".snack"); return n ? { text: n.querySelector("span").textContent, act: n.querySelector(".sa")?.textContent ?? "", bad: n.classList.contains("bad") } : null; })()`);
const snackSays = (v: View, text: string) => waitFor(v, `document.querySelector(".snack span")?.textContent === ${JSON.stringify(text)}`);
const sent = (n: number, what: string) => posts.until(p => p.length === n, 8000, what);
const settled = (v: View) => waitFor(v, `!document.getAnimations().some(a => a.playState === "running" && a.effect.getTiming().iterations !== Infinity)`);
const shot = async (v: View, name: string) => { if (!SHOTS) return; await settled(v); mkdirSync(SHOTS, { recursive: true }); await Bun.write(`${SHOTS}/${name}.png`, await v.screenshot()); };
const titles = (v: View) => ev<string[]>(v, `[...document.querySelectorAll("#mon-tl > .mr .rc-title")].map(t => t.textContent)`);
const reload = (v: View) => v.evaluate(`convLoad().then(() => 0)`);
const watchRow = (v: View, key: string) => run(v, `window.__back = []; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches('.mr[data-t="mail:${key}"]') || n.querySelector('.mr[data-t="mail:${key}"]'))) __back.push(Date.now()); }).observe(document.body, { childList: true, subtree: true })`);
const drawnAgain = (v: View) => ev<number>(v, `__back.length`);
const SIZES = [[390, 844], [1280, 800]] as const;

async function openList(width: number, height: number): Promise<View> {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && typeof NM !== "undefined" && NM.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 1 && CONV.has("mail:fx-a")`);
	await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
	await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
	await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
	await waitFor(v, `document.querySelector("#mon-tl .mr") && document.querySelector("#mbox-bar")`);
	return v;
}
async function deleteOne(v: View, title: string) {
	await tick(v, title);
	await pickBar(v, "삭제");
	await waitFor(v, `!${rowJs(title)}`);
}

describe("a deleted mail stays deleted on the page", () => {
	for (const [width, height] of SIZES) test(`a list reload and a live mail event inside the 6 s, and the wait for the hub after them, never draw the row again at ${width}`, async () => {
		const v = await openList(width, height);
		await deleteOne(v, "sample-1 보고서");
		await snackSays(v, LISTED);
		expect((await snack(v))!.act).toBe("되돌리기");
		await shot(v, `delete-listed-toast-${width}`);
		await watchRow(v, "fx-a");
		const asked = convAsks.length;
		emit("outbox", { kind: "mail_unreplied", ts: new Date().toISOString(), source: "gateway", channel: "web", text: "" } as never);
		await convAsks.until(a => a.length > asked, 8000, "the live reload");
		emit("outbox", { kind: "mail", target: "mail:fx-a", subject: "sample-1 보고서", from: "Sample One <one@example.com>", source: "acme", ts: new Date().toISOString(), text: "sample-1 보고서" } as never);
		await reload(v);
		expect(await titles(v)).not.toContain("sample-1 보고서");
		await shot(v, `delete-reload-in-window-${width}`);
		gate = gateOf();
		await advanceTimers(v, 6000);
		await sent(1, "the trash request");
		await reload(v);
		expect(await titles(v)).not.toContain("sample-1 보고서");
		gate.open();
		await waitFor(v, `!document.querySelector(".snack")`);
		await reload(v);
		expect(await drawnAgain(v)).toBe(0);
		expect(await titles(v)).toEqual(["sample-2 일정", "sample-3 견적"]);
		expect(posts[0]).toEqual({ path: "/api/mail/fx-a/action", body: { action: "trash", mark: "m-a1" } });
	}, 40_000);

	test("once the hub deleted it, a new mail under the same key draws again, also one without message ids", async () => {
		Object.assign(mails[2]!, { mark: "" });
		const v = await openList(1280, 800);
		await deleteOne(v, "sample-3 견적");
		await advanceTimers(v, 6000);
		await sent(1, "the trash request");
		await waitFor(v, `!document.querySelector(".snack")`);
		await reload(v);
		mails.push({ key: "fx-c", subject: "Re: sample-3 견적", from: "Sample Three <three@example.com>", at: new Date().toISOString(), read: false, mark: "" });
		await reload(v);
		await waitFor(v, `${rowJs("Re: sample-3 견적")}`);
	}, 30_000);

	test("되돌리기 forgets the delete: the row is back and a reload keeps it", async () => {
		const v = await openList(1280, 800);
		await deleteOne(v, "sample-2 일정");
		await snackSays(v, LISTED);
		await run(v, `document.querySelector(".snack .sa").click()`);
		await waitFor(v, `${rowJs("sample-2 일정")}`);
		await reload(v);
		await advanceTimers(v, 7000);
		expect(await titles(v)).toContain("sample-2 일정");
		expect([...posts]).toEqual([]);
	}, 30_000);
});

describe("leaving the page inside the 6 s", () => {
	test("a reload sends the delete as a keepalive request; hiding the page sends nothing", async () => {
		const v = await openList(1280, 800);
		await run(v, `const f0 = window.fetch; window.fetch = (u, o) => { if (o && o.keepalive) sessionStorage.setItem("mail-b-keepalive", String(u)); return f0(u, o); }`);
		await deleteOne(v, "sample-1 보고서");
		await run(v, `Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"))`);
		await advanceTimers(v, 3000);
		await reload(v);
		expect([...posts]).toEqual([]);
		await run(v, `delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event("visibilitychange"))`);
		await run(v, `location.reload()`);
		await sent(1, "the delete sent on the way out");
		expect(posts[0]).toEqual({ path: "/api/mail/fx-a/action", body: { action: "trash", mark: "m-a1" } });
		await waitFor(v, `typeof CONV !== "undefined" && CONV.has("mail:fx-b")`);
		expect(await ev<string | null>(v, `sessionStorage.getItem("mail-b-keepalive")`)).toBe("/api/mail/fx-a/action");
		expect(mails.map(m => m.key)).toEqual(["fx-b", "fx-c"]);
	}, 30_000);
});

describe("a delete the hub did not do", () => {
	for (const [width, height] of SIZES) test(`삭제하지 못했어요 · the hub's reason · 다시 시도 brings the row back, and 다시 시도 sends at once at ${width}`, async () => {
		fail = { "fx-a": () => json({ error: "메일함 연결이 끊겼어요" }, 500) };
		const v = await openList(width, height);
		await deleteOne(v, "sample-1 보고서");
		await advanceTimers(v, 6000);
		await snackSays(v, "삭제하지 못했어요 · 메일함 연결이 끊겼어요");
		expect(await snack(v)).toEqual({ text: "삭제하지 못했어요 · 메일함 연결이 끊겼어요", act: "다시 시도", bad: true });
		await waitFor(v, `${rowJs("sample-1 보고서")}`);
		await shot(v, `delete-failed-retry-${width}`);
		await run(v, `document.querySelector(".snack .sa").click()`);
		await sent(2, "the retry");
		expect(posts[1]).toEqual({ path: "/api/mail/fx-a/action", body: { action: "trash", mark: "m-a1" } });
		await waitFor(v, `!${rowJs("sample-1 보고서")}`);
		expect(mails.map(m => m.key)).toEqual(["fx-b", "fx-c"]);
	}, 30_000);

	for (const end of ["undone", "sent"] as const) test(`a failed send waits while a later delete's 되돌리기 is up, and shows once that delete is ${end}`, async () => {
		fail = { "fx-a": () => json({ error: "메일함 연결이 끊겼어요" }, 500) };
		const v = await openList(1280, 800);
		await deleteOne(v, "sample-1 보고서");
		gate = gateOf();
		await advanceTimers(v, 6000);
		await sent(1, "the first trash request");
		await waitFor(v, `${rowJs("sample-2 일정")}`);
		await deleteOne(v, "sample-2 일정");
		await snackSays(v, LISTED);
		gate.open();
		await waitFor(v, `${rowJs("sample-1 보고서")}`);
		expect(await snack(v)).toEqual({ text: LISTED, act: "되돌리기", bad: false });
		if (end === "undone") {
			await run(v, `document.querySelector(".snack .sa").click()`);
			await waitFor(v, `${rowJs("sample-2 일정")}`);
		} else {
			await advanceTimers(v, 6000);
			await sent(2, "the second trash request");
		}
		await snackSays(v, "삭제하지 못했어요 · 메일함 연결이 끊겼어요");
		expect((await snack(v))!.act).toBe("다시 시도");
		expect(mails.map(m => m.key)).toEqual(end === "undone" ? ["fx-a", "fx-b", "fx-c"] : ["fx-a", "fx-c"]);
	}, 30_000);

	test("no answer from the hub: 삭제하지 못했어요 · 서버에 닿지 않았어요", async () => {
		fail = { "fx-a": () => new Response("", { status: 502 }) };
		const v = await openList(1280, 800);
		await deleteOne(v, "sample-1 보고서");
		await advanceTimers(v, 6000);
		await snackSays(v, "삭제하지 못했어요 · 서버에 닿지 않았어요");
		expect((await snack(v))!.act).toBe("다시 시도");
		await waitFor(v, `${rowJs("sample-1 보고서")}`);
	}, 30_000);

	test("a mail already deleted elsewhere leaves the list without a word", async () => {
		const v = await openList(1280, 800);
		await deleteOne(v, "sample-2 일정");
		mails = mails.filter(m => m.key !== "fx-b");
		await advanceTimers(v, 6000);
		await sent(1, "the trash request");
		await waitFor(v, `!document.querySelector(".snack")`);
		await reload(v);
		expect(await titles(v)).toEqual(["sample-1 보고서", "sample-3 견적"]);
		expect(await ev<boolean>(v, `MAILS.has("mail:fx-b")`)).toBe(false);
	}, 30_000);

	test("a newer reply that a list reload drew inside the 6 s is not deleted", async () => {
		const v = await openList(1280, 800);
		await deleteOne(v, "sample-1 보고서");
		Object.assign(mails[0]!, { subject: "Re: sample-1 보고서", at: new Date().toISOString(), read: false, mark: "m-a2" });
		await reload(v);
		await waitFor(v, `${rowJs("Re: sample-1 보고서")}`);
		await advanceTimers(v, 6000);
		await sent(1, "the trash request");
		expect(posts[0]).toEqual({ path: "/api/mail/fx-a/action", body: { action: "trash", mark: "m-a1" } });
		await snackSays(v, NEWER);
		expect(mails.map(m => m.key)).toEqual(["fx-a", "fx-b", "fx-c"]);
		await waitFor(v, `${rowJs("Re: sample-1 보고서")}`);
	}, 30_000);

	for (const [width, height] of SIZES) test(`a newer reply inside the 6 s is not deleted and shows as a new mail at ${width}`, async () => {
		const v = await openList(width, height);
		await deleteOne(v, "sample-1 보고서");
		Object.assign(mails[0]!, { subject: "Re: sample-1 보고서", at: new Date().toISOString(), read: false, mark: "m-a2" });
		await advanceTimers(v, 6000);
		await sent(1, "the trash request");
		await snackSays(v, NEWER);
		expect((await snack(v))!.bad).toBe(false);
		await waitFor(v, `${rowJs("Re: sample-1 보고서")}`);
		expect(mails.map(m => m.key)).toEqual(["fx-a", "fx-b", "fx-c"]);
		await shot(v, `delete-newer-reply-${width}`);
	}, 30_000);
});
