import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ev, fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

// 설정의 메신저: four rows from the index, one screen per messenger (status + one action + onboarding + 알림 + read-only rooms),
// and manual fields only in the closed "직접 입력" disclosure. Headless Bun.WebView against a stub gateway.
const SHOTS = "/tmp/messenger-onboarding";
mkdirSync(SHOTS, { recursive: true });

const PROJECTS = [{ target: "ch:7", name: "결제" }, { target: "ch:8", name: "정산" }];
const baseItems = () => [
	{ id: "discord", label: "Discord", enabled: true, state: "ok", configured: true },
	{ id: "jandi", label: "JANDI", enabled: false, state: "off", configured: true },
	{ id: "slack", label: "Slack", enabled: false, state: "off", configured: false },
	{ id: "telegram", label: "Telegram", enabled: true, state: "error", configured: true, error: "토큰이 거절됐어요" },
];
const jandi = () => ({
	enabled: items.find(i => i.id === "jandi")!.enabled,
	help: ["JANDI 방마다 수신 웹훅을 만들고 URL을 붙여 넣어요"],
	fields: [{ key: "host", label: "받는 주소", type: "text", value: "0.0.0.0" }, { key: "port", label: "받는 포트", type: "number", value: 8765 },
		{ key: "incoming_url", label: "기본 수신 웹훅 URL", type: "secret", set: secretSet, hint: "방마다 따로 정하지 않은 방의 메시지가 모두 이 JANDI 방으로 가요" }],
	allow: { label: "말을 걸 수 있는 사람", hint: "이메일이나 JANDI 이름", items: allow },
	rooms: {
		label: "방", editable: true, hint: "JANDI는 웹훅을 API로 만들 수 없어요",
		fields: [{ key: "webhook", label: "발신 웹훅 URL", type: "copy" }],
		items: [
			{ id: "m1", name: "메인", kind: "main", values: { webhook: "http://192.168.0.5:8765/jandi/m1" }, set: { outgoing_token: true, incoming_url: true }, last_in: Date.now() - 120_000, last_out: Date.now() - 30_000 },
			{ id: "p1", name: "결제 프로젝트", kind: "project", project: { target: "ch:7", name: "결제" }, values: {}, set: {}, last_error: "HTTP 500" },
		],
	},
	projects: PROJECTS,
	notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
});
const slack = () => ({
	enabled: false,
	help: ["Slack 앱을 만들고 봇 토큰을 저장해요"],
	fields: [{ key: "token", label: "봇 토큰", type: "secret", set: false }],
	allow: { label: "말을 걸 수 있는 사람", hint: "Slack 사용자 ID", items: [] },
	rooms: { label: "채널", editable: true, hint: "연결하면 채널을 읽어요", fields: [], items: [] },
	projects: PROJECTS,
	notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
});
const telegram = () => ({
	enabled: true,
	help: ["BotFather에서 봇을 만들어요"],
	fields: [{ key: "token", label: "봇 토큰", type: "secret", set: true }],
	allow: { label: "말을 걸 수 있는 사람", hint: "Telegram 사용자 ID", items: [] },
	rooms: { label: "대화", editable: true, fields: [], items: [{ id: "c1", name: "나", kind: "main", values: {}, set: {} }] },
	projects: PROJECTS,
	notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
});
let items: any[];
let secretSet = false;
let allow: string[];
let onboard: string[] = [];
const puts = inbox<any>();
let ob: Record<string, any>;
const idle = key => ({ key, state: "idle", step: null, owner: null, error: null, url: null, updated_at: new Date(0).toISOString() });
const waiting = (key, label, hint) => ({ key, state: "waiting", step: { id: "owner", title: "로그인", detail: "브라우저에서 로그인해 주세요" }, owner: { label, hint }, error: null, url: null, updated_at: new Date(0).toISOString() });
const done = (key, url = null) => ({ key, state: "done", step: { id: "done", title: "완료", detail: "연결했어요" }, owner: null, error: null, url, updated_at: new Date(0).toISOString() });
function reset() {
	items = baseItems();
	secretSet = false;
	allow = ["boss@corp.test"];
	puts.length = 0;
	onboard = [];
	ob = Object.fromEntries(["discord", "jandi", "slack", "telegram"].map(k => [k, idle(k)]));
}
reset();
const settingsFor = (id: string) => id === "jandi" ? jandi() : id === "slack" ? slack() : telegram();

const hub = fakeHub({
	slowTimers: true,
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/messengers" && req.method === "GET") return json({ items });
		const m = p.match(/^\/api\/messengers\/([^/]+)$/);
		if (m && req.method === "GET") return json(settingsFor(decodeURIComponent(m[1])));
		if (m && req.method === "PUT") {
			const b = (await req.json()) as any;
			puts.push(b);
			const id = decodeURIComponent(m[1]), s = settingsFor(id);
			if (b.notify) s.notify = { ...s.notify, ...b.notify };
			if (b.enabled !== undefined) {
				s.enabled = b.enabled;
				const it = items.find(i => i.id === id)!;
				it.enabled = b.enabled;
				it.state = b.enabled ? "ok" : "off";
			}
			if (b.values) for (const [k, v] of Object.entries(b.values)) {
				const f = s.fields.find(x => x.key === k);
				if (f && f.type === "secret") { f.set = true; secretSet = true; } else if (f) f.value = v;
			}
			if (b.allow) allow = b.allow;
			return json(s);
		}
		const o = p.match(/^\/api\/onboarding\/([^/]+)(?:\/(start|continue|cancel))?$/);
		if (o) {
			const key = o[1]!, action = o[2];
			if (!action) return json(ob[key]);
			onboard.push(`${key}/${action}`);
			if (action === "start") ob[key] = waiting(key, key === "discord" ? "Discord 열기" : "관리자로 로그인", key === "telegram" ? "Telegram에서 시작을 눌러 주세요." : "브라우저에서 남은 한 가지를 마쳐 주세요.");
			else if (action === "continue") ob[key] = done(key, key === "telegram" ? "https://t.me/example" : null);
			else ob[key] = idle(key);
			return json(ob[key]);
		}
		if (p === "/api/update") {
			const at = { sha: "a".repeat(40), short: "a".repeat(7), date: new Date(0).toISOString() };
			return json({ running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
		}
		if (p === "/api/web-access") return json({ mode: "tailscale", hostname: "", team: "", aud: "", token_set: false, tunnel: { state: "off" }, devices: 0, cloudflared_found: true });
		if (p === "/api/devices") return json([]);
		if (p === "/api/accounts") return json({ error: "no accounts here" }, 404);
	},
});
afterAll(() => hub.stop());

const open = async (width: number, height: number, theme: "light" | "dark" = "light", view = "settings"): Promise<View> => {
	const v = await hub.view({ width, height }, "/");
	await waitFor(v, `typeof go === "function" && typeof S !== "undefined" && S`);
	await run(v, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; go(${JSON.stringify(view)})`);
	if (view === "settings") await waitFor(v, `document.querySelectorAll("#settings [data-ms-row]").length === 4 && document.querySelector('#settings [data-ms-row="telegram"] .tag')`);
	else await waitFor(v, `document.querySelector("#${view} [data-ms-connect]") && document.querySelector("#${view} [data-ms-status]")`);
	return v;
};
const click = (v: View, sel: string) => run(v, `document.querySelector(${JSON.stringify(sel)}).click()`);
const type = (v: View, sel: string, text: string) => run(v, `const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true }))`);
const noOverflow = (v: View, sel: string) => ev<boolean>(v, `document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll(${JSON.stringify(sel)})].every(l => l.scrollWidth <= l.clientWidth)`);

describe("메신저 설정", () => {
	beforeEach(reset);

	test("settings has exactly one Discord/JANDI/Slack/Telegram row, no 메신저, and each opens its view", async () => {
		const v = await open(1280, 800);
		const rows = await ev<{ id: string; name: string; tag: string }[]>(v, `[...document.querySelectorAll("#settings [data-ms-row]")].map(r => ({ id: r.dataset.msRow, name: r.querySelector(".hd").textContent, tag: r.querySelector(".tag")?.textContent }))`);
		expect(rows).toEqual([
			{ id: "discord", name: "Discord", tag: "연결됨" },
			{ id: "jandi", name: "JANDI", tag: "연결됨" },
			{ id: "slack", name: "Slack", tag: "설정 안 됨" },
			{ id: "telegram", name: "Telegram", tag: "연결 안 됨" },
		]);
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#settings .li.tap .hd")].map(h => h.textContent)`)).not.toContain("메신저");
		expect(await ev<number>(v, `[...document.querySelectorAll("#settings .li.tap .hd")].filter(h => ["Discord","JANDI","Slack","Telegram"].includes(h.textContent)).length`)).toBe(4);
		for (const id of ["discord", "jandi", "slack", "telegram"]) {
			await run(v, `go("settings")`);
			await waitFor(v, `document.querySelector("#settings [data-ms-row=\\"${id}\\"] .tag")`);
			await click(v, `#settings [data-ms-row="${id}"]`);
			await waitFor(v, `current === "${id}"`);
		}
		await run(v, `go("messengers")`);
		await waitFor(v, `current === "settings"`);
	}, 30_000);

	test("every screen has one action, a closed 직접 입력, and no input outside it", async () => {
		const v = await open(1280, 800);
		const want = { discord: "연결", jandi: "켜기", slack: "연결", telegram: "연결" } as const;
		for (const [id, text] of Object.entries(want)) {
			await run(v, `go("${id}")`);
			await waitFor(v, `document.querySelector("#${id} [data-ms-connect]") && document.querySelector("#${id} [data-ms-status]")`);
			expect(await ev<number>(v, `document.querySelectorAll("#${id} [data-ms-connect]").length`)).toBe(1);
			expect(await ev<string>(v, `document.querySelector("#${id} [data-ms-connect]").textContent`)).toBe(text);
			expect(await ev<boolean>(v, `document.querySelector("#${id} details[data-ms-advanced]").open`)).toBe(false);
			expect(await ev<string>(v, `document.querySelector("#${id} details[data-ms-advanced] summary").textContent`)).toContain("직접 입력");
			expect(await ev<number>(v, `document.querySelectorAll("#${id} input").length`)).toBe(0);
			await click(v, `#${id} details[data-ms-advanced] summary`);
			await waitFor(v, `document.querySelectorAll("#${id} details[data-ms-advanced] input").length > 0`);
			expect(await ev<boolean>(v, `[...document.querySelectorAll("#${id} input")].every(i => i.closest("details[data-ms-advanced]"))`)).toBe(true);
			expect(await ev<boolean>(v, `!!document.querySelector("#${id} details[data-ms-advanced] [data-ms-save]")`)).toBe(true);
		}
	}, 30_000);

	test("알림: a flip sends only that class", async () => {
		const v = await open(1280, 800, "light", "jandi");
		await waitFor(v, `document.querySelectorAll("#jandi [data-notify]").length === 6`);
		puts.length = 0;
		await click(v, '#jandi [data-notify="news"] .hs-sw');
		await waitFor(v, `document.querySelector('#jandi [data-notify="news"] .hs-sw').getAttribute("aria-checked") === "false"`);
		await puts.until(x => x.length === 1);
		expect(puts).toEqual([{ notify: { news: false } }]);
	}, 30_000);

	test("켜기 sends enabled=true and reloads the row", async () => {
		const v = await open(1280, 800, "light", "jandi");
		puts.length = 0;
		await click(v, "#jandi [data-ms-connect]");
		await waitFor(v, `document.querySelector("#jandi [data-ms-connect]").textContent === "연결"`);
		expect(puts).toEqual([{ enabled: true }]);
	}, 30_000);

	test("연결 starts onboarding; waiting shows one owner line and continue posts /continue", async () => {
		const v = await open(1280, 800, "light", "telegram");
		onboard = [];
		await click(v, "#telegram [data-ms-connect]");
		await waitFor(v, `document.querySelector('#telegram [data-onb-state="waiting"]')`);
		expect(onboard).toEqual(["telegram/start"]);
		expect(await ev<number>(v, `document.querySelectorAll("#telegram [data-onb-owner]").length`)).toBe(1);
		expect(await ev<string>(v, `document.querySelector("#telegram [data-onb-owner]").textContent`)).toContain("Telegram에서 시작을 눌러 주세요.");
		expect(await ev<number>(v, `document.querySelectorAll("#telegram [data-onb-continue]").length`)).toBe(1);
		expect(await ev<number>(v, `document.querySelectorAll("#telegram [data-onb-cancel]").length`)).toBe(1);
		await click(v, "#telegram [data-onb-continue]");
		await waitFor(v, `document.querySelector('#telegram [data-onb-state="done"]')`);
		expect(onboard.filter(x => x === "telegram/continue").length).toBe(1);
		expect(await ev<string>(v, `document.querySelector("#telegram [data-onb-url]").textContent`)).toBe("https://t.me/example");
	}, 30_000);

	test("JANDI rooms stay read-only and 저장 sends only what changed", async () => {
		const v = await open(1280, 800, "light", "jandi");
		await waitFor(v, `document.querySelectorAll("#jandi [data-room]").length === 2`);
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#jandi [data-room] .hd")].map(h => h.textContent)`)).toEqual(["메인", "결제 프로젝트"]);
		expect(await ev<string>(v, `document.querySelector('#jandi [data-room="p1"] .dcs-err').textContent`)).toBe("HTTP 500");
		expect(await ev<boolean>(v, `document.querySelector("[data-ms-test]") && document.querySelector("[data-ms-add]") === null`)).toBe(true);
		await click(v, "#jandi details[data-ms-advanced] summary");
		await waitFor(v, `document.querySelector('#jandi input[name="ms-port"]')`);
		puts.length = 0;
		await type(v, '#jandi input[name="ms-port"]', "9000");
		await click(v, "#jandi [data-ms-save]");
		await puts.until(x => x.length === 1);
		expect(puts).toEqual([{ values: { port: 9000 } }]);
		await waitFor(v, `document.querySelector('#jandi input[name="ms-port"]').value === "9000"`);
		puts.length = 0;
		await type(v, '#jandi input[name="ms-incoming_url"]', "http://in/SECRET");
		await click(v, "#jandi [data-ms-save]");
		await puts.until(x => x.length === 1);
		expect(puts).toEqual([{ values: { incoming_url: "http://in/SECRET" } }]);
		await waitFor(v, `document.querySelector('#jandi input[name="ms-incoming_url"]').value === "" && document.querySelectorAll('#jandi [data-set=incoming_url]').length === 1`);
		expect(await ev<boolean>(v, `document.documentElement.outerHTML.includes("http://in/SECRET")`)).toBe(false);
		expect(await ev<number>(v, `document.querySelectorAll("#jandi [data-set=incoming_url]").length`)).toBe(1);
	}, 30_000);

	test("screenshots: settings 1280 light, 390 dark, and each messenger screen", async () => {
		const desk = await open(1280, 800, "light");
		await Bun.write(`${SHOTS}/after-1280.png`, await desk.screenshot());
		expect(await noOverflow(desk, "#settings .list")).toBe(true);
		const phone = await open(390, 844, "dark");
		await run(phone, `document.querySelector("#settings [data-ms-row=telegram]").scrollIntoView({ block: "center" })`);
		await Bun.write(`${SHOTS}/after-390.png`, await phone.screenshot());
		expect(await noOverflow(phone, "#settings .list")).toBe(true);
		for (const id of ["discord", "jandi", "slack", "telegram"]) {
			const v = await open(1280, 800, "light", id);
			await waitFor(v, `document.querySelector("#${id} [data-onb]")`);
			await Bun.write(`${SHOTS}/messenger-${id}.png`, await v.screenshot());
			expect(await noOverflow(v, `#${id} .list`)).toBe(true);
		}
		for (const f of ["after-1280.png", "after-390.png", "messenger-discord.png", "messenger-jandi.png", "messenger-slack.png", "messenger-telegram.png"]) expect(await Bun.file(`${SHOTS}/${f}`).exists()).toBe(true);
	}, 60_000);
});
