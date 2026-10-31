import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 답장 확인 (web/js/30-replies.js): one queue of every reply draft that waits for 보내기, of every app and every computer, newest first, each drawn as
// the one reply card (web/js/10-reply-card.js) with its app, account, computer and model, where it goes, the original and an always-shown 첨부 줄.
// Reached from 홈 답장 대기 and an app row's 답장 확인; a peer's draft is acted on its own computer once, and this one reads the queue again.
const SHOTS = process.env.REPLIES_SHOTS ?? join(tmpdir(), "replies-shots");
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const iso = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const Q = "이 답장 보낼까요?";
const OPTS = [{ n: 1, label: "보내기", desc: "", rec: true }, { n: 2, label: "고치기", desc: "", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "", rec: false }];
// A mail send approval quoting its draft, with the files that go (draft-approval.ts "> 첨부: name (size)" lines read back into d.attachments).
const mailDraft = (id: string, t: string, at: string, attachments?: { name: string; size: string }[]) => ({
	id, ts: at, updated: at, kind: "decision", tone: "ask", title: `${Q} (RSE1)`, text: `[ask] 답장 초안을 만들었어요.\n\n> 받는이: Kim <kim@example.com>\n\n${Q}`, open: t, src: t, at, read: false,
	decision: { options: OPTS, to: t, reply_to: at, group: 1, state: "open", draft: { toLabel: "받는이", to: "Kim <kim@example.com>", subject: "Re: 견적 요청", body: "안녕하세요.\n\n견적서를 보내 드려요.", ...(attachments ? { attachments } : {}) } },
});
const LONG = ["안녕하세요!", "오늘 시간 괜찮으세요?", "저는 오후에는 괜찮아요.", "세 시쯤 어떨까요?", "장소는 늘 가던 곳으로 해요.", "제가 조금 일찍 가 있을게요.", "혹시 늦으시면 알려 주세요.", "그럼 이따 봬요."].join("\n");
const kakaoDraft = (code: string, at: string, extra: object = {}) => ({
	kind: "kakao", app: "kakao", code, chatId: "100", room: "가나다 모임", text: LONG, parts: ["안녕하세요!", "오늘 시간 괜찮으세요?"], created: at, at: Date.parse(at), attachmentsNone: true, cannotAttach: [],
	original: { who: "가나", text: "내일 점심 어때요?", at: Date.parse(at) }, model: "Sonnet 5.5 · 보통", ...extra,
});
const commentDraft = (at: string) => ({
	kind: "comment", app: "youtube", via: "youtube", code: "C1", thread: "p1", to: "가나", title: "첫 번째 영상", source: "youtube", sourceLabel: "유튜브 댓글",
	text: LONG, created: at, at: Date.parse(at), attachmentsNone: true, cannotAttach: ["견적서.pdf"], original: { who: "가나", text: "자막 언제 나와요?", at: Date.parse(at) },
});
const app = (key: string, label: string, icon: string, notices: string[], needs: object) => ({ key, app: key, label, icon, kind: "app", unread: 0, notices, needs });
const LOCAL_MAIL = { ...app("mail", "회사 메일", "mail", ["dl"], { drafts: 1, unread: 0, sentToday: 0 }), conv: ["mail:"] };
const LOCAL_KAKAO = app("kakao", "카카오톡", "chat", [], { drafts: 1, unread: 0, sentToday: 0 });
const LOCAL_YOUTUBE = app("youtube", "유튜브", "chat", [], { drafts: 1, unread: 0, sentToday: 0 });
const PEER_MAIL = { ...app("mail", "회사 메일", "mail", ["dp"], { drafts: 1, unread: 0, sentToday: 0 }), conv: ["mail:"] };
const PEER_KAKAO = app("kakao", "카카오톡", "chat", [], { drafts: 1, unread: 0, sentToday: 0 });

const T = { peerMail: iso(0), peerKakao: iso(1), localKakao: iso(2), localMail: iso(3), localComment: iso(5) };
let localReplies = [kakaoDraft("K1", T.localKakao), commentDraft(T.localComment)];
let peerReplies = [kakaoDraft("PK1", T.peerKakao, { room: "공부 모임" })];
let peerNote = mailDraft("dp", "mail:kdb-peer", T.peerMail);
const localNote = mailDraft("dl", "mail:kdb-local", T.localMail, [{ name: "견적서.pdf", size: "2.1MB" }]);
const conv = (t: string) => ({ target: t, mail: { key: t.slice(5), subject: "견적 요청", from: "Kim <kim@example.com>", source: "kdb", at: T.localMail, summary: "다음 주까지 견적을 받고 싶어요.", reply: "draft", unreplied: true }, last: { ts: T.localMail, text: "견적 요청 메일", via: "kdb" }, unread: 0 });
const snapshot = () => ({ name: "맥미니", rev: `r${peerReplies.length}${peerNote.decision.state}`, monitors: [], notices: [peerNote], integrations: [PEER_MAIL, PEER_KAKAO], available: [], conversations: [conv("mail:kdb-peer")], replies: peerReplies });

const acts: { action: string; args: Record<string, unknown> }[] = [];
const localPosts: { path: string; body: unknown }[] = [];
let peerReads = 0, repliesReads = 0;
const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 1 });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, { name: "맥미니", url: MINI, self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 1, items: [localNote] });
		if (p === "/api/integrations") return json({ items: [LOCAL_MAIL, LOCAL_KAKAO, LOCAL_YOUTUBE], available: [] });
		if (p === "/api/conversations") return json({ items: [conv("mail:kdb-local")] });
		if (p === "/api/replies") { repliesReads++; return json({ items: localReplies }); }
		if (p === "/api/monitoring/peers") { peerReads++; return json([{ name: "맥미니", url: MINI, online: true, stale: false, items: snapshot() }]); }
		if (p === "/api/peer/proxy") {
			const pp = url.searchParams.get("p") ?? "";
			if (req.method === "POST") {
				const a = (await req.json()) as (typeof acts)[number];
				acts.push(a);
				if (a.action === "kakao" && (a.args.op === "draft-send" || a.args.op === "draft-drop")) peerReplies = peerReplies.filter(d => d.code !== a.args.code);
				return json({ ok: true });
			}
			if (pp === "/api/replies") return json({ items: peerReplies });
			return json({});
		}
		if (req.method === "POST") {
			const b = await req.json().catch(() => null);
			localPosts.push({ path: p, body: b });
			if (p.endsWith("/drop")) localReplies = localReplies.filter(d => !p.includes(d.code));
			return json({ ok: true });
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <R = unknown>(v: View, code: string): Promise<R> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as R;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const boot = async (width: number, height: number) => {
	localReplies = [kakaoDraft("K1", T.localKakao), commentDraft(T.localComment)];
	peerReplies = [kakaoDraft("PK1", T.peerKakao, { room: "공부 모임" })];
	peerNote = mailDraft("dp", "mail:kdb-peer", T.peerMail);
	acts.length = 0; localPosts.length = 0;
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh && PQ.loaded && typeof rqAll === "function"`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	return v;
};
const openQueue = async (v: View) => {
	await run(v, `go("monitoring")`);
	await waitFor(v, `monItems().some(i => i.key === "replies") && RQ.loaded`);
	await run(v, `go("monitoring", "replies")`);
	await waitFor(v, `document.querySelectorAll("#mon-tl .rq-q > .rq").length`);
};

describe.each([[390, 844], [1280, 900]])("답장 확인 at %ipx", (width, height) => {
	test("one queue of every app and computer's draft, newest first, each with its app, account, computer, model, where it goes and the original", async () => {
		const v = await boot(width, height);
		await openQueue(v);
		const got = await q<{ kinds: string[]; meta: string[]; to: string[]; orig: string[]; attach: string[]; acts: string[][]; long: number; over: boolean }>(v, `
			const cards = [...document.querySelectorAll("#mon-tl .rq-q > .rq")];
			const txt = e => e ? e.textContent.trim() : "";
			return { kinds: cards.map(c => c.dataset.kind), meta: cards.map(c => txt(c.querySelector(".rq-meta"))), to: cards.map(c => txt(c.querySelector(".dr-chip"))),
				orig: cards.map(c => txt(c.querySelector(".rq-orig .rq-ot"))), attach: cards.map(c => txt(c.querySelector(".rq-att") || c.querySelector(".dr-files"))),
				acts: cards.map(c => [...c.querySelectorAll(".rq-acts button")].map(txt)), long: cards.filter(c => c.querySelector(".rq-more")).length,
				over: document.documentElement.scrollWidth > innerWidth };`);
		// newest first: the Mac mini's mail draft, its KakaoTalk draft, this computer's KakaoTalk draft, its mail draft, its comment draft
		expect(got.kinds).toEqual(["notice", "kakao", "kakao", "notice", "comment"]);
		expect(got.meta).toEqual(["메일 · 회사 메일 · 맥미니", "카카오톡 · Sonnet 5.5 · 보통 · 맥미니", "카카오톡 · Sonnet 5.5 · 보통 · 맥북", "메일 · 회사 메일 · 맥북", "유튜브 · 맥북"]);
		expect(got.to).toEqual(["Kim <kim@example.com>", "공부 모임", "가나다 모임", "Kim <kim@example.com>", "가나"]);
		expect(got.orig).toEqual(["견적 요청", "내일 점심 어때요?", "내일 점심 어때요?", "견적 요청", "자막 언제 나와요?"]);
		// the attachment line always shows what goes: the mail's files with name and size, 첨부: 없음 for a text-only app, and the files that stay behind
		expect(got.attach[0]).toBe("첨부: 없음");
		expect(got.attach[1]).toBe("첨부: 없음 · 파일을 붙일 수 없는 곳이에요");
		expect(got.attach[3]).toBe("첨부 1개견적서.pdfPDF · 2.1MB");
		expect(got.attach[4]).toBe("첨부: 없음 · 파일을 붙일 수 없는 곳이에요남는 파일: 견적서.pdf");
		for (const a of got.acts) expect(a).toEqual(["보내기", "고치기", "보내지 않기"]);
		// a body over about six lines is clamped with 펼치기 (the KakaoTalk drafts are two short parts, so they are not)
		expect(got.long).toBe(1);
		expect(got.over).toBe(false);
		const more = await q<{ open: string; label: string; clamped: boolean }>(v, `const c = document.querySelector('.rq[data-kind="comment"]'), m = c.querySelector(".rq-more");
			return { open: m.getAttribute("aria-expanded"), label: m.textContent, clamped: c.querySelector(".rq-body").classList.contains("clamp") };`);
		expect(more).toEqual({ open: "false", label: "펼치기", clamped: true });
		await run(v, `document.querySelector('.rq[data-kind="comment"] .rq-more').click()`);
		expect(await q<string>(v, `return document.querySelector('.rq[data-kind="comment"] .rq-more').textContent + "|" + document.querySelector('.rq[data-kind="comment"] .rq-body').classList.contains("clamp")`)).toBe("접기|false");
		await Bun.write(join(SHOTS, `replies-${width}.png`), await v.screenshot());
	});

	test("the home 답장 대기 row and an app row's 답장 확인 open the queue, the app's own drafts only", async () => {
		const v = await boot(width, height);
		await run(v, `go("home")`);
		await waitFor(v, `document.querySelector('#home-now .hr[data-k="replies"]')`);
		const home = await q<string>(v, `return document.querySelector('#home-now .hr[data-k="replies"]').textContent`);
		expect(home).toContain("답장 확인");
		expect(home).toContain("5건");
		await run(v, `document.querySelector('#home-now .hr[data-k="replies"]').click()`);
		await waitFor(v, `current === "monitoring" && MON.sel === "replies" && document.querySelectorAll("#mon-tl .rq-q > .rq").length === 5`);
		// an app's row opens the queue on that app's drafts of that computer
		await run(v, `go("monitoring", "i:kakao")`);
		await waitFor(v, `document.querySelector('#mon-head .rq-go')`);
		const label = await q<string>(v, `return document.querySelector('#mon-head .rq-go').textContent`);
		expect(label).toBe("답장 확인 1");
		await run(v, `document.querySelector('#mon-head .rq-go').click()`);
		await waitFor(v, `MON.sel === "replies" && document.querySelectorAll("#mon-tl .rq-q > .rq").length === 1`);
		expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .rq-q > .rq")].map(c => c.querySelector(".dr-chip").textContent)`)).toEqual(["가나다 모임"]);
	});

	test("a peer's draft is sent on its computer once, and the queue reads both computers again", async () => {
		const v = await boot(width, height);
		await openQueue(v);
		const reads = peerReads;
		// two taps: the card is busy after the first, so exactly one act leaves this computer
		await run(v, `const b = document.querySelector('.rq[data-kind="kakao"][data-rq^="kakao:http://mini.test|PK1"] .dr-send'); b.click(); b.click()`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-q > .rq").length === 4`);
		expect(acts).toEqual([{ action: "kakao", args: { op: "draft-send", code: "PK1" } }]);
		expect(localPosts).toEqual([]);
		await waitFor(v, `true`, 200).catch(() => {});
		await waitFor(v, `${peerReads} > ${reads}`).catch(() => {});
		expect(peerReads).toBeGreaterThan(reads);   // the queue reads the Mac mini again (its own queue does the same from its own store)
	});

	test("보내지 않기 of a local draft offers 되돌리기, and the undo brings it back once", async () => {
		const v = await boot(width, height);
		await openQueue(v);
		await run(v, `document.querySelector('.rq[data-kind="comment"] [data-k="drop"]').click()`);
		await waitFor(v, `document.querySelector(".snack.act .sa") && !document.querySelector('.rq[data-kind="comment"]')`);
		const snack = await q<string>(v, `return document.querySelector(".snack").textContent`);
		expect(snack).toContain("보내지 않았어요");
		expect(snack).toContain("되돌리기");
		expect(localPosts.map(x => x.path)).toEqual(["/api/comments/drafts/C1/drop"]);
		// the undo is one request and the card waits again
		localReplies = [kakaoDraft("K1", T.localKakao), commentDraft(T.localComment)];
		await run(v, `document.querySelector(".snack.act .sa").click(); document.querySelectorAll(".snack.act .sa").forEach(b => b.remove())`);
		await waitFor(v, `document.querySelectorAll("#mon-tl .rq-q > .rq").length === 5`);
		expect(localPosts.map(x => x.path)).toEqual(["/api/comments/drafts/C1/drop", "/api/comments/drafts/C1/restore"]);
	});
});
