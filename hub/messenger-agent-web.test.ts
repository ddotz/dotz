import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { USER_TOKEN_NOTE } from "./messenger-agent.ts";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// 설정 → 메신저 for the Slack / Telegram adapter: the chat sheet draws its select, text and secret fields and sends them back (headless Bun.WebView, stub gateway).
const SHOTS = process.env.MESSENGER_SHOTS ?? "/tmp/dotz-messenger-shots";
mkdirSync(SHOTS, { recursive: true });

const OPTIONS = [{ value: "slack-bot", label: "Slack 봇" }, { value: "slack-user", label: "Slack 사용자 계정" }, { value: "telegram-bot", label: "Telegram 봇" }];
const rooms = [
	{ id: "work:CMAIN", name: "메인", kind: "main", connection: "slack-bot", chat: "C01MAIN", set: { bot_token: true, user_token: false, cookie: false }, last_in: Date.now() - 120_000, last_out: Date.now() - 30_000 },
	{ id: "me:CALERT", name: "개인 알림", kind: "alert", connection: "slack-user", chat: "C02ALRT", set: { bot_token: false, user_token: true, cookie: true }, last_error: "not_in_channel" },
];
const puts: any[] = [];
const agent = () => ({
	enabled: true,
	help: ["Slack은 앱을 만들어 봇 토큰(xoxb-)을 받고, 쓸 채널마다 봇을 초대해요", "채팅 추가에서 연결 종류와 토큰, 채널 ID를 넣어요"],
	fields: [],
	allow: { label: "말을 걸 수 있는 사람", hint: "Slack 멤버 ID(U…)나 Telegram 숫자 ID", items: ["U01OWNER"] },
	rooms: {
		label: "채팅",
		editable: true,
		fields: [
			{ key: "connection", label: "연결 종류", type: "select", options: OPTIONS },
			{ key: "chat", label: "채널 ID", type: "text", hint: "Slack 채널 ID(C…) 또는 Telegram 채팅 ID" },
			{ key: "bot_token", label: "봇 토큰", type: "secret", hint: "Slack 봇(xoxb-)과 Telegram 봇의 토큰이에요" },
			{ key: "user_token", label: "사용자 토큰", type: "secret", as_user: true, hint: USER_TOKEN_NOTE },
			{ key: "cookie", label: "사용자 쿠키", type: "secret", hint: "Slack 사용자 계정(xoxd-)일 때만 필요해요" },
		],
		items: rooms.map(({ connection, chat, ...r }) => ({ ...r, values: { connection, chat } })),
	},
	projects: [{ target: "ch:7", name: "결제" }],
});

const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/messengers") return json({ items: [{ id: "agent", label: "Slack / Telegram (agent-messenger)", enabled: true, state: "ok" }] });
		if (p === "/api/update") {
			const at = { sha: "a".repeat(40), short: "a".repeat(7), date: new Date(0).toISOString() };
			return json({ running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
		}
		if (p === "/api/messengers/agent" && req.method === "GET") return json(agent());
		if (p === "/api/messengers/agent" && req.method === "PUT") {
			puts.push(await req.json());
			return json(agent());
		}
	},
});
afterAll(() => hub.stop());

const open = async (width: number, height: number, theme: "light" | "dark" = "light"): Promise<View> => {
	const v = await hub.view({ width, height }, "/");
	await waitFor(v, `typeof go === "function" && typeof S !== "undefined" && S`);
	await run(v, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; go("messengers")`);
	await waitFor(v, `document.querySelector('#messengers [data-ms="agent"]')`);
	return v;
};
const click = (v: View, sel: string) => run(v, `document.querySelector(${JSON.stringify(sel)}).click()`);
const type = (v: View, sel: string, text: string) => run(v, `const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true }))`);

describe("Slack / Telegram 설정", () => {
	test("the detail lists the chats; the user-token chat sheet shows the saved flags and the account warning", async () => {
		const v = await open(1280, 800);
		await click(v, '#messengers [data-ms="agent"]');
		await waitFor(v, `document.querySelectorAll("dialog [data-room]").length === 2`);
		expect(await ev(v, `[...document.querySelectorAll("dialog [data-room] .hd")].map(h => h.textContent)`)).toEqual(["메인", "개인 알림"]);
		await click(v, 'dialog [data-room="me:CALERT"]');
		await waitFor(v, `document.querySelector('dialog.cl input[name="ms-chat"]')`);
		const sheet = await ev<{ chat: string; saved: string[]; asUser: string[]; pass: number }>(v, `({ chat: document.querySelector('dialog.cl input[name="ms-chat"]').value, saved: [...document.querySelectorAll("dialog.cl [data-set]")].map(s => s.dataset.set), asUser: [...document.querySelectorAll("dialog.cl [data-as-user]")].map(s => s.dataset.asUser), pass: document.querySelectorAll('dialog.cl input[type="password"]').length })`);
		expect(sheet).toEqual({ chat: "C02ALRT", saved: ["user_token", "cookie"], asUser: ["user_token"], pass: 3 });
	});

	test("adding a chat sends the connection type, the channel id and the typed token; the old chats send neither", async () => {
		const v = await open(390, 844);
		await click(v, '#messengers [data-ms="agent"]');
		await waitFor(v, `document.querySelector("dialog [data-ms-add]")`);
		await click(v, "dialog [data-ms-add]");
		await waitFor(v, `document.querySelector('dialog.cl input[name="ms-chat"]')`);
		await type(v, 'dialog.cl input[name="ms-room-name"]', "새 채널");
		await type(v, 'dialog.cl input[name="ms-chat"]', "C09NEW");
		await type(v, 'dialog.cl input[name="ms-bot_token"]', "xoxb-typed");
		puts.length = 0;
		await run(v, `[...document.querySelectorAll("dialog.cl .dact .btn")].find(b => b.textContent === "추가").click()`);
		await waitFor(v, `document.querySelector("dialog [data-ms-add]") && !document.querySelector("dialog.cl")`);
		expect(puts).toEqual([
			{ rooms: [{ id: "work:CMAIN", name: "메인", kind: "main" }, { id: "me:CALERT", name: "개인 알림", kind: "alert" }, { name: "새 채널", kind: "main", values: { connection: "slack-bot", chat: "C09NEW", bot_token: "xoxb-typed" } }] },
		]);
	});

	test("screenshots: the chat sheet, desktop and phone, light and dark", async () => {
		for (const [name, w, h] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
			for (const theme of ["light", "dark"] as const) {
				const v = await open(w, h, theme);
				await click(v, '#messengers [data-ms="agent"]');
				await waitFor(v, `document.querySelector('dialog [data-room="me:CALERT"]')`);
				await click(v, 'dialog [data-room="me:CALERT"]');
				await waitFor(v, `document.querySelector('dialog.cl input[name="ms-chat"]')`);
				await Bun.write(`${SHOTS}/agent-${name}-${theme}.png`, await v.screenshot());
			}
		}
		for (const d of ["desktop", "phone"]) for (const t of ["light", "dark"]) expect(await Bun.file(`${SHOTS}/agent-${d}-${t}.png`).exists()).toBe(true);
	}, 60_000);
});
