import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { USER_TOKEN_NOTE } from "./messenger-agent.ts";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// 설정 → 메신저 for the Slack / Telegram adapter: the tokens are top-level fields, the chats are mirrored read-only (headless Bun.WebView, stub gateway).
const SHOTS = process.env.MESSENGER_SHOTS ?? "/tmp/dotz-messenger-shots";
mkdirSync(SHOTS, { recursive: true });

const chats = [
	{ id: "work:CMAIN", name: "메인 대화", kind: "main", chat: "C01MAIN", last_in: Date.now() - 120_000, last_out: Date.now() - 30_000 },
	{ id: "work:CPROJ", name: "결제", kind: "project", chat: "C03PROJ", project: { target: "ch:7", name: "결제" } },
	{ id: "me:CALERT", name: "알림", kind: "alert", chat: "C02ALRT", last_error: "not_in_channel" },
];
let botSet = true;
const puts: any[] = [];
const agent = () => ({
	enabled: true,
	help: ["Slack은 앱을 만들어 봇 토큰(xoxb-)을 한 번만 넣어요", "채팅은 dotz가 웹 앱의 대화대로 알아서 맞춰 둬요"],
	fields: [
		{ key: "slack_bot_token", label: "Slack 봇 토큰", type: "secret", set: botSet, hint: "xoxb- 로 시작해요" },
		{ key: "slack_user_token", label: "Slack 사용자 토큰", type: "secret", as_user: true, set: false, hint: USER_TOKEN_NOTE },
		{ key: "telegram_chat", label: "Telegram 채팅 ID", type: "text", value: "" },
	],
	allow: { label: "말을 걸 수 있는 사람", hint: "Slack 멤버 ID(U…)나 Telegram 숫자 ID", items: ["U01OWNER"] },
	rooms: {
		label: "채팅",
		editable: true,
		hint: "남은 일: Telegram 봇에게 말을 건 뒤 그 채팅 ID를 위 'Telegram 채팅 ID'에 한 번 넣어요",
		fields: [],
		items: chats.map(({ chat, ...r }) => ({ ...r, values: { connection: "slack-bot", chat }, set: {} })),
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
			const b = (await req.json()) as any;
			puts.push(b);
			if (b.values?.slack_bot_token) botSet = true;
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
	test("the detail mirrors the chats read-only and shows the saved flags and the account warning on the token fields", async () => {
		botSet = true;
		const v = await open(1280, 800);
		await click(v, '#messengers [data-ms="agent"]');
		await waitFor(v, `document.querySelectorAll("dialog [data-room]").length === 3`);
		expect(await ev(v, `[...document.querySelectorAll("dialog [data-room] .hd")].map(h => h.textContent)`)).toEqual(["메인 대화", "결제", "알림"]);
		expect(await ev(v, `[...document.querySelectorAll("dialog [data-room]")].map(r => r.querySelector(".sup").textContent.replace(/ · (받음|보냄) .*$/, ""))`)).toEqual(["→ 메인 대화", "→ 프로젝트 · 결제", "→ 알림"]);
		const d = await ev<{ saved: string[]; asUser: string[]; pass: number; add: unknown; html: string }>(v, `({ saved: [...document.querySelectorAll("dialog [data-set]")].map(s => s.dataset.set), asUser: [...document.querySelectorAll("dialog [data-as-user]")].map(s => s.dataset.asUser), pass: document.querySelectorAll('dialog input[type="password"]').length, add: document.querySelector("dialog [data-ms-add]"), html: document.querySelector("dialog").innerHTML })`);
		expect(d).toMatchObject({ saved: ["slack_bot_token"], asUser: ["slack_user_token"], pass: 2, add: null });
		expect(d.html).toContain("남은 일");
	});

	test("typing a token sends only that value", async () => {
		botSet = false;
		const v = await open(390, 844);
		await click(v, '#messengers [data-ms="agent"]');
		await waitFor(v, `document.querySelector('dialog input[name="ms-slack_bot_token"]')`);
		await type(v, 'dialog input[name="ms-slack_bot_token"]', "xoxb-typed");
		await waitFor(v, `!document.querySelector("dialog [data-ms-save]").disabled`);
		puts.length = 0;
		await click(v, "dialog [data-ms-save]");
		await waitFor(v, `MD && document.querySelector('dialog [data-set="slack_bot_token"]')`);
		expect(puts).toEqual([{ values: { slack_bot_token: "xoxb-typed" } }]);
		expect(await ev(v, `document.querySelector('dialog input[name="ms-slack_bot_token"]').value`)).toBe("");
	});

	test("screenshots: the detail, desktop and phone, light and dark", async () => {
		botSet = true;
		for (const [name, w, h] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
			for (const theme of ["light", "dark"] as const) {
				const v = await open(w, h, theme);
				await click(v, '#messengers [data-ms="agent"]');
				await waitFor(v, `document.querySelectorAll("dialog [data-room]").length === 3`);
				await Bun.write(`${SHOTS}/agent-${name}-${theme}.png`, await v.screenshot());
			}
		}
		for (const d of ["desktop", "phone"]) for (const t of ["light", "dark"]) expect(await Bun.file(`${SHOTS}/agent-${d}-${t}.png`).exists()).toBe(true);
	}, 60_000);
});
