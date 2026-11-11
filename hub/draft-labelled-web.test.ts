import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { draftAttachRoute } from "./draft-attach.ts";
import { draftRecipientsRoute } from "./draft-recipients.ts";
import { emit } from "./events.ts";
import { listNotices, markNoticesRead, resolveNotices, unreadCount } from "./notices.ts";
import { SHOT_LABELLED } from "./owner-text.fixture.ts";
import { fakeHub, idleState, json, waitFor, type View } from "./test-web.ts";

// A send approval a session wrote by hand has no reply-draft record: the sheet shows its fields, its named file and only what can work.
// Headless browser against the real notice store and draft routes; the answer stops at the fake route.
const LANE = "pilot-stage1";
const lanes = [{ name: LANE, title: "Pilot", status: "idle", live: true, alive: true }, { name: "gone", title: "끝난 세션", status: "done", live: false, alive: false, resumable: false }];
let answered = Promise.withResolvers<Record<string, unknown>>();
const hub = fakeHub({
	state: () => idleState({ lanes, notices_unread: unreadCount() }),
	api: async (req, url) => {
		const p = url.pathname, dr = /^\/api\/drafts\/([^/]+)\/(.+)$/.exec(p);
		if (dr?.[2] === "recipients") return draftRecipientsRoute(req, decodeURIComponent(dr[1]!));
		if (dr) return draftAttachRoute(req, url, decodeURIComponent(dr[1]!), dr[2]!);
		if (p === "/api/notices" && req.method === "GET") return json(listNotices(100));
		if (p === "/api/notices/read") return json(markNoticesRead(await req.json()));
		if (/^\/api\/notices\/[^/]+\/answer$/.test(p)) {
			answered.resolve(await req.json() as Record<string, unknown>);
			return json({ ok: true });
		}
	},
});
const report = (lane: string, ts: string) => emit("inbox", { ts, kind: "lane_report", source: `lane:${lane}`, lane, text: SHOT_LABELLED });
const notice = (lane: string) => listNotices(100).items.find(n => n.decision?.state === "open" && n.decision.to === `lane:${lane}`)!;
const sheet = async (w: number, h: number, lane = LANE): Promise<View> => {
	const v = await hub.view({ width: w, height: h });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	await v.evaluate(`noticeSheetOpen(${JSON.stringify(String(notice(lane).id))})`);
	await waitFor(v, `document.querySelector(".fs-bd .fs-card .fs-body") && document.querySelector(".fs-body .dr-note")`);
	return v;
};
const texts = async (v: View, sel: string): Promise<string[]> => JSON.parse(await v.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim()))`) as string);

beforeAll(() => {
	resolveNotices({ ids: listNotices(100).items.filter(n => n.decision?.state === "open").map(n => n.id) });
	report(LANE, "2050-01-01T00:00:00.000Z");
	report("gone", "2050-01-01T00:00:01.000Z");
});
afterAll(() => hub.stop());

describe("the sheet of a card with no reply-draft record", () => {
	for (const [w, h] of [[390, 844], [1280, 800]] as const)
		test(`${w}px: 받는이, the named file with a plain note, no warning, no 원문, the body as in chat`, async () => {
			const v = await sheet(w, h);
			expect(await texts(v, ".fs-body .dr-rcrow[data-row=to] .dr-rc-t")).toEqual(["owner@example.com"]);
			expect(await texts(v, ".fs-body .dr-fn")).toEqual(["Pilot-portable.zip"]);
			expect(await texts(v, ".fs-body .dr-note")).toHaveLength(1);
			expect(await v.evaluate(`!!document.querySelector(".fs-card .dr-warn, .fs-body .dr-none, .fs-body a.dr-att, .fs-body .dr-add, .fs-body .dr-x, .fs-body .dr-rc-add")`)).toBe(false);
			await waitFor(v, `DRF.st["pilot-5d3d419"]`);
			expect(await v.evaluate(`!!document.querySelector(".od-bar, .od-seg, .od-orig")`)).toBe(false);
			const body = (await texts(v, ".fs-body .dc-dr-b"))[0]!;
			expect(body.startsWith("PaddleOCR")).toBe(true);
			expect(body).not.toContain("본문:");
			expect(body).not.toContain("첨부:");
			expect(body).not.toContain("`");
			expect(await texts(v, ".fs-body .dc-dr-b code")).toContain("/chat/completions");
			expect(body).toContain("%LOCALAPPDATA%\\Pilot\\pilot.log");
		});

	test("보내기, 고치기, 보내지 않기 and 직접 수정 show, because the session takes each of them; 고치기 answers the notice", async () => {
		const v = await sheet(390, 844);
		expect(await texts(v, ".fs-ft button")).toEqual(["보내기", "고치기", "보내지 않기", "직접 수정"]);
		await v.evaluate(`document.querySelector(".fs-ft .rq-acts .btn.tonal").click()`);
		await waitFor(v, `document.querySelector(".fs-ft .dc-note")`);
		await v.evaluate(`(() => { const t = document.querySelector(".fs-ft .dc-note"); t.value = "제목을 줄여 줘"; t.dispatchEvent(new Event("input")); document.querySelector(".fs-ft .dc-go").click(); })()`);
		expect(await answered.promise).toMatchObject({ n: 2, note: "제목을 줄여 줘", label: "고치기" });
	});

	test("직접 수정 opens the clean body and goes back to the session as a 고치기", async () => {
		answered = Promise.withResolvers();
		const v = await sheet(390, 844);
		await v.evaluate(`document.querySelector(".fs-ft .rq-manual").click()`);
		await waitFor(v, `document.querySelector(".fs-ft .dc-note")`);
		const text = await v.evaluate(`document.querySelector(".fs-ft .dc-note").value`) as string;
		expect(text.startsWith("PaddleOCR")).toBe(true);
		expect(text).not.toContain("본문:");
		await v.evaluate(`(() => { const t = document.querySelector(".fs-ft .dc-note"); t.value = "짧게 고친 본문"; t.dispatchEvent(new Event("input")); document.querySelector(".fs-ft .dc-go").click(); })()`);
		expect(await answered.promise).toMatchObject({ n: 2, note: "이 내용으로 고쳐 주세요: 짧게 고친 본문", label: "고치기" });
	});

	test("a session that has ended can take no answer: no buttons, a plain line says so", async () => {
		const v = await sheet(390, 844, "gone");
		expect(await texts(v, ".fs-ft button")).toEqual([]);
		expect(await texts(v, ".fs-ft .dc-gone")).toHaveLength(1);
	});
});

describe("빠른 처리 and the queue", () => {
	test("the text box only stands where the words can be changed in place", async () => {
		const v = await hub.view({ width: 390, height: 844 });
		await v.navigate(`${hub.origin}/`);
		await waitFor(v, `typeof trOneView === "function"`);
		const d = notice(LANE).decision!.draft!;
		const got = JSON.parse(await v.evaluate(`(() => { const [b] = trOneView({ ref: ${JSON.stringify(d.ref)}, to: "lane:pilot-stage1", question: "q", draft: ${JSON.stringify(d)}, sendable: false, editable: false }); document.body.append(b); return JSON.stringify({ ta: !!b.querySelector("textarea"), code: b.querySelectorAll(".dc-dr-b code").length }); })()`) as string);
		expect(got.ta).toBe(false);
		expect(got.code).toBeGreaterThan(3);
	});

	test("the queue card shows the same fields and rendered body", async () => {
		const v = await hub.view({ width: 390, height: 844 });
		await v.navigate(`${hub.origin}/`);
		await waitFor(v, `typeof draftCardNode === "function"`);
		await v.evaluate(`(() => { const c = draftCardNode(${JSON.stringify(notice(LANE))}); c.id = "qc"; document.body.append(c); })()`);
		await waitFor(v, `document.querySelector("#qc .dr-note") && document.querySelector("#qc .dr-rcrow")`);
		expect(await texts(v, "#qc .dr-rc-t")).toEqual(["owner@example.com"]);
		expect(await texts(v, "#qc .dr-fn")).toEqual(["Pilot-portable.zip"]);
		expect(await v.evaluate(`!!document.querySelector("#qc .dr-warn, #qc .dr-none, #qc a.dr-att")`)).toBe(false);
		expect((await texts(v, "#qc .dr-body"))[0]).not.toContain("본문:");
		expect((await texts(v, "#qc .dr-body code"))).toContain("연결 시험");
	});
});
