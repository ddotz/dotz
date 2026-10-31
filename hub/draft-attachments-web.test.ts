import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftApprovalBlock, NO_ATTACHMENT_WARNING } from "./draft-approval.ts";
import { draftFileRoute, stageDraftFiles } from "./draft-files.ts";
import { emit } from "./events.ts";
import { listNotices, markNoticesRead, type Notice, resolveNotices, unreadCount } from "./notices.ts";
import { fakeHub, json, waitFor, type View } from "./test-web.ts";

// The send sheet and the mail draft card show which files go out (web/js/10-decision-card.js draftFilesNode): a row per attachment with a
// type icon, name and size that opens the staged file, `첨부 없음` when the original's files are not carried, and a warning when the text
// says it attaches something but no file is set. Headless browser against the real notice store; nothing is sent.
const root = mkdtempSync(join(tmpdir(), "dotz-draft-atts-"));
const src = mkdtempSync(join(tmpdir(), "dotz-draft-atts-src-"));
writeFileSync(join(src, "견적서 최종.pdf"), "%PDF-1.4 fixture-bytes");
writeFileSync(join(src, "현장사진.jpg"), "jpg-fixture-bytes");
const staged = stageDraftFiles("RATT0001", [join(src, "견적서 최종.pdf"), join(src, "현장사진.jpg")], root);
const mailStaged = stageDraftFiles("RMAIL001", [join(src, "견적서 최종.pdf")], root);
const COMMENT = { kind: "comment", key: "RCMT0001", author: "마피아팬", text: "악보 받을 수 있나요?", post: { title: "마피아 영상", link: "https://example.com/post/1", kind: "website" } };

const hub = fakeHub({
	api: async (req, url) => {
		const file = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/files\/(\d+)$/.exec(url.pathname);
		if (file) return draftFileRoute(req, url, file[1]!, file[2]!, root);
		if (url.pathname === "/api/drafts/RCMT0001/original") return json(COMMENT);
		if (url.pathname === "/api/drafts/RMAIL001/files" && req.method === "GET") return json({ files: mailStaged.map(f => ({ name: f.name, size: "22B" })), canAttach: true, library: false, editable: true, tracked: true });
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unreadCount() });
		if (url.pathname === "/api/notices" && req.method === "GET") return json(listNotices(100));
		if (url.pathname === "/api/notices/read") return json(markNoticesRead(await req.json()));
	},
});
const base = `${hub.origin}/`;
const open = async (width: number, height: number): Promise<View> => {
	const v = await hub.view({ width, height });
	await v.navigate(base);
	return v;
};
const settled = (v: View) => v.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => 0))).then(() => true)`);
type Box = { l: number; t: number; r: number; b: number; w: number; h: number };
const box = async (v: View, sel: string): Promise<Box | null> =>
	JSON.parse(await v.evaluate(`JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })())`));
const texts = async (v: View, sel: string): Promise<string[]> => JSON.parse(await v.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim()))`));
const stored = () => listNotices(300).items;
const find = (ref: string) => stored().find(n => n.kind === "decision" && n.decision?.state === "open" && n.decision.draft?.ref === ref)! as Notice;
const ask = (ref: string, extra: object, body = "안녕하세요.\n\n요청하신 견적서와 현장사진을 보내 드립니다.\n확인 후 편하게 말씀해 주세요.") =>
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${draftApprovalBlock({ to: "kim@example.com", subject: "견적서와 현장사진 회신", body, ref, ...extra })}` });
const openSheet = async (v: View, id: string) => {
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(id))})`);
	await waitFor(v, `document.querySelector(".fs-bd .fs-card .dc-act")`);
	await settled(v);
};

beforeAll(() => {
	resolveNotices({ ids: stored().filter(n => n.decision?.state === "open").map(n => n.id) });
	markNoticesRead({ all: true });
	ask("RATT0001", { attachments: staged });
	ask("RATT0002", { attachmentsNone: true }, "안녕하세요.\n\n요청하신 견적서를 첨부합니다.");
	ask("RATT0003", { attachmentsNone: true }, "안녕하세요.\n\n확인했어요. 회신은 내일 드릴게요.");
});
afterAll(() => {
	hub.stop();
	rmSync(root, { recursive: true, force: true });
	rmSync(src, { recursive: true, force: true });
});

describe("attachments in the send sheet", () => {
	for (const [name, w, h] of [["390", 390, 844], ["1280", 1280, 800]] as const) {
		test(`${name}px: two attachments are rows with icon, name and size inside the sheet, and a tap opens the staged file`, async () => {
			const dn = find("RATT0001");
			expect(dn.decision!.draft!.attachments).toEqual([{ name: "견적서 최종.pdf", size: "22B" }, { name: "현장사진.jpg", size: "17B" }]);
			const v = await open(w, h);
			await openSheet(v, String(dn.id));
			await waitFor(v, `document.querySelectorAll(".fs-body a.dr-att").length === 2`);
			expect(await texts(v, ".fs-body .dr-fn")).toEqual(["견적서 최종.pdf", "현장사진.jpg"]);
			expect(await texts(v, ".fs-body .dr-fm")).toEqual(["PDF · 22B", "JPG · 17B"]);
			expect(await texts(v, ".fs-body .dr-fh")).toEqual(["첨부 2개"]);
			expect(await v.evaluate(`[...document.querySelectorAll(".fs-body .dr-fi svg")].length`)).toBe(2);
			expect(await v.evaluate(`document.querySelector(".fs-body .dr-att:nth-child(3) .dr-fi svg path").getAttribute("d") !== document.querySelector(".fs-body .dr-att:nth-child(2) .dr-fi svg path").getAttribute("d")`)).toBe(true);
			expect(await v.evaluate(`!!document.querySelector(".fs-body .dr-warn, .fs-body .dr-none")`)).toBe(false);
			const card = (await box(v, ".fs-card"))!;
			for (const sel of [".fs-body a.dr-att:nth-of-type(1)", ".fs-body a.dr-att:nth-of-type(2)"]) {
				const b = (await box(v, sel))!;
				expect(b.h).toBeGreaterThanOrEqual(44);
				expect(b.l).toBeGreaterThanOrEqual(card.l);
				expect(b.r).toBeLessThanOrEqual(card.r);
				expect(b.b).toBeLessThanOrEqual((await box(v, ".fs-ft"))!.t);
			}
			expect(await v.evaluate(`[...document.querySelectorAll(".fs-body a.dr-att")].map(a => a.getAttribute("href")).join(" ")`)).toBe("/api/drafts/RATT0001/files/0 /api/drafts/RATT0001/files/1");
			expect(await v.evaluate(`fetch(document.querySelector(".fs-body a.dr-att").getAttribute("href")).then(r => r.text())`)).toBe("%PDF-1.4 fixture-bytes");
			expect(await v.evaluate(`document.querySelector(".fs-body a.dr-att").target`)).toBe("_blank");
		});
	}

	test("the claim in the text raises the warning above 보내기 (not under the files); a plain reply shows only 첨부 없음", async () => {
		const v = await open(390, 844);
		await openSheet(v, String(find("RATT0002").id));
		await waitFor(v, `document.querySelector(".fs-ft .dr-warn")`);
		expect(await texts(v, ".fs-ft .dr-wt > span:first-child")).toEqual([NO_ATTACHMENT_WARNING]);
		expect(await texts(v, ".fs-ft .dr-wn")).toEqual(["본문에는 보낸다고 썼어요"]);
		expect(await v.evaluate(`!!document.querySelector(".fs-body .dr-warn")`)).toBe(false);
		expect(await v.evaluate(`document.querySelectorAll(".fs-body .dr-att").length`)).toBe(0);
		expect(await v.evaluate(`document.querySelector(".fs-ft .dr-warn").getAttribute("role")`)).toBe("alert");
		const w2 = await open(390, 844);
		await openSheet(w2, String(find("RATT0003").id));
		await waitFor(w2, `document.querySelector(".fs-body .dr-none")`);
		expect(await w2.evaluate(`!!document.querySelector(".fs-ft .dr-warn")`)).toBe(false);
	});
});

describe("attachments in the mail draft card", () => {
	test("the card shows the same rows, and a mail draft without files shows 첨부 없음 (never a hidden row)", async () => {
		const v = await open(390, 900);
		await waitFor(v, `typeof draftCardNode === "function" && typeof draftFilesNode === "function"`);
		const n = find("RATT0001");
		const html = await v.evaluate(`(() => { const n = ${JSON.stringify(n)}; const c = draftCardNode(n); document.body.append(c); return c.querySelectorAll("a.dr-att").length + "|" + [...c.querySelectorAll(".dr-fn")].map(e => e.textContent).join(",") + "|" + c.querySelector("a.dr-att").getAttribute("href"); })()`);
		expect(html).toBe("2|견적서 최종.pdf,현장사진.jpg|/api/drafts/RATT0001/files/0");
		const plain = await v.evaluate(`(() => { const n = ${JSON.stringify({ ...n, decision: { ...n.decision, draft: { toLabel: "받는이", to: "a@b.c", body: "안녕하세요." } } })}; const f = draftFilesNode(n.decision.draft), c = draftCardNode(n).querySelector(".dr-files"); return [f.hidden, c.hidden, c.querySelector(".dr-none")?.textContent].join("|"); })()`);
		expect(plain).toBe("false|false|첨부: 없음");
	});
});

describe("a comment reply that sends a mail too", () => {
	const combined = () => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${draftApprovalBlock({ to: "마피아팬 댓글", toLabel: "대상", body: "악보는 메일로 보내 드렸어요", ref: "RCMT0001", question: "이 답글을 올리고 메일도 보낼까요?", mail: { id: "RMAIL001", to: "fan@example.com", subject: "악보 보내드립니다", body: "요청하신 악보를 보내드립니다.", attachments: mailStaged } })}` });
	beforeAll(combined);

	test("the mail part carries the mail draft id the files are staged under", () => {
		expect(find("RCMT0001").decision!.draft!.mail).toMatchObject({ ref: "RMAIL001", to: "fan@example.com", attachments: [{ name: "견적서 최종.pdf", size: "22B" }] });
	});

	for (const [name, w, h] of [["390", 390, 844], ["1280", 1280, 800]] as const) {
		test(`${name}px: the sheet shows the original, my reply, the mail fields and a clickable attached file`, async () => {
			const v = await open(w, h);
			await openSheet(v, String(find("RCMT0001").id));
			await waitFor(v, `document.querySelector(".fs-body .od-inline .od-ct") && document.querySelector(".fs-body .dr-mailpart .dr-fh.ok")`);
			expect(await texts(v, ".fs-body .dr-mh")).toEqual(["댓글 원문", "내 답글", "함께 보낼 메일"]);
			expect(await texts(v, ".fs-body .od-inline .dc-dr-v")).toEqual(["마피아팬"]);
			expect(await texts(v, ".fs-body .od-inline .od-ct")).toEqual(["악보 받을 수 있나요?"]);
			expect(await v.evaluate(`document.querySelector(".fs-body .od-inline a.od-open").getAttribute("href")`)).toBe("https://example.com/post/1");
			expect(await texts(v, ".fs-body > .dc-dr-b")).toEqual(["악보는 메일로 보내 드렸어요"]);
			expect(await texts(v, ".fs-body .dr-mailpart .dc-dr-k")).toEqual(["받는이", "제목"]);
			expect(await texts(v, ".fs-body .dr-mailpart .dc-dr-v")).toEqual(["fan@example.com", "악보 보내드립니다"]);
			expect(await texts(v, ".fs-body .dr-mailpart .dc-dr-b")).toEqual(["요청하신 악보를 보내드립니다."]);
			expect(await texts(v, ".fs-body .dr-mailpart .dr-fh")).toEqual(["✓ 첨부 1개 붙어 있어요"]);
			expect(await v.evaluate(`!!document.querySelector(".od-bar, .od-tg, .fs-body .dr-warn")`)).toBe(false);
			const href = await v.evaluate(`document.querySelector(".fs-body .dr-mailpart a.dr-att").getAttribute("href")`);
			expect(href).toBe("/api/drafts/RMAIL001/files/0");
			expect(await v.evaluate(`fetch(${JSON.stringify(href)}).then(r => r.status + ":" + r.headers.get("content-disposition")?.slice(0, 6))`)).toBe("200:inline");
			expect(await v.evaluate(`fetch(${JSON.stringify(href)}).then(r => r.text())`)).toBe("%PDF-1.4 fixture-bytes");
			expect(await texts(v, ".fs-ft .dc-act")).toEqual(["보내기", "고치기", "보내지 않기"]);
			const card = (await box(v, ".fs-card"))!, row = (await box(v, ".fs-body .dr-mailpart a.dr-att"))!;
			expect(row.h).toBeGreaterThanOrEqual(44);
			expect(row.l).toBeGreaterThanOrEqual(card.l);
			expect(row.r).toBeLessThanOrEqual(card.r);
		});
	}

	test("the docked card shows the same parts in order", async () => {
		const v = await open(390, 900);
		await waitFor(v, `typeof draftNode === "function"`);
		const d = find("RCMT0001").decision!.draft;
		await v.evaluate(`(() => { const c = draftNode(${JSON.stringify(d)}, { edit: true }); c.id = "combined-card"; document.body.append(c); return true; })()`);
		await waitFor(v, `document.querySelector("#combined-card .od-ct") && document.querySelector("#combined-card .dr-fh.ok")`);
		const out = await v.evaluate(`(() => { const c = document.getElementById("combined-card"); return [[...c.querySelectorAll(".dr-mh span")].map(e => e.textContent).join(","), c.querySelector(".od-ct").textContent, c.querySelector("a.dr-att").getAttribute("href")].join("|"); })()`);
		expect(out).toBe("댓글 원문,내 답글,함께 보낼 메일|악보 받을 수 있나요?|/api/drafts/RMAIL001/files/0");
	});
});

describe("files dotz did not stage", () => {
	test("a mail draft naming files dotz holds no record of shows them with a warning that they could not be checked", async () => {
		const v = await open(390, 900);
		await waitFor(v, `typeof draftFilesNode === "function"`);
		const got = await v.evaluate(`(() => { DRF.st.KX1 = { files: [], canAttach: false, library: false, editable: false, tracked: false }; const b = draftFilesNode({ ref: "KX1", toLabel: "받는이", to: "a@b.c", body: "x", attachments: [{ name: "신청.xlsx" }, { name: "증빙.pdf" }] }, { edit: false }); document.body.append(b); return [b.hidden, b.querySelectorAll(".dr-fn").length, b.querySelector(".dr-warn .dr-wt span")?.textContent].join("|"); })()`);
		expect(got).toBe("false|2|첨부파일이 실제로 붙었는지 확인하지 못했어요");
	});
});

