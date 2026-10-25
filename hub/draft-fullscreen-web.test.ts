import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { emit } from "./events.ts";
import { listNotices, markNoticesRead, type Notice, resolveNotices, unreadCount } from "./notices.ts";
import { fakeHub, json, waitFor, type View } from "./test-web.ts";

// Send-approval drafts open as a full-screen view (a large dialog on desktop); every other decision uses the same full-screen frame (hub/overlay-fullscreen-web.test.ts) without the large size.
// Headless browser against the real notice store; the decisions are fixtures and nothing is sent.
const SNAP = "/tmp/dotz-draft-fullscreen";
const hub = fakeHub({
	api: async (req, url) => {
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
const stored = () => listNotices(300).items;
const MAIL = Array.from({ length: 28 }, (_, i) => `${i + 1}번째 줄이에요. 지난 회의에서 정한 일정과 담당을 다시 정리해서 보내 드립니다. 확인 부탁드립니다.`).join("\n");
const draft = (ref: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${draftApprovalBlock({ to: "kim@example.com", subject: "다음 주 일정 정리와 담당자 확인 요청", body: MAIL, ref })}` });
const plain = (title: string) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${title}\n**1) 예**\n**2) 아니요**` });
const find = (pred: (n: Notice) => boolean) => stored().find(n => n.kind === "decision" && n.decision?.state === "open" && pred(n))! as Notice;

beforeAll(() => {
	Bun.spawnSync(["mkdir", "-p", SNAP]);
});
afterAll(() => hub.stop());

describe("draft approval opens full screen", () => {
	test("a draft decision opens the full-screen view with the buttons always visible; any other decision opens the normal-size frame", async () => {
		resolveNotices({ ids: stored().filter(n => n.decision?.state === "open").map(n => n.id) });
		markNoticesRead({ all: true });
		draft("d-full-1");
		plain("그냥 결정이에요");
		const dn = find(n => !!n.decision?.draft);
		const pn = find(n => !n.decision?.draft && n.title === "그냥 결정이에요");
		expect(dn.decision!.draft!.body).toContain("28번째 줄");

		// phone 390: the view covers the whole screen, tab bar included
		const phone = await open(390, 844);
		await waitFor(phone, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
		await phone.evaluate(`noticeSheetOpen(${JSON.stringify(String(dn.id))})`);
		await waitFor(phone, `document.querySelector(".fs-bd .fs-card.tall .dc-act")`);
		await settled(phone);
				const card = (await box(phone, ".fs-card.tall"))!;
		expect(card.w).toBe(390);
		expect(card.t).toBe(0);
		expect(card.h).toBe(844);
		const inside = async (sel: string) => {
			const b = (await box(phone, sel))!;
			expect(b).toBeTruthy();
			expect(b.t).toBeGreaterThanOrEqual(card.t);
			expect(b.b).toBeLessThanOrEqual(card.b);
			return b;
		};
		await inside(".fs-hd");
		await inside(".fs-hd .fs-ign");
		await inside(".fs-hd .fs-x");
		const send = await inside(".dc-act.main");
		expect((await inside(".dc-acts .dc-act:nth-child(2)")).h).toBeGreaterThanOrEqual(44);
		expect(send.h).toBeGreaterThanOrEqual(44);
		expect(send.h).toBeLessThanOrEqual(48);
		expect(await phone.evaluate(`document.querySelector(".fs-body").scrollHeight > document.querySelector(".fs-body").clientHeight + 200`)).toBe(true);
		await Bun.write(`${SNAP}/draft-390-top.png`, await phone.screenshot());

		// scrolled to the end of the draft: header and footer did not move
		const footTop = (await box(phone, ".fs-ft"))!.t;
		await phone.evaluate(`document.querySelector(".fs-body").scrollTop = 1e6`);
		await settled(phone);
		expect((await box(phone, ".fs-ft"))!.t).toBe(footTop);
		expect((await box(phone, ".fs-hd"))!.t).toBe(card.t);
		await inside(".dc-act.main");
		await Bun.write(`${SNAP}/draft-390-scrolled.png`, await phone.screenshot());

		// 고치기: the input and its send button stay in the footer
		await phone.evaluate(`document.querySelector(".dc-acts .dc-act:nth-child(2)").click()`);
		await waitFor(phone, `document.querySelector(".fs-ft .dc-note")`);
		await waitFor(phone, `document.activeElement && document.activeElement.classList.contains("dc-note")`);
		await inside(".fs-ft .dc-note");
		await inside(".fs-ft .dc-go");
		expect(await phone.evaluate(`!!document.querySelector(".fs-ft .dc-go").disabled`)).toBe(true);
		await phone.evaluate(`(() => { const t = document.querySelector(".dc-note"); t.value = "인사말을 더 짧게 해 주세요"; t.dispatchEvent(new Event("input")); })()`);
		expect(await phone.evaluate(`!!document.querySelector(".fs-ft .dc-go").disabled`)).toBe(false);
		await settled(phone);
		await Bun.write(`${SNAP}/draft-390-edit.png`, await phone.screenshot());
		await phone.evaluate(`dkClose()`);
		await waitFor(phone, `!document.querySelector(".fs-bd")`);

		// the same view at 360
		const small = await open(360, 740);
		await waitFor(small, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
		await small.evaluate(`noticeSheetOpen(${JSON.stringify(String(dn.id))})`);
		await waitFor(small, `document.querySelector(".fs-bd .fs-card.tall .dc-act")`);
		await settled(small);
		const sc = (await box(small, ".fs-card.tall"))!;
		expect(sc.w).toBe(360);
		for (const sel of [".dc-act.main", ".dc-acts .dc-act:nth-child(3)", ".fs-hd .fs-ign", ".fs-hd .fs-x"]) expect((await box(small, sel))!.b).toBeLessThanOrEqual(sc.b);
		await Bun.write(`${SNAP}/draft-360.png`, await small.screenshot());

		// a plain decision is full screen on the phone too, but not the large dialog
		await phone.evaluate(`noticeSheetOpen(${JSON.stringify(String(pn.id))})`);
		await waitFor(phone, `document.querySelector(".fs-card .ds-opt")`);
		await settled(phone);
		expect(await phone.evaluate(`!!document.querySelector(".fs-card.tall")`)).toBe(false);
		const sheet = (await box(phone, ".fs-card"))!;
		expect(sheet.h).toBe(844);
		await phone.evaluate(`ntSheetClose()`);

		// desktop: a large centered dialog
		const desk = await open(1280, 800);
		await waitFor(desk, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
		await desk.evaluate(`noticeSheetOpen(${JSON.stringify(String(dn.id))})`);
		await waitFor(desk, `document.querySelector(".fs-bd .fs-card.tall .dc-act")`);
		await settled(desk);
		const dc = (await box(desk, ".fs-card.tall"))!;
		expect(dc.w).toBeGreaterThanOrEqual(600);
		expect(dc.h).toBeGreaterThanOrEqual(600);
		expect(Math.abs((dc.l + dc.r) / 2 - 640)).toBeLessThanOrEqual(2);
		expect(Math.abs((dc.t + dc.b) / 2 - 400)).toBeLessThanOrEqual(2);
		expect((await box(desk, ".dc-act.main"))!.b).toBeLessThanOrEqual(dc.b);
		await Bun.write(`${SNAP}/draft-desktop.png`, await desk.screenshot());
	}, 90_000);
});
