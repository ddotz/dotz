import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { listNotices, markNoticesRead, type Notice, resolveNotices, unreadCount } from "./notices.ts";
import { fakeHub, json, waitFor, type View } from "./test-web.ts";

// Every pop-up over the app is the same full-screen frame (web/css/14-overlay.css, web/js/38-overlay.js): on a phone it covers the tab bar with a fixed
// header and footer, on desktop it is a centered dialog. The computer switcher and the settings tab's dialogs (dialog({ classic: true })) keep their earlier look. Headless browser against the real notice store; every decision and form here is a fixture.
type Field = { name: string; label: string; type: string; optional?: boolean };
const FIELDS: Field[] = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, label: `칸 ${i + 1}`, type: "text" }));
let authList: unknown[] = [];
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/state")
			return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, auth: authList, notices_unread: unreadCount() });
		if (url.pathname === "/api/notices" && req.method === "GET") return json(listNotices(100));
		if (url.pathname === "/api/notices/read") return json(markNoticesRead(await req.json()));
	},
});
const base = `${hub.origin}/`;
const open = async (width: number, height: number): Promise<View> => {
	const v = await hub.view({ width, height });
	await v.navigate(base);
	await waitFor(v, `typeof noticeSheetOpen === "function" && document.querySelector(".hn")`);
	return v;
};
const settled = (v: View) => v.evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => 0))).then(() => true)`);
type Box = { l: number; t: number; r: number; b: number; w: number; h: number };
const box = async (v: View, sel: string): Promise<Box | null> =>
	JSON.parse(await v.evaluate(`JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })())`));
const ask = (title: string, opts = ["확인했어요", "아직이에요"]) =>
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: `[ask] ${title}\n결정: ${title}\n${opts.map((o, i) => `**${i + 1}) ${o}**`).join("\n")}` });
const find = (title: string) => listNotices(300).items.find(n => n.kind === "decision" && n.decision?.state === "open" && n.title.includes(title)) as Notice;

// one entry per overlay kind: how the page opens it and what proves it is open
const KINDS: { name: string; open: (id: string) => string; ready: string; frame: string }[] = [
	{ name: "notice sheet with option buttons (phone check)", open: id => `noticeSheetOpen(${JSON.stringify(id)})`, ready: `document.querySelector(".fs-card .ds-opt")`, frame: ".fs-card" },
	{
		name: "failure notice sheet",
		open: () => `ntDetailOpen({ id: "alert-x", title: "작업이 멈췄어요", text: ${JSON.stringify("긴 설명이에요. ".repeat(80))}, ts: new Date().toISOString() })`,
		ready: `document.querySelector(".fs-card .ds-md")`,
		frame: ".fs-card",
	},
	{
		name: "decision card sheet",
		open: () =>
			`(() => { window.__dc = { key: "k1", t: "main", sig: "s1", at: "", question: ${JSON.stringify("어느 쪽으로 진행할까요? ".repeat(30))}, blocks: [{ title: "", options: [{ n: 1, label: "지금 바로 보내기", rec: true, desc: "받는 사람이 바로 봐요" }, { n: 2, label: "내일 아침에 보내기" }, { n: 3, label: "보내지 않기" }] }] }; decisionOf = () => window.__dc; dkOpen(window.__dc, null, "", null); })()`,
		ready: `document.querySelector(".fs-card .dc-row")`,
		frame: ".fs-card",
	},
	{
		name: "generic dialog",
		open: () => `dialog({ title: "삭제할까요?", body: el("p", { text: "되돌릴 수 없어요" }), actions: [{ label: "취소", onclick: c => c() }, { label: "삭제", kind: "pri", onclick: c => c() }] })`,
		ready: `document.querySelector("dialog.fs-card[open] .dact .btn")`,
		frame: "dialog.fs-card",
	},
];

beforeAll(() => {
	resolveNotices({ ids: listNotices(300).items.filter(n => n.decision?.state === "open").map(n => n.id) });
	markNoticesRead({ all: true });
	ask("오버레이 확인");
});
afterAll(() => {
	hub.stop();
	// the notice store is one per process: leave no open fixture decision behind for the next file
	resolveNotices({ ids: listNotices(300).items.filter(n => n.decision?.state === "open").map(n => n.id) });
	markNoticesRead({ all: true });
});

const coversPhone = async (v: View, w: number, h: number, frame: string) => {
	const card = (await box(v, frame))!;
	expect(card).toBeTruthy();
	expect([card.l, card.t, card.w, card.h]).toEqual([0, 0, w, h]);
	// the tab bar is under the overlay: what sits at its centre belongs to the frame
	expect(await v.evaluate(`(() => { const n = document.querySelector("#nav"); if (!n) return true; const r = n.getBoundingClientRect(); if (!r.height) return true; const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && !!e.closest(${JSON.stringify(frame)}); })()`)).toBe(true);
	const inside = async (sel: string) => {
		const b = (await box(v, `${frame} ${sel}`))!;
		expect(b).toBeTruthy();
		expect(b.t).toBeGreaterThanOrEqual(card.t);
		expect(b.b).toBeLessThanOrEqual(card.b);
		expect(b.r).toBeLessThanOrEqual(card.r);
		return b;
	};
	const hd = await inside(".fs-hd");
	const x = await inside(".fs-x");
	expect(x.h).toBeGreaterThanOrEqual(44);
	expect(hd.t).toBe(0 + 0 * card.t);
	const ft = await box(v, `${frame} .fs-ft`);
	if (ft) expect(ft.b).toBeLessThanOrEqual(card.b);
	expect(await v.evaluate(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(w);
};

describe("every overlay opens as the shared full-screen frame", () => {
	for (const [w, h] of [
		[390, 844],
		[360, 740],
	] as const) {
		test(`phone ${w}px: each kind covers the screen, tab bar included, with a pinned header and footer`, async () => {
			const phone = await open(w, h);
			const pid = String(find("오버레이 확인").id);
			for (const k of KINDS) {
				await phone.evaluate(k.open(pid));
				await waitFor(phone, k.ready);
				await settled(phone);
				await coversPhone(phone, w, h, k.frame);
				if (w === 390) {
					const slug = k.name.replace(/[^a-z]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
				}
				// Esc closes it
				await phone.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
				await waitFor(phone, `!document.querySelector(".fs-bd, dialog.fs-card")`);
			}
		}, 60_000);
	}

	test("the back button closes the notice sheet and the page stays", async () => {
		const phone = await open(390, 844);
		await phone.evaluate(`noticeSheetOpen(${JSON.stringify(String(find("오버레이 확인").id))})`);
		await waitFor(phone, `document.querySelector(".fs-card .ds-opt")`);
		await phone.evaluate(`history.back()`);
		await waitFor(phone, `!document.querySelector(".fs-bd")`);
		expect(await phone.evaluate(`!!document.querySelector(".hn")`)).toBe(true);
	}, 30_000);

	test("the computer switcher stays the original bottom sheet, not the full-screen frame", async () => {
		const phone = await open(390, 844);
		await phone.evaluate(`(() => { prLoad = async () => {}; PR.list = [{ name: "맥미니", self: true, online: true, need: 0 }, { name: "노트북", online: false, need: 2 }]; prOpen(); })()`);
		await waitFor(phone, `document.querySelector(".ds-bd .ds-sheet .pr-row")`);
		await settled(phone);
		expect(await phone.evaluate(`!document.querySelector(".fs-bd, .fs-card")`)).toBe(true);
		const sheet = (await box(phone, ".ds-sheet"))!;
		expect(sheet.w).toBe(390);
		expect(sheet.t).toBeGreaterThan(0);
		expect(sheet.h).toBeLessThan(844);
		expect(await phone.evaluate(`getComputedStyle(document.querySelector(".ds-sheet")).borderTopLeftRadius`)).toBe("20px");
		await phone.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
		await waitFor(phone, `!document.querySelector(".ds-bd")`);
	}, 30_000);

	test("a settings dialog stays the small centered box, not the full-screen frame", async () => {
		const phone = await open(390, 844);
		await phone.evaluate(`dialog({ classic: true, title: "재시작", body: el("p", { text: "작업이 끝난 뒤 재시작할 수 있어요" }), actions: [{ label: "취소", onclick: c => c() }, { label: "재시작", kind: "pri", onclick: c => c() }] })`);
		await waitFor(phone, `document.querySelector("dialog.dlg.cl[open] .dhd .dx") && document.querySelector("dialog.dlg.cl .dact .btn")`);
		await settled(phone);
		expect(await phone.evaluate(`!document.querySelector(".fs-bd, .fs-card, .fs-hd")`)).toBe(true);
		const dlg = (await box(phone, "dialog.dlg.cl"))!;
		expect(dlg.w).toBeGreaterThan(300);
		expect(dlg.w).toBeLessThanOrEqual(366);
		expect(dlg.t).toBeGreaterThan(0);
		expect(dlg.h).toBeLessThan(844);
		expect(await phone.evaluate(`getComputedStyle(document.querySelector("dialog.dlg.cl")).paddingTop`)).toBe("20px");
		await phone.click("dialog.dlg.cl .dhd .dx");
		await waitFor(phone, `!document.querySelector("dialog[open]")`);
	}, 30_000);

	test("a login request form is full screen: fields scroll between a pinned header and footer", async () => {
		authList = [{ id: "au1", kind: "form", title: "개인정보 입력", site: "example.com", purpose: "예약 사이트에 넣을 정보예요", fields: FIELDS, remember: false }];
		const phone = await open(390, 844);
		await waitFor(phone, `document.querySelector(".fs-card .au, .fs-card input")`);
		await settled(phone);
		await coversPhone(phone, 390, 844, ".fs-card");
		const card = (await box(phone, ".fs-card"))!;
		const send = (await box(phone, ".fs-ft .btn[type=submit]"))!;
		expect(send.h).toBeGreaterThanOrEqual(44);
		expect(send.b).toBeLessThanOrEqual(card.b);
		expect(await phone.evaluate(`(() => { const b = document.querySelector(".fs-body"); return b.scrollHeight > b.clientHeight + 100; })()`)).toBe(true);
		const footTop = (await box(phone, ".fs-ft"))!.t;
		await phone.evaluate(`document.querySelector(".fs-body").scrollTop = 1e6`);
		await settled(phone);
		expect((await box(phone, ".fs-ft"))!.t).toBe(footTop);
		expect((await box(phone, ".fs-hd"))!.t).toBe(0);
		expect((await box(phone, ".fs-ft .btn[type=submit]"))!.b).toBeLessThanOrEqual(card.b);
		// closing hides it without answering; the request is still pending
		await phone.click(".fs-hd .fs-x");
		await waitFor(phone, `!document.querySelector(".fs-bd")`);
		expect(await phone.evaluate(`AUTH_CARDS.has("au1") && !AUTH_DONE.has("au1")`)).toBe(true);
		authList = [];
	}, 60_000);

	test("desktop: every kind is a centered dialog, not full screen", async () => {
		const desk = await open(1280, 800);
		const pid = String(find("오버레이 확인").id);
		for (const k of KINDS) {
			await desk.evaluate(k.open(pid));
			await waitFor(desk, k.ready);
			await settled(desk);
			const c = (await box(desk, k.frame))!;
			expect(c.w).toBeGreaterThanOrEqual(400);
			expect(c.w).toBeLessThanOrEqual(740);
			expect(c.h).toBeLessThan(800);
			expect(Math.abs((c.l + c.r) / 2 - 640)).toBeLessThanOrEqual(2);
			expect(Math.abs((c.t + c.b) / 2 - 400)).toBeLessThanOrEqual(2);
			await desk.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
			await waitFor(desk, `!document.querySelector(".fs-bd, dialog.fs-card")`);
		}
	}, 60_000);
});
