import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { answerDecision, listNotices, markNoticesRead, type Notice, resolveNotices, unreadCount } from "./notices.ts";
import { fakeHub, inbox, json, type View, waitFor } from "./test-web.ts";

// 직접 수정 on a send-approval card can attach files (web/js/10-decision-card.js editFilesNode). A draft dotz tracks and can change (a reply-drafts
// mail draft) takes the file onto its 첨부 rows at once; any other draft uploads it, shows a chip, and the 고치기 answer carries it as `files`
// (POST /api/notices/<id>/answer, hub/routes.ts -> hub/notices.ts answerDecision -> sendWeb). Headless browser against the real notice store.
type Rec = { path: string; name: string; type: string; size: number };
const staged: { name: string; size: string }[] = [];
const uploads: string[] = [];
const posts = inbox<{ path: string; body: any }>();
const hub = fakeHub({
	api: async (req, url) => {
		const files = () => json({ files: staged, canAttach: true, library: false, editable: true, tracked: true });
		if (url.pathname === "/api/drafts/RTRK0001/files") {
			if (req.method === "GET") return files();
			const b = (await req.json()) as { upload?: Rec };
			if (b.upload) { staged.push({ name: b.upload.name, size: `${b.upload.size}B` }); posts.push({ path: url.pathname, body: b }); }
			return files();
		}
		if (url.pathname === "/api/upload" && req.method === "POST") {
			const f = (await req.formData()).get("file") as File;
			uploads.push(f.name);
			return json({ ok: true, files: [{ path: `/tmp/uploads/${f.name}`, name: f.name, type: f.type, size: f.size }] });
		}
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: unreadCount() });
		if (url.pathname === "/api/notices" && req.method === "GET") return json(listNotices(100));
		if (url.pathname === "/api/notices/read") return json(markNoticesRead(await req.json()));
		if (req.method === "POST" && (url.pathname === "/api/message" || url.pathname.endsWith("/answer"))) { posts.push({ path: url.pathname, body: await req.json() }); return json({}); }
	},
});
const open = async (width: number, height: number): Promise<View> => {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	return v;
};
const find = (ref: string) => listNotices(300).items.find(n => n.kind === "decision" && n.decision?.state === "open" && n.decision.draft?.ref === ref)! as Notice;
const ask = (ref: string, extra: object) =>
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${draftApprovalBlock({ subject: "견적서 회신", body: "안녕하세요.\n견적서를 보내 드립니다.", ref, ...extra })}` });
const openManual = async (v: View, id: string) => {
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(id))})`);
	await waitFor(v, `document.querySelector(".fs-ft .dc-manual")`);
	await v.evaluate(`(document.querySelector(".fs-ft .dc-manual").click(), 0)`);
	await waitFor(v, `document.querySelector(".fs-ft .dc-note") && document.querySelector(".fs-ft .dc-fl .dr-add")`);
};
// Picks files the way the file dialog would: sets the hidden input's list and fires its change event.
const pick = (v: View, ...names: string[]) =>
	v.evaluate(`(() => { const i = document.querySelector(".fs-ft .dc-fl input[type=file]"), dt = new DataTransfer(); for (const n of ${JSON.stringify(names)}) dt.items.add(new File(["내용-" + n], n, { type: n.endsWith(".pdf") ? "application/pdf" : "text/plain" })); i.files = dt.files; i.dispatchEvent(new Event("change")); return 0; })()`);
const type = (v: View, text: string) => v.evaluate(`(() => { const t = document.querySelector(".fs-ft .dc-note"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); return 0; })()`);
const box = async (v: View, sel: string) =>
	JSON.parse(await v.evaluate(`JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; })())`)) as { l: number; t: number; r: number; b: number } | null;

beforeAll(() => {
	resolveNotices({ ids: listNotices(300).items.filter(n => n.decision?.state === "open").map(n => n.id) });
	markNoticesRead({ all: true });
	ask("RTRK0001", { to: "kim@example.com" });
	ask("RSES0001", { to: "마피아팬 댓글", toLabel: "대상" });
});
afterAll(() => hub.stop());

for (const [name, w, h] of [["390", 390, 844], ["1280", 1280, 800]] as const) {
	describe(`${name}px`, () => {
		test("a tracked mail draft: the picked file is staged onto its 첨부 rows at once, no chip, nothing sent", async () => {
			staged.length = 0;
			posts.length = 0;
			const v = await open(w, h);
			const n = find("RTRK0001");
			await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
			await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(n.id))})`);
			await waitFor(v, `document.querySelector(".fs-ft .dc-manual") && typeof DRF !== "undefined" && DRF.st.RTRK0001 && DRF.add.RTRK0001`);
			await v.evaluate(`(document.querySelector(".fs-ft .dc-manual").click(), 0)`);
			await waitFor(v, `document.querySelector(".fs-ft .dc-fl .dr-add")`);
			expect(await v.evaluate(`document.querySelector(".fs-ft .dc-fl .dr-add").textContent.trim()`)).toBe("파일 첨부");
			expect(await v.evaluate(`document.querySelectorAll(".fs-body .dr-ar").length`)).toBe(0);
			await pick(v, "견적서.pdf");
			await waitFor(v, `document.querySelectorAll(".fs-body .dr-ar").length === 1`);
			expect(await v.evaluate(`document.querySelector(".fs-body .dr-ar .dr-fn").textContent`)).toBe("견적서.pdf");
			expect(await v.evaluate(`document.querySelectorAll(".fs-ft .dc-fl .fatt").length`)).toBe(0);
			await posts.until(p => p.length === 1, 10_000, "the draft's files POST");
			expect(posts[0]!.path).toBe("/api/drafts/RTRK0001/files");
			expect(posts[0]!.body.upload).toMatchObject({ name: "견적서.pdf", path: "/tmp/uploads/견적서.pdf" });
			// the typed text survives, and the answer carries no files (they are on the draft already)
			await type(v, "안녕하세요. 견적서를 첨부합니다.");
			await v.evaluate(`(document.querySelector(".fs-ft .dc-go").click(), 0)`);
			await posts.until(p => p.some(x => x.path.endsWith("/answer")), 10_000, "the answer");
			const ans = posts.find(x => x.path.endsWith("/answer"))!;
			expect(ans.body).toEqual({ n: 2, note: "이 내용으로 고쳐 주세요: 안녕하세요. 견적서를 첨부합니다." });
		});

		test("any other draft: chips under the textarea (removable), and the 고치기 answer goes out with the uploaded files", async () => {
			uploads.length = 0;
			posts.length = 0;
			const v = await open(w, h);
			const n = find("RSES0001");
			await openManual(v, String(n.id));
			await pick(v, "보고서.pdf", "현장 사진 메모 아주 긴 파일 이름 예시입니다.txt");
			await waitFor(v, `document.querySelectorAll(".fs-ft .dc-fl .fatt").length === 2`);
			expect(uploads).toEqual(["보고서.pdf", "현장 사진 메모 아주 긴 파일 이름 예시입니다.txt"]);
			// fits: every chip and the add control stay inside the sheet's footer
			const ft = (await box(v, ".fs-ft"))!;
			for (const sel of [".fs-ft .dc-fl .dr-add", ".fs-ft .dc-fl .fatt:nth-of-type(1)", ".fs-ft .dc-fl .fatt:nth-of-type(2)"]) {
				const b = (await box(v, sel))!;
				expect(b.l).toBeGreaterThanOrEqual(ft.l);
				expect(b.r).toBeLessThanOrEqual(ft.r);
			}
			await v.evaluate(`(document.querySelectorAll(".fs-ft .dc-fl .fatt .ax")[1].click(), 0)`);
			await waitFor(v, `document.querySelectorAll(".fs-ft .dc-fl .fatt").length === 1`);
			await type(v, "안녕하세요. 보고서를 보내 드립니다.");
			await v.evaluate(`(document.querySelector(".fs-ft .dc-go").click(), 0)`);
			await posts.until(p => p.length === 1, 10_000, "the answer");
			expect(posts[0]!.path).toBe(`/api/notices/${n.id}/answer`);
			expect(posts[0]!.body).toEqual({
				n: 2,
				note: "첨부할 파일 1개(보고서.pdf)를 이 초안에 붙여 주세요. 이 내용으로 고쳐 주세요: 안녕하세요. 보고서를 보내 드립니다.",
				files: [{ path: "/tmp/uploads/보고서.pdf", name: "보고서.pdf", type: "application/pdf", size: new TextEncoder().encode("내용-보고서.pdf").length }],
			});
		});
	});
}

describe("the hub's answer path", () => {
	test("a draft 고치기 hands the validated files to the send; a decision that is not a draft edit drops them", async () => {
		ask("RHUB0001", { to: "kim@example.com" });
		const n = find("RHUB0001");
		const files = [{ path: "/tmp/uploads/a.pdf", name: "a.pdf", type: "application/pdf", size: 3 }];
		const sent: { text: string; files?: unknown }[] = [];
		const r = await answerDecision(n.id, { n: 2, note: "이 내용으로 고쳐 주세요: x", files }, async a => { sent.push(a); });
		expect(r.status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.files).toEqual(files);
		ask("RHUB0002", { to: "kim@example.com" });
		const m = find("RHUB0002");
		const other: { files?: unknown }[] = [];
		await answerDecision(m.id, { n: 3, files }, async a => { other.push(a); });
		expect(other[0]!.files).toBeUndefined();
	});
});
