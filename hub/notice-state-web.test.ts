import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { fakeHub, json, ev, waitFor, type View } from "./test-web.ts";

// A decision the owner already answered does not read as waiting on the 알림 screen, and the 홈 알림 card's count is the length of its own list.
// Headless (Bun.WebView) against a fake hub. NOTICE_STATE_SHOTS=<dir>|<tag> also writes flows-f5-notices-390-light-<tag>.png and flows-f6-home-390-light-<tag>.png.
const SHOTS = process.env.NOTICE_STATE_SHOTS ?? "";
const [shotDir, shotTag = "after"] = SHOTS.split("|");
const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const OPTS = [{ n: 1, label: "일부 공지", desc: "" }, { n: 2, label: "전체 공지", desc: "" }];
const decision = (id: string, m: number, state: "open" | "answered", read: boolean) => ({
	id, ts: at(m), updated: at(m), kind: "decision", cls: "ask", tone: "ask", title: "공지 범위", text: "공지를 어디까지 낼까요?", open: "lane:flows", src: "lane:flows", read,
	decision: { options: OPTS, to: "lane:flows", group: 1, state, ...(state === "answered" ? { answer: "2) 전체 공지", answered_at: at(m) } : {}) },
});
const NOTES = [
	decision("d-open", 5, "open", false),
	decision("d-answered", 20, "answered", true),
	{ id: "n-alert", ts: at(10), updated: at(10), kind: "out", cls: "alert", tone: "warn", title: "디스크가 거의 찼어요", text: "남은 공간이 5% 아래예요.", read: false },
	{ id: "n-watch", ts: at(15), updated: at(15), kind: "watch", cls: "alert", tone: "fail", waits: "fail", title: "가격 확인", text: "가격 확인: 2번 연속 실패했어요", read: false },
];
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items: NOTES, unread: NOTES.filter(n => !n.read).length });
		if (url.pathname === "/api/monitors") return json({ items: [] });
	},
});
afterAll(() => hub.stop());

const shot = async (v: View, name: string) => {
	if (!shotDir) return;
	mkdirSync(shotDir, { recursive: true });
	await Bun.write(`${shotDir}/${name}-${shotTag}.png`, await v.screenshot());
};
const light = (v: View) => v.evaluate(`dotzTheme.get() !== "light" ? (dotzTheme.toggle(), 0) : 0`);

describe("notice state", () => {
	test("an answered decision's summary differs from the one that still waits (알림 screen)", async () => {
		const v = await hub.view({ width: 390, height: 900 });
		await v.navigate(`${hub.origin}/#notices`);
		await waitFor(v, `document.querySelector('#v-notices .nsc-r[data-nid="d-open"]') && document.querySelector('#v-notices .nsc-r[data-nid="d-answered"]') && !document.getAnimations().some(a => a.playState === "running" && a.effect.getTiming().iterations !== Infinity)`);
		await light(v);
		const sum = (id: string) => ev<string>(v, `document.querySelector('#v-notices .nsc-r[data-nid="${id}"] .nsc-s').textContent`);
		const [open, answered] = [await sum("d-open"), await sum("d-answered")];
		await shot(v, "flows-f5-notices-390-light");
		expect(answered).not.toBe(open);
	}, 30_000);

	test("the 홈 알림 card's count is the number of rows it lists", async () => {
		const v = await hub.view({ width: 390, height: 900 });
		await v.navigate(`${hub.origin}/`);
		await waitFor(v, `NT.loaded && document.querySelector('.bi[data-id="notices:alert"] .hc-row')`);
		await light(v);
		const card = await ev<{ rows: number; count: number }>(v, `(c => ({ rows: c.querySelectorAll(".hc-row").length, count: Number((c.querySelector(".ch .hc-n") || {}).textContent || 0) }))(document.querySelector('.bi[data-id="notices:alert"]'))`);
		await shot(v, "flows-f6-home-390-light");
		expect(card.rows).toBe(1);
		expect(card.count).toBe(card.rows);
	}, 30_000);
});
