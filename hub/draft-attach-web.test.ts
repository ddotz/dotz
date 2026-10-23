import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerMailDraft } from "../features/reply-drafts/lib/offer.ts";
import { paths } from "../features/reply-drafts/lib/settings.ts";
import { listDrafts } from "../features/reply-drafts/lib/store.ts";
import { draftAttachRoute } from "./draft-attach.ts";
import { draftFileRoute } from "./draft-files.ts";
import { emit, sseResponse } from "./events.ts";
import { listNotices, markNoticesRead, type Notice, resolveNotices, unreadCount } from "./notices.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The send sheet of a reply that promises a file (web/js/10-decision-card.js draftFilesNode): a matched file of the 첨부 파일 폴더 is a row with an x,
// a missing one is an amber warning above 보내기, 파일 추가 picks from the folder (or the device), x takes a file off, and a mail account that cannot
// send files says so and asks once more. Headless browser against the real draft store, notice store and draft-attach routes; nothing is sent.
const SNAP = "/tmp/dotz-draft-attach";
const lib = mkdtempSync(join(tmpdir(), "dotz-attach-lib-"));
for (const f of ["행방불명_공유용.pdf", "하울의 움직이는 성_공유용.pdf", "악보/기타/캐논.pdf"]) {
	mkdirSync(join(lib, f, ".."), { recursive: true });
	writeFileSync(join(lib, f), `%PDF-1.4 ${f}`);
}
const SUBJECT = "선생님 센과 치히로의 행방불명 ost 악보 부탁드립니다";
const BODY = "선생님 안녕하세요.\n\n요청주신 센과 치히로의 행방불명 OST 또다시 악보 보내드립니다. 공유용 악보는 1절까지 들어 있어요. 보내드린 악보는 개인 연습용으로만 써 주세요.";
const reply = (to: string, subject = `Re: ${SUBJECT}`) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks for a score", to, subject, body: BODY, questions: [] })}\n\`\`\``;

const json = (v: unknown, status = 200) => Response.json(v, { status });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		const file = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/files\/(\d+)$/.exec(url.pathname);
		if (file) return draftFileRoute(req, url, file[1]!, file[2]!);
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
		`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const done = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); done(); })`,
	);
const settled = (v: View) => v.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => 0))).then(() => true)`);
type Box = { l: number; t: number; r: number; b: number; w: number; h: number };
const box = async (v: View, sel: string): Promise<Box | null> =>
	JSON.parse(await v.evaluate(`JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })())`));
const texts = async (v: View, sel: string): Promise<string[]> => JSON.parse(await v.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim()))`));
const click = (v: View, sel: string) => v.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);

// Each offer goes out as the bell's [ask] message, the way the orchestrator posts it.
const drafts: Record<string, string> = {};
async function offer(name: string, mail: { key: string; source?: string; subject: string; body: string }) {
	await offerMailDraft(
		{ key: mail.key, target: "main", source: mail.source ?? "zele", id: `msg-${mail.key}`, subject: mail.subject, from: "Student <stu@example.com>", to: "me@example.net", body: mail.body },
		{ send: (_t, text) => void emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text }), call: async () => reply("stu@example.com", `Re: ${mail.subject}`) },
	);
	drafts[name] = listDrafts().find(d => d.ref === mail.key)!.id;
}
const stored = () => listNotices(300).items;
const find = (ref: string) => stored().find(n => n.kind === "decision" && n.decision?.state === "open" && n.decision.draft?.ref === ref)! as Notice;
const openSheet = async (v: View, ref: string) => {
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(find(ref).id))})`);
	await waitFor(v, `document.querySelector(".fs-bd .fs-card .dc-act")`);
	await settled(v);
};

beforeAll(async () => {
	Bun.spawnSync(["mkdir", "-p", SNAP]);
	resolveNotices({ ids: stored().filter(n => n.decision?.state === "open").map(n => n.id) });
	markNoticesRead({ all: true });
	mkdirSync(join(paths.config(), ".."), { recursive: true });
	writeFileSync(paths.config(), JSON.stringify({ enabled: true, attachFolders: { mail: lib } }));
	await offer("match", { key: "att-match", subject: SUBJECT, body: `${SUBJECT}.` });
	await offer("miss", { key: "att-miss", subject: "다른 곡 악보 부탁드립니다", body: "다른 곡 악보 부탁드립니다." });
	await offer("webmail", { key: "att-web", source: "webmail:corp", subject: SUBJECT, body: `${SUBJECT}.` });
});
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
	for (const p of [paths.config(), paths.drafts(), join(paths.config(), "..", "..", "..", "draft-files")]) rmSync(p, { force: true, recursive: true });
	rmSync(lib, { recursive: true, force: true });
});

describe("files in the send sheet at 390px", () => {
	test("a matched file of the folder is a row with an x and 파일 추가, and no warning; 보내기 asks nothing more", async () => {
		const ref = drafts.match!;
		expect(find(ref).decision!.draft!.attachments).toEqual([{ name: "행방불명_공유용.pdf", size: expect.stringMatching(/B$/) as unknown as string }]);
		const v = await open(390, 844);
		await openSheet(v, ref);
		await waitFor(v, `document.querySelector(".fs-body .dr-add")`);
		expect(await texts(v, ".fs-body .dr-fn")).toEqual(["행방불명_공유용.pdf"]);
		expect(await v.evaluate(`document.querySelectorAll(".fs-body .dr-x").length`)).toBe(1);
		expect(await texts(v, ".fs-body .dr-add")).toEqual(["파일 추가"]);
		expect(await v.evaluate(`document.querySelector(".fs-card").textContent.includes("null")`)).toBe(false);
		expect(await v.evaluate(`!!document.querySelector(".fs-ft .dr-warn, .fs-body .dr-warn")`)).toBe(false);
		const card = (await box(v, ".fs-card"))!;
		for (const sel of [".fs-body .dr-ar", ".fs-body .dr-x", ".fs-body .dr-add"]) {
			const b = (await box(v, sel))!;
			expect(b.h).toBeGreaterThanOrEqual(44);
			expect(b.l).toBeGreaterThanOrEqual(card.l);
			expect(b.r).toBeLessThanOrEqual(card.r);
		}
		await Bun.write(`${SNAP}/sheet-matched-390.png`, await v.screenshot());
	});

	test("no match: the amber warning sits above 보내기; 파일 추가 from the folder clears it, x brings it back", async () => {
		const ref = drafts.miss!;
		const d = find(ref).decision!.draft!;
		expect(d.warning).toBeTruthy();
		expect(d.note).toContain("첨부 파일 폴더에서 맞는 파일을 찾지 못했어요");
		const v = await open(390, 844);
		await openSheet(v, ref);
		await waitFor(v, `document.querySelector(".fs-ft .dr-warn")`);
		expect(await texts(v, ".fs-ft .dr-wn")).toEqual(["본문에는 보낸다고 썼어요 · 첨부 파일 폴더에서 맞는 파일을 찾지 못했어요"]);
		const warn = (await box(v, ".fs-ft .dr-warn"))!, send = (await box(v, ".fs-ft .dc-act.main"))!;
		expect(warn.b).toBeLessThanOrEqual(send.t);
		expect(await v.evaluate(`getComputedStyle(document.querySelector(".fs-ft .dr-warn")).backgroundColor !== getComputedStyle(document.querySelector(".fs-card")).backgroundColor`)).toBe(true);
		await Bun.write(`${SNAP}/sheet-warning-390.png`, await v.screenshot());

		await waitFor(v, `document.querySelector(".fs-body .dr-add")`);
		await click(v, ".fs-body .dr-add");
		await waitFor(v, `document.querySelectorAll(".fs-body .dr-menu .btn").length === 2`);
		expect(await texts(v, ".fs-body .dr-menu .btn")).toEqual(["이 기기에서 고르기", "첨부 파일 폴더에서 고르기"]);
		await click(v, ".fs-body .dr-menu .btn:nth-child(2)");
		await waitFor(v, `document.querySelectorAll(".fs-body .dr-li").length === 3`);
		await click(v, `.fs-body .dr-li[title="악보/기타/캐논.pdf"]`);
		await waitFor(v, `document.querySelectorAll(".fs-body .dr-ar").length === 1 && !document.querySelector(".fs-ft .dr-warn:not([hidden])")`);
		expect(await texts(v, ".fs-body .dr-fn")).toEqual(["캐논.pdf"]);
		expect(await v.evaluate(`document.querySelector(".fs-ft .dr-warnbox").hidden`)).toBe(true);
		expect(await v.evaluate(`fetch("/api/drafts/${ref}/files/0").then(r => r.text())`)).toContain("캐논.pdf");
		await click(v, ".fs-body .dr-x");
		await waitFor(v, `document.querySelectorAll(".fs-body .dr-ar").length === 0 && document.querySelector(".fs-ft .dr-warn")`);
		expect((await fetch(`${base}api/drafts/${ref}/files`).then(r => r.json())) as { files: unknown[] }).toMatchObject({ files: [] });
	});

	test("a mail account that cannot send files says so, offers no 파일 추가, and 보내기 asks once more", async () => {
		const ref = drafts.webmail!;
		const v = await open(390, 844);
		await openSheet(v, ref);
		await waitFor(v, `document.querySelector(".fs-ft .dr-none")`);
		expect(await texts(v, ".fs-ft .dr-none")).toEqual(["이 메일 계정은 첨부파일을 보낼 수 없어요 · 본문만 보내져요"]);
		expect(await v.evaluate(`!!document.querySelector(".fs-body .dr-add")`)).toBe(false);
		await click(v, ".fs-ft .dc-act.main");
		await waitFor(v, `document.querySelector("dialog.dlg")`);
		expect(await texts(v, "dialog.dlg .dtitle")).toEqual(["첨부파일 없이 보낼까요?"]);
		expect(await v.evaluate(`!!document.querySelector(".fs-ft .dc-st")`)).toBe(false);
		await Bun.write(`${SNAP}/sheet-cannot-send-390.png`, await v.screenshot());
	});
});
