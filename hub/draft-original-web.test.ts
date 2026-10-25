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

// 원문 보기 in the send sheet (web/js/10-draft-original.js, GET /api/drafts/<ref>/original): collapsed by default, the first open fetches the mail once and
// keeps it, the sheet splits into original | draft and back, a vanished mail says so, and a peer's draft is read through /api/peer/proxy.
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
	for (const p of [paths.config(), paths.drafts(), join(paths.config(), "..", "..", "..", "draft-files"), ...["org-plain", "org-html", "org-gone", "org-peer"].map(k => join(MAIL_FILES, k))]) rmSync(p, { force: true, recursive: true });
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

describe("원문 보기 in the send sheet", () => {
	test("collapsed by default: one line with sender and subject, nothing fetched; opening splits the sheet, closing joins it, the second open reads the cache", async () => {
		const ref = drafts.plain!;
		for (const [w, h, min] of [[390, 844, 150], [1280, 800, 300]] as const) {
			const v = await open(w, h);
			delete hits[ref];
			await openSheet(v, ref);
			expect(await expanded(v)).toBe("false");
			expect(await text(v, ".od-tt")).toBe("원문 보기");
			expect(await text(v, ".od-sum")).toContain("kim@example.com");
			expect(await text(v, ".od-sum")).toContain("다음 주 일정 확인 부탁드립니다");
			expect(await v.evaluate(`document.querySelector(".od-orig").hasAttribute("inert")`)).toBe(true);
			expect((await box(v, ".od-tg"))!.h).toBeGreaterThanOrEqual(44);
			expect(hits[ref] ?? 0).toBe(0);
			const narrow = (await box(v, ".fs-card"))!;

			await click(v, ".od-tg");
			await waitFor(v, `document.querySelector(".od-pane .mb-txt")`);
			await settled(v);
			expect(hits[ref]).toBe(1);
			expect(await expanded(v)).toBe("true");
			expect(await text(v, ".od-tt")).toBe("원문 접기");
			const pane = (await text(v, ".od-pane")) ;
			for (const s of ["Kim Minsu <kim@example.com>", "me@example.net", "다음 주 일정 확인 부탁드립니다", "1번째 줄이에요", "일정표.pdf"]) expect(pane).toContain(s);
			const o = (await box(v, ".od-pane"))!, d = (await box(v, ".od-split > .fs-body"))!, card = (await box(v, ".fs-card"))!;
			expect(o.w).toBeGreaterThanOrEqual(min);
			expect(d.w).toBeGreaterThanOrEqual(min);
			expect(o.r).toBeLessThanOrEqual(d.l);
			expect(o.l).toBeGreaterThanOrEqual(card.l);
			expect(d.r).toBeLessThanOrEqual(card.r);
			if (w >= 1000) expect(card.w).toBeGreaterThan(narrow.w);
			expect(await v.evaluate(`(() => { const p = document.querySelector(".od-pane"), b = document.querySelector(".od-split > .fs-body"); return p.scrollHeight > p.clientHeight && getComputedStyle(p).overflowY === "auto" && getComputedStyle(b).overflowY === "auto"; })()`)).toBe(true);

			await click(v, ".od-tg");
			await settled(v);
			expect(await expanded(v)).toBe("false");
			expect((await box(v, ".od-orig"))!.w).toBe(0);
			expect((await box(v, ".fs-card"))!.w).toBe(narrow.w);
			await click(v, ".od-tg");
			await settled(v);
			expect(await expanded(v)).toBe("true");
			expect(hits[ref]).toBe(1);
			v.close();
		}
	});

	test("the sheet stays split when it repaints (고치기 asks for the change)", async () => {
		const v = await open(1280, 800);
		await openSheet(v, drafts.html!);
		await click(v, ".od-tg");
		await waitFor(v, `document.querySelector(".od-pane .mb-frame")`);
		await settled(v);
		await click(v, ".fs-ft .dc-act:nth-child(2)");
		await waitFor(v, `document.querySelector(".fs-ft .dc-note")`);
		expect(await expanded(v)).toBe("true");
		expect((await box(v, ".od-pane"))!.w).toBeGreaterThan(300);
	});

	test("a mail that is gone says 원문을 찾을 수 없어요 and the draft stays usable", async () => {
		const ref = drafts.gone!;
		gone.add(ref);
		const v = await open(390, 844);
		await openSheet(v, ref);
		await click(v, ".od-tg");
		await waitFor(v, `document.querySelector(".od-pane").textContent === "원문을 찾을 수 없어요"`);
		expect(await text(v, ".od-pane")).toBe("원문을 찾을 수 없어요");
		expect(await v.evaluate(`!document.querySelector(".fs-ft .dc-act").disabled`)).toBe(true);
		expect((await box(v, ".od-split > .fs-body"))!.w).toBeGreaterThan(120);
	});

	test("a peer's draft is read through /api/peer/proxy, not from this computer", async () => {
		const ref = drafts.peer!;
		const v = await open(1280, 800);
		const t = find(ref).decision!.to;
		await openSheet(v, ref, `PQ.of.set(${JSON.stringify(t)}, { pc: { name: "mini", url: "http://mini.test:7777" }, key: ${JSON.stringify(t)} })`);
		delete hits[ref];
		await click(v, ".od-tg");
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
	test("sheet of an [ask]: collapsed one line with the commenter, nothing fetched; opening shows author, time, text, post title with thumbnail and the link", async () => {
		const ref = code.top!;
		for (const [w, h, min] of [[390, 844, 150], [1280, 800, 300]] as const) {
			const v = await open(w, h);
			delete hits[ref];
			await openSheet(v, ref);
			expect(await expanded(v)).toBe("false");
			expect(await text(v, ".od-tt")).toBe("원문 보기");
			expect(await text(v, ".od-sum")).toContain("김팬 댓글");
			expect(hits[ref] ?? 0).toBe(0);
			await click(v, ".od-tg");
			await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
			await settled(v);
			expect(hits[ref]).toBe(1);
			const pane = await text(v, ".od-pane");
			for (const t of ["김팬", CTEXT, "행방불명 OST 피아노 연주", "영상", "원본 열기"]) expect(pane).toContain(t);
			expect(await v.evaluate(`document.querySelector(".od-pane .od-open").href`)).toBe("https://www.youtube.com/watch?v=v1");
			expect(await v.evaluate(`!!document.querySelector(".od-pane img.kk-thumb")`)).toBe(true);
			expect(await v.evaluate(`!document.querySelector(".od-parent")`)).toBe(true);
			const o = (await box(v, ".od-pane"))!, d = (await box(v, ".od-split > .fs-body"))!;
			expect(o.w).toBeGreaterThanOrEqual(min);
			expect(d.w).toBeGreaterThanOrEqual(min);
			expect(o.r).toBeLessThanOrEqual(d.l);
			expect(await text(v, ".od-split > .fs-body")).toContain("봐 주셔서 감사합니다");
			await click(v, ".od-tg");
			await settled(v);
			expect((await box(v, ".od-orig"))!.w).toBe(0);
			v.close();
		}
	});

	test("a reply in a thread shows its parent comment", async () => {
		const v = await open(390, 844);
		await openSheet(v, code.reply!);
		await click(v, ".od-tg");
		await waitFor(v, `document.querySelector(".od-pane .od-parent")`);
		expect(await text(v, ".od-parent")).toContain("이독자");
		expect(await text(v, ".od-parent")).toContain("저도 악보가 궁금해요");
		expect(await text(v, ".od-ct")).toBe("링크 부탁드려요!");
	});

	test("a combined reply + mail card keeps working: its original is the comment", async () => {
		const v = await open(1280, 800);
		await openSheet(v, code.combo!);
		expect(await text(v, ".od-sum")).toContain("김팬 댓글");
		await click(v, ".od-tg");
		await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
		expect(await text(v, ".od-ct")).toBe(CTEXT);
		const body = await text(v, ".od-split > .fs-body");
		expect(body).toContain("함께 보낼 메일");
		expect(body).toContain("악보 보내드립니다");
	});

	test("a comment that is gone says 원문을 찾을 수 없어요 and the draft stays usable", async () => {
		const v = await open(390, 844);
		await openSheet(v, code.gone!);
		await click(v, ".od-tg");
		await waitFor(v, `document.querySelector(".od-pane").textContent === "원문을 찾을 수 없어요"`);
		expect(await v.evaluate(`!document.querySelector(".fs-ft .dc-act").disabled`)).toBe(true);
	});

	test("a peer's comment draft is read through /api/peer/proxy", async () => {
		const ref = code.peer!;
		const v = await open(1280, 800);
		const t = find(ref).decision!.to;
		await openSheet(v, ref, `PQ.of.set(${JSON.stringify(t)}, { pc: { name: "mini", url: "http://mini.test:7777" }, key: ${JSON.stringify(t)} })`);
		delete hits[ref];
		await click(v, ".od-tg");
		await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
		expect(proxied.filter(u => u.endsWith(`/${ref}/original`))).toEqual([`http://mini.test:7777/api/drafts/${ref}/original`]);
		expect(hits[ref] ?? 0).toBe(0);
		expect(await text(v, ".od-ct")).toBe(CTEXT);
	});

	test("the comment view's own draft card has the same bar and split", async () => {
		const ref = code.card!;
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			await waitFor(v, `typeof cmDraftCard === "function"`);
			await v.evaluate(`(() => { CM.view = { comments: [{ id: ${JSON.stringify(commentId("youtube", "top"))}, author: "김팬" }], sends: [], drafts: [] };
				const box = el("div", { class: "kk-drafts", id: "t-box", style: "position:fixed;left:8px;top:8px;width:" + (innerWidth - 16) + "px;z-index:9999;background:var(--bg)" });
				document.body.append(box);
				box.append(cmDraftCard({ code: ${JSON.stringify(ref)}, commentId: ${JSON.stringify(commentId("youtube", "top"))}, text: "봐 주셔서 감사합니다. 악보는 설명란 링크에서 받으실 수 있어요.", notes: [] })); })()`);
			delete hits[ref];
			expect(await text(v, "#t-box .od-sum")).toContain("김팬 댓글");
			expect(hits[ref] ?? 0).toBe(0);
			await click(v, "#t-box .od-tg");
			await waitFor(v, `document.querySelector("#t-box .od-pane .od-ct")`);
			await settled(v);
			expect(await text(v, "#t-box .od-ct")).toBe(CTEXT);
			const o = (await box(v, "#t-box .od-pane"))!, d = (await box(v, "#t-box .od-main"))!;
			expect(o.w).toBeGreaterThan(120);
			expect(d.w).toBeGreaterThan(120);
			expect(o.r).toBeLessThanOrEqual(d.l);
			expect(await text(v, "#t-box .od-main")).toContain("봐 주셔서 감사합니다");
			expect(await v.evaluate(`document.querySelectorAll("#t-box .btns .btn").length`)).toBe(3);
			await Bun.write(`${SNAP}/comment-card-expanded-${w}.png`, await v.screenshot());
			v.close();
		}
	});
});

describe("screenshots", () => {
	test("a comment draft: collapsed and expanded at 390 and 1280, light", async () => {
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			await theme(v, "light");
			await openSheet(v, code.reply!);
			await Bun.write(`${SNAP}/comment-collapsed-${w}-light.png`, await v.screenshot());
			await click(v, ".od-tg");
			await waitFor(v, `document.querySelector(".od-pane .od-ct")`);
			await settled(v);
			await Bun.write(`${SNAP}/comment-expanded-${w}-light.png`, await v.screenshot());
			v.close();
		}
	});

	test("collapsed, mid-animation and expanded at 390 and 1280, light and dark", async () => {
		const ref = drafts.plain!;
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			for (const t of ["light", "dark"] as const) {
				const v = await open(w, h);
				await theme(v, t);
				await openSheet(v, ref);
				await Bun.write(`${SNAP}/collapsed-${w}-${t}.png`, await v.screenshot());
				await click(v, ".od-tg");
				await waitFor(v, `document.querySelector(".od-pane .mb-txt")`);
				await settled(v);
				await click(v, ".od-tg");
				await settled(v);
				await click(v, ".od-tg");
				await v.evaluate(`document.getAnimations().forEach(a => { a.pause(); a.currentTime = 125; })`);
				const op = Number(await v.evaluate(`getComputedStyle(document.querySelector(".od-pane")).opacity`));
				expect(op).toBeGreaterThan(0.05);
				expect(op).toBeLessThan(0.95);
				await Bun.write(`${SNAP}/mid-${w}-${t}.png`, await v.screenshot());
				await v.evaluate(`document.getAnimations().forEach(a => a.finish())`);
				await settled(v);
				await Bun.write(`${SNAP}/expanded-${w}-${t}.png`, await v.screenshot());
				v.close();
			}
		}
	});
});
