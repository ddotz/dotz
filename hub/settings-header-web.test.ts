import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { viewOf } from "./app-settings.ts";
import { WATCH_FIELDS } from "./watch-settings.ts";
import { fakeHub, json, waitFor, run, type View } from "./test-web.ts";

// Every monitoring detail has its 설정 entry as a 대화 button and a ⋯ button in the title bar (web/js/32-app-settings.js asEntry): the head on a wide screen,
// the app bar on a phone. There is no 설정 row on top of the list any more. Headless Bun.WebView against a stub gateway; the peer is a fixture.
const SHOTS = process.env.SETTINGS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 3, min)).toISOString();
const watch = (name: string, label: string, extra: object = {}) => ({ name: label, watch: name, kind: "watch", last_run: at(30), last_result: "ok", next_run: at(60), every: "30분마다", fails: 0, last_ok: at(30), ...extra });
const MAIL = { subject: "월간 점검 보고서", from: "Alex Sender <sender@example.com>", source: "fx", at: at(10), summary: "요약\n내용이 있어요.", n: 1 };
const ROOMS = [{ chatId: "100", name: "가나다 모임", kind: "group", watched: true, autoDraft: false, unread: 0, lastAt: Date.UTC(2026, 9, 23, 3, 20) }];
const fields = () => WATCH_FIELDS.map(f => viewOf(f, f.key === "enabled" ? true : f.key === "every_minutes" ? 30 : f.key === "to" ? "alert" : "이름"));
const peers = [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [watch("login-cartier-com", "까르띠에 로그인 유지", { last_result: "fail", fails: 3, keeper: true })], notices: [], integrations: [], conversations: [] } }];

const hub = fakeHub({
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/peers") return json([{ name: "맥북", url: `${hub.origin}`, self: true, online: true }, ...peers.map(x => ({ name: x.name, url: x.url, self: false, online: x.online }))]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitors") return json({ items: [watch("plain-watch", "일반 감시"), watch("login-local", "로컬 로그인 유지", { keeper: true })] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") {
			const need = { drafts: 0, unread: 0, sentToday: 0 };
			return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], needs: need }, { key: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: [], notices: [], needs: need }, { key: "site", label: "사이트", icon: "activity", kind: "app", conv: [], notices: [], needs: need }] });
		}
		if (p === "/api/conversations") return json({ items: [{ target: "mail:fx-1", unread: 0, last: { ts: at(10), text: "월간 점검 보고서", from: "bot" }, mail: MAIL }] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: ROOMS });
		if (p === "/api/kakao/chat/100") return json({ room: { chatId: "100", name: "가나다 모임", kind: "group", group: true }, messages: [], read: "0", kakaoUnread: 0, drafts: [], sends: [] });
		if (p === "/api/monitoring/peers") return json(peers);
		if (p === "/api/peer/proxy") return json(url.searchParams.get("p") === "/api/watches/login-cartier-com/settings" ? { key: "login-cartier-com", fields: fields() } : {});
		if (/^\/api\/(?:integrations|watches)\/[a-z0-9-]+\/settings$/.test(p)) return json({ key: "x", fields: fields() });
	},
});

afterAll(() => hub.stop());
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const boot = async (width: number, height: number) => {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && PQ.list.length && INTG.items.length && KK`);
	return v;
};

// One entry per kind of detail: how it is opened, which settings conversation its button leads to, and where its title bar is on a wide screen.
const PEER_KEY = `p:${MINI}|m:까르띠에 로그인 유지`;
const KINDS: { name: string; open: string; ready?: string; app: string; head: string }[] = [
	{ name: "mail app", open: `go("monitoring", "i:mail")`, app: "mail", head: "#mon-head" },
	{ name: "mail", open: `go("monitoring", "c:mail:fx-1")`, ready: `target === "mail:fx-1"`, app: "mail", head: "#cv-head" },
	{ name: "kakao app", open: `go("monitoring", "i:kakao")`, app: "kakao", head: "#mon-head" },
	{ name: "kakao room", open: `go("monitoring", "i:kakao"); setTimeout(() => kkOpen("100"), 50)`, ready: `KK.open === "100" && !KK.loading`, app: "kakao", head: "#kk-head" },
	{ name: "other app", open: `go("monitoring", "i:site")`, app: "site", head: "#mon-head" },
	{ name: "general monitor", open: `go("monitoring", "m:일반 감시")`, app: "w:plain-watch", head: "#mon-head" },
	{ name: "login keeper", open: `go("monitoring", "m:로컬 로그인 유지")`, app: "w:login-local", head: "#mon-head" },
	{ name: "peer monitor", open: `go("monitoring", ${JSON.stringify(PEER_KEY)})`, app: "w:login-cartier-com", head: "#mon-head" },
];

describe("the 대화 and ⋯ buttons of a monitoring detail sit side by side in its title bar", () => {
	for (const [label, w, h] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
		for (const k of KINDS) {
			test(`${label}: ${k.name}`, async () => {
				const v = await boot(w, h);
				await waitFor(v, `monItems().some(i => i.key === "m:일반 감시") && monItems().some(i => i.key === ${JSON.stringify(PEER_KEY)})`);
				await run(v, k.open);
				if (k.ready) await waitFor(v, k.ready);
				// A phone has no head: the buttons are in the app bar; a wide screen has them in the detail's head and none in the bar.
				const btn = w < 1100 ? "#as-bar" : `${k.head} .as-hd[data-as-open]`;
				const moreBtn = w < 1100 ? "#as-more-bar" : `${k.head} .as-hd[data-as-more]`;
				await waitFor(v, `(() => { const b = document.querySelector(${JSON.stringify(btn)}); return b && !b.hidden && b.dataset.asOpen === ${JSON.stringify(k.app)}; })()`);
				const s = await q<{ label: string | null; pins: number; visible: number; bar: boolean }>(v, `const b = document.querySelector(${JSON.stringify(btn)}), r = b.getBoundingClientRect(); return { label: b.getAttribute("aria-label"), pins: document.querySelectorAll(".as-pin").length, visible: Math.round(r.width) * Math.round(r.height), bar: document.querySelector("#as-bar").hidden }`);
				expect(s.label).toBe("대화");
				expect(s.pins).toBe(0);
				// ⋯ sits right beside it and opens the settings screen without the conversation.
				const m = await q<{ label: string | null; app: string | null; gap: number; icons: number; visible: number }>(v, `const b = document.querySelector(${JSON.stringify(btn)}), m = document.querySelector(${JSON.stringify(moreBtn)}), a = b.getBoundingClientRect(), c = m.getBoundingClientRect(); return { label: m.getAttribute("aria-label"), app: m.dataset.asMore, gap: Math.round(c.left - a.right), icons: document.querySelectorAll("[data-as-open] svg path[d^='M4 7h9']").length, visible: Math.round(c.width) * Math.round(c.height) }`);
				expect(m.label).toBe("설정");
				expect(m.app).toBe(k.app);
				expect(m.visible).toBeGreaterThan(0);
				expect(m.gap).toBeGreaterThanOrEqual(0);
				expect(m.gap).toBeLessThan(16);
				expect(m.icons).toBe(0);   // the sliders icon is gone
				expect(s.visible).toBeGreaterThan(0);
				if (w >= 1100) expect(s.bar).toBe(true);
				if (["mail", "kakao room", "general monitor"].includes(k.name)) await shot(v, `settings-header-${k.name.replace(" ", "-")}-${w}.png`);
				await run(v, `document.querySelector(${JSON.stringify(moreBtn)}).click()`);
				await waitFor(v, `document.querySelector(".as-screen #app-sw .as-row")`);
				await run(v, `ASC.h.close()`);
				await waitFor(v, `!ASC.h`);
				await run(v, `document.querySelector(${JSON.stringify(btn)}).click()`);
				await waitFor(v, `target === "settings:${k.app}"`);
				// The conversation is chat only; its ⋯ button opens the screen that holds the options.
				const more = `[...document.querySelectorAll("[data-as-more]")].find(b => b.offsetParent && !b.hidden)`;
				await waitFor(v, more);
				expect(await q(v, `return document.querySelector("#app-sw")`)).toBe(null);
				await run(v, `${more}.click()`);
				await waitFor(v, `document.querySelector(".as-screen #app-sw .as-row")`);
			});
		}
	}
});
