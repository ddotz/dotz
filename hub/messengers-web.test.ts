import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// 설정 → 메신저: the list with state dots, the JANDI detail (rooms mirrored read-only, no 방 추가) and the save calls, against a stub gateway (headless Bun.WebView).
// The stub never returns a secret, only set flags. Screenshots go to SHOTS.
const SHOTS = process.env.MESSENGER_SHOTS ?? "/tmp/dotz-messenger-shots";
mkdirSync(SHOTS, { recursive: true });

type Room = { id: string; name: string; kind: string; project?: string; secrets: Record<string, string> };
let enabled = true;
let fallbackSet = false;
let notify: Record<string, boolean> = { ask: true, alert: true, result: true, news: true, conv: true, log: true };
let rooms: Room[] = [
	{ id: "m1", name: "메인", kind: "main", secrets: { outgoing_token: "tok-1", incoming_url: "http://in/1" } },
	{ id: "p1", name: "결제 프로젝트", kind: "project", project: "ch:7", secrets: { outgoing_token: "tok-2" } },
];
const puts: any[] = [];
let hold: Promise<void> | undefined;   // set: the JANDI detail answers only when it settles (a slow detail)
const PROJECTS = [{ target: "ch:7", name: "결제" }, { target: "ch:8", name: "정산" }];
const jandi = () => ({
	enabled,
	help: ["JANDI 방마다 수신 웹훅을 만들고 URL을 붙여 넣어요", "발신 웹훅의 토큰을 맞춰 넣어요"],
	fields: [{ key: "host", label: "받는 주소", type: "text", value: "0.0.0.0", hint: "바꾸면 연결이 다시 시작돼요" }, { key: "port", label: "받는 포트", type: "number", value: 8765 }, { key: "incoming_url", label: "기본 수신 웹훅 URL", type: "secret", set: fallbackSet, hint: "방마다 따로 정하지 않은 방의 메시지가 모두 이 JANDI 방으로 가요" }],
	allow: { label: "말을 걸 수 있는 사람", hint: "이메일이나 JANDI 이름", items: ["boss@corp.test"] },
	rooms: {
		label: "방",
		editable: true,
		hint: fallbackSet ? undefined : "남은 일: JANDI는 웹훅을 API로 만들 수 없어서, 수신 웹훅 URL 하나를 '기본 수신 웹훅 URL'에 한 번 붙여 넣어요",
		fields: [{ key: "webhook", label: "발신 웹훅 URL", type: "copy" }, { key: "outgoing_token", label: "발신 토큰", type: "secret" }, { key: "incoming_url", label: "수신 웹훅 URL", type: "secret" }],
		items: rooms.map(r => ({
			id: r.id, name: r.name, kind: r.kind,
			...(r.project ? { project: { target: r.project, name: PROJECTS.find(p => p.target === r.project)?.name ?? r.project } } : {}),
			values: { webhook: `http://192.168.0.5:8765/jandi/${r.id}` },
			set: { outgoing_token: !!r.secrets.outgoing_token, incoming_url: !!r.secrets.incoming_url },
			...(r.id === "m1" ? { last_in: Date.now() - 120_000, last_out: Date.now() - 30_000 } : {}),
			...(r.id === "p1" ? { last_error: "HTTP 500" } : {}),
		})),
	},
	projects: PROJECTS,
	notify,
});
const DISCORD = { enabled: false, help: ["Discord 연결은 설정 → Discord에서 바꿔요."], fields: [{ key: "state", label: "상태", type: "readonly", value: "연결 중" }], projects: [], link: { label: "Discord 설정 열기", view: "discord" } };

const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/messengers") return json({ items: [{ id: "jandi", label: "JANDI", enabled, state: "ok" }, { id: "discord", label: "Discord", enabled: false, state: "connecting" }] });
		if (p === "/api/messengers/discord") return json(DISCORD);
		if (p === "/api/update") {
			const at = { sha: "a".repeat(40), short: "a".repeat(7), date: new Date(0).toISOString() };
			return json({ running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
		}
		if (p === "/api/messengers/jandi" && req.method === "GET") { await hold; return json(jandi()); }
		if (p === "/api/messengers/jandi" && req.method === "PUT") {
			const b = (await req.json()) as any;
			puts.push(b);
			if (b.enabled !== undefined) enabled = b.enabled;
			if (b.values?.incoming_url) fallbackSet = true;
			if (b.notify) notify = { ...notify, ...b.notify };
			return json(jandi());
		}
	},
});
afterAll(() => hub.stop());

const open = async (width: number, height: number, theme: "light" | "dark" = "light"): Promise<View> => {
	const v = await hub.view({ width, height }, "/");
	await waitFor(v, `typeof go === "function" && typeof S !== "undefined" && S`);
	await run(v, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; go("messengers")`);
	await waitFor(v, `document.querySelectorAll("#messengers [data-ms]").length === 2 && document.querySelector('#messengers [data-ms="discord"] .sup')`);
	return v;
};
const click = (v: View, sel: string) => run(v, `document.querySelector(${JSON.stringify(sel)}).click()`);
const type = (v: View, sel: string, text: string) => run(v, `const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true }))`);

describe("메신저 설정 화면", () => {
	test("the list shows each connection with its state and room count", async () => {
		const v = await open(1280, 800);
		const rows = await ev<{ id: string; name: string; tag: string; sup: string; dot: string }[]>(v, `[...document.querySelectorAll("#messengers [data-ms]")].map(r => ({ id: r.dataset.ms, name: r.querySelector(".hd").textContent, tag: r.querySelector(".tag").textContent, sup: r.querySelector(".sup").textContent, dot: r.querySelector(".dot").className }))`);
		expect(rows).toEqual([
			{ id: "jandi", name: "JANDI", tag: "연결됨", sup: "방 2개", dot: "dot ok" },
			{ id: "discord", name: "Discord", tag: "연결 중", sup: "", dot: "dot warn" },
		]);
	});

	test("the list shows while a detail is still loading", async () => {
		let release = () => {};
		hold = new Promise(r => { release = r; });
		try {
			const v = await hub.view({ width: 1280, height: 800 }, "/");
			await waitFor(v, `typeof go === "function" && typeof S !== "undefined" && S`);
			await run(v, `go("messengers")`);
			await waitFor(v, `document.querySelectorAll("#messengers [data-ms]").length === 2`);
			expect(await ev<string>(v, `document.querySelector('#messengers [data-ms="jandi"] .sup').textContent`)).toBe("");
			release();
			await waitFor(v, `document.querySelector('#messengers [data-ms="jandi"] .sup').textContent === "방 2개"`);
		} finally {
			release();
			hold = undefined;
		}
	});

	test("the settings list links to it", async () => {
		const v = await hub.view({ width: 1280, height: 800 }, "/");
		await waitFor(v, `typeof go === "function" && S`);
		await run(v, `go("settings")`);
		await waitFor(v, `(() => { const r = [...document.querySelectorAll("#settings .li")].find(x => x.querySelector(".hd")?.textContent === "메신저"); if (r) r.click(); return !!r; })()`);
		await waitFor(v, `current === "messengers"`);
	});

	test("JANDI opens to its fields, allowlist and the rooms it mirrors; secrets show only 저장됨", async () => {
		const v = await open(1280, 800);
		await click(v, '#messengers [data-ms="jandi"]');
		await waitFor(v, `document.querySelectorAll("dialog [data-room]").length === 2`);
		const d = await ev<{ inputs: string[]; allow: string[]; rooms: string[]; mirrors: string[]; html: string }>(v, `({ inputs: [...document.querySelectorAll("dialog input.fi")].map(i => i.name + "=" + i.value).filter(s => s.startsWith("ms-host") || s.startsWith("ms-port")), allow: [...document.querySelectorAll("dialog [data-allow]")].map(x => x.dataset.allow), rooms: [...document.querySelectorAll("dialog [data-room] .hd")].map(h => h.textContent), mirrors: [...document.querySelectorAll("dialog [data-room] .sup")].map(h => h.textContent.replace(/ · (받음|보냄) .*$/, "")), html: document.querySelector("dialog").innerHTML })`);
		expect(d.inputs).toEqual(["ms-host=0.0.0.0", "ms-port=8765"]);
		expect(d.allow).toEqual(["boss@corp.test"]);
		expect(d.rooms).toEqual(["메인", "결제 프로젝트"]);
		expect(d.mirrors).toEqual(["→ 메인 대화", "→ 프로젝트 · 결제"]);
		expect(await ev(v, `document.querySelector('dialog [data-room="p1"] .dcs-err').textContent`)).toBe("HTTP 500");
		expect(d.html).not.toContain("tok-");
	});

	test("there is no 방 추가 and a room cannot be opened or edited", async () => {
		const v = await open(390, 844);
		expect(await ev(v, `document.querySelector("[data-ms-add]")`)).toBeNull();
		await click(v, '#messengers [data-ms="jandi"]');
		await waitFor(v, `document.querySelectorAll("dialog [data-room]").length === 2`);
		expect(await ev(v, `[document.querySelector("dialog [data-ms-add]"), document.querySelector("dialog button[data-room]"), document.querySelector('dialog input[name="ms-room-name"]')]`)).toEqual([null, null, null]);
		expect(await ev(v, `document.querySelector("dialog").textContent.includes("방 추가")`)).toBe(false);
	});

	test("what is left to do shows as one line, and the default webhook is the only thing to paste", async () => {
		fallbackSet = false;
		const v = await open(1280, 800);
		await click(v, '#messengers [data-ms="jandi"]');
		await waitFor(v, `document.querySelector("dialog [data-ms-hint]")`);
		expect(await ev(v, `document.querySelectorAll("dialog [data-ms-hint]").length`)).toBe(1);
		expect(await ev(v, `document.querySelector("dialog [data-ms-hint]").textContent`)).toContain("남은 일");
		expect(await ev(v, `document.querySelector('dialog [data-set="incoming_url"]')`)).toBeNull();
		await type(v, 'dialog input[name="ms-incoming_url"]', "http://in/default");
		await waitFor(v, `!document.querySelector("dialog [data-ms-save]").disabled`);
		puts.length = 0;
		await click(v, "dialog [data-ms-save]");
		await waitFor(v, `MD && document.querySelector('dialog [data-set="incoming_url"]') && !document.querySelector("dialog [data-ms-hint]")`);
		expect(puts).toEqual([{ values: { incoming_url: "http://in/default" } }]);
		expect(await ev(v, `document.querySelector('dialog [data-set="incoming_url"]').textContent`)).toBe("저장됨");
		expect(await ev(v, `document.querySelector('dialog input[name="ms-incoming_url"]').value`)).toBe("");
		fallbackSet = false;
	});

	test("저장 sends only what changed", async () => {
		const v = await open(1280, 800);
		await click(v, '#messengers [data-ms="jandi"]');
		await waitFor(v, `document.querySelector("dialog [data-ms-save]")`);
		expect(await ev(v, `document.querySelector("dialog [data-ms-save]").disabled`)).toBe(true);
		await click(v, "dialog [data-ms-enabled]");
		await type(v, 'dialog input[name="ms-port"]', "9000");
		await waitFor(v, `!document.querySelector("dialog [data-ms-save]").disabled`);
		puts.length = 0;
		await click(v, "dialog [data-ms-save]");
		await waitFor(v, `MD && MD.s.enabled === false && document.querySelector("dialog [data-ms-save]").disabled`);
		expect(puts).toEqual([{ enabled: false, values: { port: 9000 } }]);
		enabled = true;
	});

	test("알림: one switch per class in the sheet; a flip saves at once with only that class", async () => {
		const v = await open(1280, 800);
		await click(v, '#messengers [data-ms="jandi"]');
		await waitFor(v, `document.querySelectorAll("dialog [data-notify]").length === 6`);
		expect(await ev(v, `[...document.querySelectorAll("dialog [data-notify] .hd")].map(h => h.textContent)`)).toEqual(["답변 필요", "경고", "결과", "새 소식", "대화", "진행"]);
		puts.length = 0;
		await click(v, 'dialog [data-notify="news"] .hs-sw');
		await waitFor(v, `document.querySelector('dialog [data-notify="news"] .hs-sw').getAttribute("aria-checked") === "false"`);
		expect(puts).toEqual([{ notify: { news: false } }]);
		expect(await ev(v, `document.querySelector("dialog [data-ms-save]").disabled`)).toBe(true);
		notify = { ...notify, news: true };
	});

	test("Discord is read-only here and links to its own screen", async () => {
		const v = await open(1280, 800);
		await click(v, '#messengers [data-ms="discord"]');
		await waitFor(v, `document.querySelector('dialog [data-ms-link="discord"]')`);
		expect(await ev(v, `[document.querySelector("dialog [data-ms-save]"), document.querySelector("dialog [data-ms-enabled]")]`)).toEqual([null, null]);
		await click(v, 'dialog [data-ms-link="discord"]');
		await waitFor(v, `current === "discord"`);
	});

	test("screenshots: list and detail, desktop and phone, light and dark", async () => {
		for (const [name, w, h] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
			for (const theme of ["light", "dark"] as const) {
				const v = await open(w, h, theme);
				await Bun.write(`${SHOTS}/list-${name}-${theme}.png`, await v.screenshot());
				await click(v, '#messengers [data-ms="jandi"]');
				await waitFor(v, `document.querySelectorAll("dialog [data-room]").length === 2`);
				await Bun.write(`${SHOTS}/detail-${name}-${theme}.png`, await v.screenshot());
			}
		}
		for (const n of ["list", "detail"]) for (const d of ["desktop", "phone"]) for (const t of ["light", "dark"]) expect(await Bun.file(`${SHOTS}/${n}-${d}-${t}.png`).exists()).toBe(true);
	}, 60_000);
});
