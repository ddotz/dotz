import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { offerMailDraft } from "../features/reply-drafts/lib/offer.ts";
import { paths } from "../features/reply-drafts/lib/settings.ts";
import { listDrafts } from "../features/reply-drafts/lib/store.ts";
import { commentAsk } from "./comments/ask.ts";
import { type Comment, commentId, type SourceConfig } from "./comments/contract.ts";
import { commentsDir, createStore, type Draft } from "./comments/store.ts";
import { DATA_DIR } from "./config.ts";
import { draftAttachRoute } from "./draft-attach.ts";
import { emit, sseResponse } from "./events.ts";
import { MAIL_FILES, mailBodyRoute, recordMail } from "./mail.ts";
import { listNotices, markNoticesRead, type Notice, resolveNotices, unreadCount } from "./notices.ts";
import { PEER_GET } from "./peer-auth.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 원문 보기 in the send sheet (web/js/10-draft-original.js, GET /api/drafts/<ref>/original): closed by default, the first open fetches the mail once and keeps it.
// Wide (>= 900px): the original is a separate panel left of the draft, the draft slides right and keeps its size. Narrow: a 초안 | 원문 toggle slides between them.
// A vanished mail says so, a peer's draft is read through /api/peer/proxy, and the draft's one-row buttons keep their actions.
// The same component shows the comment a comment reply draft answers (hub/comments/original.ts): the sheet of an [ask], a combined reply + mail card, and the comment view's own draft card.
// Headless browser against the real draft store, notice store and draft route; nothing is sent.
const SNAP = "/tmp/dotz-draft-original";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const BODY = Array.from({ length: 14 }, (_, i) => `${i + 1}번째 줄이에요. 다음 주 월요일 회의 일정과 담당을 다시 확인해 주시면 감사하겠습니다.`).join("\n");
const hits: Record<string, number> = {};
const proxied: string[] = [];
const gone = new Set<string>();
const route = (req: Request, url: URL, ref: string) => {
	hits[ref] = (hits[ref] ?? 0) + 1;
	return gone.has(ref) ? json({ error: "원문을 찾을 수 없어요" }, 404) : draftAttachRoute(req, url, ref, "original");
};
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		const orig = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/original$/.exec(url.pathname);
		if (orig) return route(req, url, orig[1]!);
		if (url.pathname === "/api/peer/proxy") {
			const p = new URL(url.searchParams.get("p")!, "http://peer");
			proxied.push(`${url.searchParams.get("pc")}${p.pathname}`);
			const po = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/original$/.exec(p.pathname);
			return po ? draftAttachRoute(req, p, po[1]!, "original") : json({}, 404);
		}
		const body = /^\/api\/mail\/([a-z0-9._-]+)\/body$/.exec(url.pathname);
		if (body) return mailBodyRoute(body[1]!);
		const attach = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/(files|library)$/.exec(url.pathname);
		if (attach) return draftAttachRoute(req, url, attach[1]!, attach[2]!);
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unreadCount() });
		if (url.pathname === "/api/notices" && req.method === "GET") return json(listNotices(100));
		if (url.pathname === "/api/notices/read") return json(markNoticesRead(await req.json()));
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const base = `http://127.0.0.1:${server.port}/`;
type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = async (width: number, height: number): Promise<View> => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(base);
	return v;
};
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(
		`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const done = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); o.disconnect(); res(true); } return ok; }; const o = new MutationObserver(done); o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); done(); })`,
	);
const settled = (v: View) => v.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => 0))).then(() => true)`);
type Box = { l: number; t: number; r: number; b: number; w: number; h: number };
const box = async (v: View, sel: string): Promise<Box | null> =>
	JSON.parse(await v.evaluate(`JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })())`));
const text = (v: View, sel: string): Promise<string> => v.evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
const click = (v: View, sel: string) => v.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);

const drafts: Record<string, string> = {};
// A comment reply draft is the comment engine's (hub/comments): the stored comments, the post's title and thumbnail, and a draft code the [ask] carries as its ref.
const CSRC: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const THUMB = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#c0392b"/><path d="M26 14l16 10-16 10z" fill="#fff"/></svg>')}`;
const CT0 = Date.parse("2026-10-24T01:30:00.000Z");
const cm = (native: string, o: Partial<Comment>): Comment => ({ id: commentId("youtube", native), source: "youtube", native, thread: "v1", author: "팬", text: "", postTitle: "행방불명 OST 피아노 연주", postLink: "https://www.youtube.com/watch?v=v1", thumb: THUMB, at: CT0, mine: false, collector: "test", ...o });
const CTEXT = "영상 잘 봤어요! 이 곡 악보는 어디서 받을 수 있나요? 연습해 보고 싶어요.";
const code: Record<string, string> = { top: "DTOP000001", reply: "DREPLY0001", gone: "DGONE00001", peer: "DPEER00001", combo: "DCOMBO0001", card: "DCARD00001" };
const draftOf = (c: string, commentId: string, text: string): Draft => ({ code: c, commentId, source: "youtube", thread: "v1", text, status: "pending", created: CT0 + 1000, changes: [], clean: true, notes: [] });
function seedComments() {
	const st = createStore(commentsDir(DATA_DIR));
	st.saveConfig({ enabled: true, sources: { youtube: CSRC } });
	const top = cm("top", { author: "김팬", text: CTEXT });
	const first = cm("first", { author: "이독자", text: "저도 악보가 궁금해요", at: CT0 - 60_000 });
	const answer = cm("answer", { author: "박답글", text: "링크 부탁드려요!", parent: "first", at: CT0 + 60_000 });
	st.addComments([top, first, answer]);
	const body = "봐 주셔서 감사합니다. 악보는 설명란 링크에서 받으실 수 있어요.";
	const mail = { app: "mail", to: "fan@example.com", subject: "악보 보내드립니다", body: "안녕하세요.\n요청하신 악보를 보내드립니다." };
	const ask = (c: Comment, d: Draft, withMail = false) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: commentAsk(CSRC, c, d, undefined, withMail ? mail : undefined) });
	for (const [key, c, withMail] of [["top", top, false], ["reply", answer, false], ["peer", top, false], ["combo", top, true]] as const) {
		const d = draftOf(code[key]!, c.id, body);
		st.putDraft(d);
		void ask(c, d, withMail);
	}
	st.putDraft(draftOf(code.gone!, commentId("youtube", "deleted"), body));
	void ask(top, draftOf(code.gone!, top.id, body));
	st.putDraft(draftOf(code.card!, top.id, body));
}
const mailAt = "2026-10-24T01:30:00.000Z";
async function offer(name: string, mail: { key: string; html?: boolean }) {
	recordMail({
		key: mail.key,
		source: "zele",
		id: `msg-${mail.key}`,
		subject: "다음 주 일정 확인 부탁드립니다",
		from: "Kim Minsu <kim@example.com>",
		to: "me@example.net",
		at: mailAt,
		attachments: [{ name: "일정표.pdf", type: "application/pdf", size: 348_160, file: `${mail.key}/0/일정표.pdf` }],
		...(mail.html ? { html: true as const } : {}),
	});
	if (mail.html) {
		mkdirSync(join(MAIL_FILES, mail.key), { recursive: true });
		writeFileSync(join(MAIL_FILES, mail.key, "body.html"), `<p>안녕하세요, <b>김민수</b>입니다.</p><p>${BODY.replaceAll("\n", "<br>")}</p>`);
	}
	const reply = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "kim@example.com", subject: "Re: 다음 주 일정 확인 부탁드립니다", body: "안녕하세요 김민수 님.\n\n말씀하신 일정 확인했습니다. 월요일 오전 10시에 뵙겠습니다.\n\n감사합니다.", questions: [] })}\n\`\`\``;
	await offerMailDraft(
		{ key: mail.key, target: "main", source: "zele", id: `msg-${mail.key}`, subject: "다음 주 일정 확인 부탁드립니다", from: "Kim Minsu <kim@example.com>", to: "me@example.net", body: BODY },
		{ send: (_t, t) => void emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: t }), call: async () => reply },
	);
	drafts[name] = listDrafts().find(d => d.ref === mail.key)!.id;
}
const stored = () => listNotices(300).items;
const find = (ref: string) => stored().find(n => n.kind === "decision" && n.decision?.state === "open" && n.decision.draft?.ref === ref)! as Notice;
const openSheet = async (v: View, ref: string, before = "") => {
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	if (before) await v.evaluate(before);
	await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(find(ref).id))})`);
	await waitFor(v, `document.querySelector(".fs-bd .fs-card .od-tg")`);
	await settled(v);
};
const theme = (v: View, t: "light" | "dark") => v.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
const expanded = (v: View) => v.evaluate(`document.querySelector(".od-tg").getAttribute("aria-expanded")`);
const wide = (v: View): Promise<boolean> => v.evaluate(`innerWidth >= 900`);
// The way a person opens / closes the original at this width: the 원문 보기 button and the panel's x (wide), or the 초안 | 원문 toggle (narrow).
const showOrig = async (v: View, scope = "") => click(v, (await wide(v)) ? `${scope} .od-tg` : `${scope} .od-sg[data-v="orig"]`);
const showDraft = async (v: View, scope = "") => click(v, (await wide(v)) ? `${scope} .od-x` : `${scope} .od-sg[data-v="draft"]`);

beforeAll(async () => {
	Bun.spawnSync(["mkdir", "-p", SNAP]);
	resolveNotices({ ids: stored().filter(n => n.decision?.state === "open").map(n => n.id) });
	markNoticesRead({ all: true });
	mkdirSync(join(paths.config(), ".."), { recursive: true });
	writeFileSync(paths.config(), JSON.stringify({ enabled: true }));
	await offer("plain", { key: "org-plain" });
	await offer("html", { key: "org-html", html: true });
	await offer("gone", { key: "org-gone" });
	await offer("peer", { key: "org-peer" });
	seedComments();
});
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
	for (const p of [paths.config(), paths.drafts(), join(paths.personalFeature(), ".."), join(paths.config(), "..", "..", "..", "draft-files"), ...["org-plain", "org-html", "org-gone", "org-peer"].map(k => join(MAIL_FILES, k))]) rmSync(p, { force: true, recursive: true });
	rmSync(commentsDir(DATA_DIR), { force: true, recursive: true });
});

describe("GET /api/drafts/<ref>/original", () => {
	test("the mail a draft answers: sender, recipient, date, subject, text and files; the peer read list allows it", async () => {
		const res = await draftAttachRoute(new Request("http://x/"), new URL("http://x/"), drafts.plain!, "original");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ kind: "mail", key: "org-plain", from: "Kim Minsu <kim@example.com>", to: "me@example.net", date: mailAt, subject: "다음 주 일정 확인 부탁드립니다", text: BODY, html: false, attachments: [{ name: "일정표.pdf", type: "application/pdf", size: 348_160 }] });
		expect(((await (await draftAttachRoute(new Request("http://x/"), new URL("http://x/"), drafts.html!, "original")).json()) as { html: boolean }).html).toBe(true);
		expect(PEER_GET.some(r => r.test(`/api/drafts/${drafts.peer}/original`))).toBe(true);
	});

	test("a draft that is not in the store has no original: 404 with the owner's wording", async () => {
		const res = await draftAttachRoute(new Request("http://x/"), new URL("http://x/"), "RNOPE0000", "original");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "원문을 찾을 수 없어요" });
	});
});

const mountCard = (v: View, ref: string) =>
	v.evaluate(`(() => { CM.view = { comments: [{ id: ${JSON.stringify(commentId("youtube", "top"))}, author: "김팬" }], sends: [], drafts: [] };
		const box = el("div", { class: "kk-drafts", id: "t-box", style: "position:fixed;left:8px;top:8px;width:" + (innerWidth - 16) + "px;z-index:9999;background:var(--bg)" });
		document.body.append(box);
		box.append(cmDraftCard({ code: ${JSON.stringify(ref)}, commentId: ${JSON.stringify(commentId("youtube", "top"))}, text: "봐 주셔서 감사합니다. 악보는 설명란 링크에서 받으실 수 있어요.", notes: [] })); })()`);

describe("원문 보기 in the send sheet", () => {
	test("closed by default and nothing fetched; wide: a separate panel opens left and the draft slides right at the same size; narrow: the toggle slides between them", async () => {
		const ref = drafts.plain!;
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			const isWide = w >= 900;
			delete hits[ref];
			await openSheet(v, ref);
			expect(await expanded(v)).toBe("false");
			expect(await text(v, ".od-tt")).toBe("원문 보기");
			expect(await v.evaluate(`document.querySelector(".od-orig").hasAttribute("inert")`)).toBe(true);
			expect(hits[ref] ?? 0).toBe(0);
			if (isWide) expect((await box(v, ".od-tg"))!.h).toBeGreaterThanOrEqual(32);
			else {
				expect((await box(v, ".od-sg[data-v=orig]"))!.h).toBeGreaterThanOrEqual(36);
				expect(await v.evaluate(`document.querySelector(".od-sg[data-v=draft]").getAttribute("aria-pressed")`)).toBe("true");
				expect((await box(v, ".od-tg")) === null || (await box(v, ".od-tg"))!.w === 0).toBe(true);
			}
			const card = (await box(v, ".fs-card"))!, draft = (await box(v, ".od-draftcol > .fs-body"))!;

			await showOrig(v);
			await waitFor(v, `document.querySelector(".od-pane .mb-txt")`);
			await settled(v);
			expect(hits[ref]).toBe(1);
			expect(await expanded(v)).toBe("true");
			expect(await text(v, ".od-tt")).toBe("원문 접기");
			const pane = await text(v, ".od-pane");
			for (const s of ["Kim Minsu <kim@example.com>", "me@example.net", "다음 주 일정 확인 부탁드립니다", "1번째 줄이에요", "일정표.pdf"]) expect(pane).toContain(s);
			expect(await text(v, ".od-ot")).toBe("원문");
			expect(await v.evaluate(`document.querySelectorAll(".od-orig .dc-act, .od-orig .dc-acts, .od-orig .fs-ft").length`)).toBe(0);
			expect(await v.evaluate(`(() => { const p = document.querySelector(".od-pane"); return p.scrollHeight > p.clientHeight && getComputedStyle(p).overflowY === "auto"; })()`)).toBe(true);
			const o = (await box(v, ".od-orig"))!, d = (await box(v, ".fs-card"))!, dBody = (await box(v, ".od-draftcol > .fs-body"))!;
			if (isWide) {
				expect(o.w).toBeGreaterThanOrEqual(300);
				expect(d.w).toBe(card.w);
				expect(dBody.w).toBe(draft.w);
				expect(d.l).toBeGreaterThan(card.l);
				expect(d.l - o.r).toBeGreaterThanOrEqual(12);
				expect(o.t).toBe(d.t);
				expect(o.h).toBe(d.h);
				expect(o.l).toBeGreaterThanOrEqual(0);
				expect(d.r).toBeLessThanOrEqual(w);
				expect(await v.evaluate(`!document.querySelector(".od-draftcol").contains(document.querySelector(".od-orig"))`)).toBe(true);
			} else {
				expect(o.l).toBeGreaterThanOrEqual(0);
				expect(o.r).toBeLessThanOrEqual(w);
				expect(o.w).toBeGreaterThan(w - 40);
				expect((await box(v, ".od-draftcol"))!.r).toBeLessThanOrEqual(0);
				expect(await v.evaluate(`document.querySelector(".od-sg[data-v=orig]").getAttribute("aria-pressed")`)).toBe("true");
			}

			await showDraft(v);
			await settled(v);
			expect(await expanded(v)).toBe("false");
			expect(await v.evaluate(`document.querySelector(".od-orig").hasAttribute("inert")`)).toBe(true);
			expect(await v.evaluate(`getComputedStyle(document.querySelector(".od-orig")).visibility`)).toBe("hidden");
			expect((await box(v, ".fs-card"))!.l).toBe(card.l);
			expect((await box(v, ".od-draftcol > .fs-body"))!.l).toBe(draft.l);
			await showOrig(v);
			await settled(v);
			expect(await expanded(v)).toBe("true");
			expect(hits[ref]).toBe(1);
			v.close();
		}
	});

	test("the slide runs ~250ms and halfway the panel is between hidden and shown; reduced motion jumps", async () => {
		const v = await open(1280, 800);
		await openSheet(v, drafts.plain!);
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane .mb-txt")`);
		await settled(v);
		await showDraft(v);
		await settled(v);
		await showOrig(v);
		const t = await v.evaluate(`document.getAnimations().map(a => a.effect.getComputedTiming().duration).filter(d => d > 0)`);
		expect(t.length).toBeGreaterThan(0);
		for (const d of t as number[]) expect(d).toBe(250);
		await v.evaluate(`document.getAnimations().forEach(a => { a.pause(); a.currentTime = 125; })`);
		const op = Number(await v.evaluate(`getComputedStyle(document.querySelector(".od-orig")).opacity`));
		expect(op).toBeGreaterThan(0.05);
		expect(op).toBeLessThan(0.95);
		v.close();
	});

	test("the sheet stays open on the original when it repaints (고치기 asks for the change)", async () => {
		const v = await open(1280, 800);
		await openSheet(v, drafts.html!);
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane .mb-frame")`);
		await settled(v);
		await click(v, ".fs-ft .dc-act:nth-child(2)");
		await waitFor(v, `document.querySelector(".fs-ft .dc-note")`);
		expect(await expanded(v)).toBe("true");
		expect((await box(v, ".od-orig"))!.w).toBeGreaterThan(300);
	});

	test("the draft's buttons are one compact row of the draft panel and still answer", async () => {
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			await theme(v, "light");
			await openSheet(v, drafts.plain!);
			const acts = await v.evaluate(`[...document.querySelectorAll(".dc-acts .dc-act")].map(b => b.textContent)`);
			expect(acts).toEqual(["보내기", "고치기", "보내지 않기"]);
			const row = (await box(v, ".dc-acts"))!, main = (await box(v, ".dc-act.main"))!, man = (await box(v, ".dc-manual"))!;
			expect(main.l).toBe(row.l);
			expect((await box(v, ".dc-acts .dc-act:nth-child(2)"))!.l).toBeGreaterThan(main.r);
			expect(row.h).toBeLessThanOrEqual(48);
			expect(main.h).toBeLessThanOrEqual(48);
			expect(main.t).toBe((await box(v, ".dc-acts .dc-act:nth-child(3)"))!.t);
			expect(man.t).toBeGreaterThanOrEqual(row.t);
			expect(man.b).toBeLessThanOrEqual(row.b);
			expect(man.l).toBeGreaterThan((await box(v, ".dc-acts .dc-act:nth-child(3)"))!.r);
			expect(row.r).toBeLessThanOrEqual(w);
			expect(await v.evaluate(`document.querySelectorAll(".dc-acts .dc-act").length + document.querySelectorAll(".dc-manual").length`)).toBe(4);
			await Bun.write(`${SNAP}/buttons-${w}-light.png`, await v.screenshot());
			await click(v, ".dc-manual");
			await waitFor(v, `document.querySelector(".fs-ft .dc-note")`);
			expect(await v.evaluate(`document.querySelector(".fs-ft .dc-note").value`)).toContain("말씀하신 일정 확인했습니다");
			v.close();
		}
	});

	test("보내지 않기 in the row posts the answer once", async () => {
		const v = await open(1280, 800);
		await openSheet(v, drafts.peer!);
		await v.evaluate(`(() => { window.__posts = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === "POST") window.__posts.push(String(u)); return f(u, o); }; })()`);
		await click(v, ".dc-acts .dc-act:nth-child(3)");
		await waitFor(v, `window.__posts.length > 0`);
		expect(await v.evaluate(`window.__posts.length`)).toBe(1);
		v.close();
	});

	test("a mail that is gone says 원문을 찾을 수 없어요 and the draft stays usable", async () => {
		const ref = drafts.gone!;
		gone.add(ref);
		const v = await open(390, 844);
		await openSheet(v, ref);
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane").textContent === "원문을 찾을 수 없어요"`);
		expect(await text(v, ".od-pane")).toBe("원문을 찾을 수 없어요");
		await showDraft(v);
		await settled(v);
		expect(await v.evaluate(`!document.querySelector(".fs-ft .dc-act").disabled`)).toBe(true);
		expect((await box(v, ".od-draftcol > .fs-body"))!.w).toBeGreaterThan(120);
	});

	test("a peer's draft is read through /api/peer/proxy, not from this computer", async () => {
		const ref = drafts.peer!;
		const v = await open(1280, 800);
		const t = find(ref).decision!.to;
		await openSheet(v, ref, `PQ.of.set(${JSON.stringify(t)}, { pc: { name: "mini", url: "http://mini.test:7777" }, key: ${JSON.stringify(t)} })`);
		delete hits[ref];
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane .mb-txt")`);
		expect(proxied.filter(u => u.endsWith("/original"))).toEqual([`http://mini.test:7777/api/drafts/${ref}/original`]);
		expect(hits[ref] ?? 0).toBe(0);
		expect(await text(v, ".od-pane")).toContain("Kim Minsu <kim@example.com>");
	});
});

describe("GET /api/drafts/<code>/original for a comment reply draft", () => {
	const get = async (c: string) => draftAttachRoute(new Request("http://x/"), new URL("http://x/"), c, "original");
	test("the comment, the post it is under and no parent for a top-level comment; the peer read list allows it", async () => {
		const res = await get(code.top!);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ kind: "comment", key: commentId("youtube", "top"), author: "김팬", date: new Date(CT0).toISOString(), text: CTEXT, post: { title: "행방불명 OST 피아노 연주", link: "https://www.youtube.com/watch?v=v1", thumb: THUMB, kind: "youtube" } });
		expect(PEER_GET.some(r => r.test(`/api/drafts/${code.peer}/original`))).toBe(true);
	});

	test("a reply in a thread carries the comment above it", async () => {
		const o = (await (await get(code.reply!)).json()) as { author: string; parent: { author: string; text: string; date: string } };
		expect(o.author).toBe("박답글");
		expect(o.parent).toEqual({ author: "이독자", text: "저도 악보가 궁금해요", date: new Date(CT0 - 60_000).toISOString() });
	});

	test("a draft whose comment is gone has no original: 404 with the owner's wording", async () => {
		const res = await get(code.gone!);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "원문을 찾을 수 없어요" });
	});
});

describe("원문 보기 for a comment reply draft", () => {
	test("sheet of an [ask]: closed and nothing fetched; opening shows author, time, text, post title with thumbnail and the link", async () => {
		const ref = code.top!;
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			delete hits[ref];
			await openSheet(v, ref);
			expect(await expanded(v)).toBe("false");
			expect(await text(v, ".od-tt")).toBe("원문 보기");
			expect(hits[ref] ?? 0).toBe(0);
			await showOrig(v);
			await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
			await settled(v);
			expect(hits[ref]).toBe(1);
			const pane = await text(v, ".od-pane");
			for (const t of ["김팬", CTEXT, "행방불명 OST 피아노 연주", "영상", "원본 열기"]) expect(pane).toContain(t);
			expect(await v.evaluate(`document.querySelector(".od-pane .od-open").href`)).toBe("https://www.youtube.com/watch?v=v1");
			expect(await v.evaluate(`!!document.querySelector(".od-pane img.kk-thumb")`)).toBe(true);
			expect(await v.evaluate(`!document.querySelector(".od-parent")`)).toBe(true);
			const o = (await box(v, ".od-orig"))!, d = (await box(v, ".od-draftcol > .fs-body"))!;
			if (w >= 900) {
				expect(o.w).toBeGreaterThanOrEqual(300);
				expect(o.r).toBeLessThanOrEqual(d.l);
			} else expect(o.w).toBeGreaterThan(w - 40);
			expect(await text(v, ".od-draftcol > .fs-body")).toContain("봐 주셔서 감사합니다");
			await showDraft(v);
			await settled(v);
			expect(await expanded(v)).toBe("false");
			v.close();
		}
	});

	test("a reply in a thread shows its parent comment", async () => {
		const v = await open(390, 844);
		await openSheet(v, code.reply!);
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane .od-parent")`);
		expect(await text(v, ".od-parent")).toContain("이독자");
		expect(await text(v, ".od-parent")).toContain("저도 악보가 궁금해요");
		expect(await text(v, ".od-ct")).toBe("링크 부탁드려요!");
	});

	test("a combined reply + mail card keeps working: its original is the comment", async () => {
		const v = await open(1280, 800);
		await openSheet(v, code.combo!);
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
		expect(await text(v, ".od-ct")).toBe(CTEXT);
		const body = await text(v, ".od-draftcol > .fs-body");
		expect(body).toContain("함께 보낼 메일");
		expect(body).toContain("악보 보내드립니다");
	});

	test("a comment that is gone says 원문을 찾을 수 없어요 and the draft stays usable", async () => {
		const v = await open(390, 844);
		await openSheet(v, code.gone!);
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane").textContent === "원문을 찾을 수 없어요"`);
		expect(await v.evaluate(`!document.querySelector(".fs-ft .dc-act").disabled`)).toBe(true);
	});

	test("a peer's comment draft is read through /api/peer/proxy", async () => {
		const ref = code.peer!;
		const v = await open(1280, 800);
		const t = find(ref).decision!.to;
		await openSheet(v, ref, `PQ.of.set(${JSON.stringify(t)}, { pc: { name: "mini", url: "http://mini.test:7777" }, key: ${JSON.stringify(t)} })`);
		delete hits[ref];
		await showOrig(v);
		await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
		expect(proxied.filter(u => u.endsWith(`/${ref}/original`))).toEqual([`http://mini.test:7777/api/drafts/${ref}/original`]);
		expect(hits[ref] ?? 0).toBe(0);
		expect(await text(v, ".od-ct")).toBe(CTEXT);
	});

	test("the comment view's own draft card has the same panel and toggle, and keeps its three buttons", async () => {
		const ref = code.card!;
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			await waitFor(v, `typeof cmDraftCard === "function"`);
			await theme(v, "light");
			await mountCard(v, ref);
			delete hits[ref];
			expect(hits[ref] ?? 0).toBe(0);
			expect(await v.evaluate(`document.querySelectorAll("#t-box .kk-draft .rq-acts .btn").length`)).toBe(3);
			await Bun.write(`${SNAP}/comment-card-closed-${w}-light.png`, await v.screenshot());
			await showOrig(v, "#t-box");
			await waitFor(v, `document.querySelector("#t-box .od-pane .od-ct")`);
			await settled(v);
			expect(hits[ref]).toBe(1);
			expect(await text(v, "#t-box .od-ct")).toBe(CTEXT);
			const o = (await box(v, "#t-box .od-orig"))!, d = (await box(v, "#t-box .kk-draft"))!;
			if (w >= 900) {
				expect(o.w).toBeGreaterThan(200);
				expect(d.w).toBeGreaterThan(300);
				expect(o.r).toBeLessThanOrEqual(d.l);
			} else {
				expect(o.l).toBeGreaterThanOrEqual(0);
				expect(o.r).toBeLessThanOrEqual(w);
				expect(d.r).toBeLessThanOrEqual((await box(v, "#t-box"))!.l);
			}
			expect(await text(v, "#t-box .kk-draft")).toContain("봐 주셔서 감사합니다");
			expect(await v.evaluate(`document.querySelectorAll("#t-box .od-orig .btn.main, #t-box .od-orig [data-k=send]").length`)).toBe(0);
			await Bun.write(`${SNAP}/comment-card-open-${w}-light.png`, await v.screenshot());
			await showDraft(v, "#t-box");
			await settled(v);
			expect(await v.evaluate(`document.querySelector("#t-box .od-tg").getAttribute("aria-expanded")`)).toBe("false");
			v.close();
		}
	});
});

describe("screenshots", () => {
	test("a mail draft: closed and open at 390 (both toggle states) and 1280, light", async () => {
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			await theme(v, "light");
			await openSheet(v, drafts.html!);
			await Bun.write(`${SNAP}/mail-closed-${w}-light.png`, await v.screenshot());
			await showOrig(v);
			await waitFor(v, `document.querySelector(".od-pane .mb-frame")`);
			await settled(v);
			await Bun.write(`${SNAP}/mail-open-${w}-light.png`, await v.screenshot());
			if (w < 900) {
				await showDraft(v);
				await settled(v);
				await Bun.write(`${SNAP}/mail-open-${w}-draft-light.png`, await v.screenshot());
			}
			v.close();
		}
	});

	test("a comment draft with a mail: closed and open at 390 and 1280, light", async () => {
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			await theme(v, "light");
			await openSheet(v, code.reply!);
			await Bun.write(`${SNAP}/comment-closed-${w}-light.png`, await v.screenshot());
			await showOrig(v);
			await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
			await settled(v);
			await Bun.write(`${SNAP}/comment-open-${w}-light.png`, await v.screenshot());
			if (w < 900) {
				await showDraft(v);
				await settled(v);
				await Bun.write(`${SNAP}/comment-open-${w}-draft-light.png`, await v.screenshot());
			}
			v.close();
		}
	});
});
