import { loadTelegramConfig, saveTelegramConfig, type TelegramChat, type TelegramConfig } from "./messenger-telegram.ts";
import type { OnboardFlow, OnboardFlowContext, OnboardOwnerStep } from "./onboarding.ts";

const TELEGRAM_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{10,}$/;
const API = "https://api.telegram.org";
const SECRET = "telegram-bot-token";

const LOGIN_OWNER: OnboardOwnerStep = {
	label: "Telegram 로그인과 봇 만들기",
	hint: "Aside 창에서 Telegram에 로그인하고 BotFather에게 봇을 만든 뒤 계속을 누르세요.",
};
const START_OWNER: OnboardOwnerStep = {
	label: "Telegram에서 봇과 대화 시작",
	hint: "Telegram에서 방금 만든 봇을 열고 시작을 누른 뒤 계속을 누르세요.",
};

function normalizeToken(value: string): string {
	const s = value.trim();
	return TELEGRAM_TOKEN.test(s) ? s : "";
}

async function call(ctx: OnboardFlowContext, token: string, method: string, body: Record<string, unknown> = {}): Promise<any> {
	const res = await ctx.deps.fetch(`${API}/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = await res.json().catch(() => undefined);
	if (!res.ok || !json?.ok) throw new Error(`Telegram ${method}: ${String(json?.description ?? `HTTP ${res.status}`)}`);
	return json.result;
}

const save = (ctx: OnboardFlowContext, patch: Partial<TelegramConfig>): TelegramConfig => {
	const next = saveTelegramConfig({ ...loadTelegramConfig(ctx.dir), ...patch }, ctx.dir);
	ctx.changed();
	return next;
};

type Update = { message?: { text?: string; from?: { id?: number }; chat?: { id?: number; type?: string } } };

function mainChat(updates: Update[]): { chat: string; author: string } | undefined {
	for (const u of updates) {
		const m = u?.message;
		if (!m) continue;
		const chat = m.chat?.id !== undefined ? String(m.chat.id) : "";
		const author = m.from?.id !== undefined ? String(m.from.id) : "";
		if (chat && author) return { chat, author };
	}
	return undefined;
}

export const telegramFlow: OnboardFlow = {
	key: "telegram",
	steps: [
		{
			id: "reuse",
			title: "저장된 Telegram 연결 확인",
			detail: "messengers/telegram.json과 secrets/telegram-bot-token을 먼저 씁니다.",
			owner: { label: "저장된 Telegram 연결 확인", hint: "설정 → Telegram의 직접 입력에서 토큰과 채팅을 확인한 뒤 계속을 누르세요." },
			run: async ctx => {
				const cfg = loadTelegramConfig(ctx.dir);
				const token = normalizeToken(cfg.token) || normalizeToken(ctx.secret(SECRET));
				if (!token) return { done: true };
				ctx.seen(token);
				ctx.memo.set("token", token);
				if (cfg.token !== token) save(ctx, { token });
				return { done: true };
			},
		},
		{
			id: "token",
			title: "Telegram 봇 토큰",
			detail: "토큰이 없으면 오너의 브라우저에서 BotFather 대화를 열어 토큰을 읽어 와요.",
			owner: LOGIN_OWNER,
			run: async ctx => {
				let token = normalizeToken(ctx.memo.get("token") ?? "");
				if (!token) {
					const cfg = loadTelegramConfig(ctx.dir);
					token = normalizeToken(cfg.token) || normalizeToken(ctx.secret(SECRET));
					if (token) ctx.seen(token);
				}
				if (!token) {
					if (ctx.attempt === 0) return { waiting: LOGIN_OWNER };
					const got = await ctx.deps.browser.run("telegram-bot");
					if (!got.ok || got.waiting) return { waiting: LOGIN_OWNER };
					token = normalizeToken(String(got.value ?? ""));
					if (!token) throw new Error("Telegram 봇 토큰을 읽지 못했어요");
					ctx.seen(token);
					ctx.saveSecret(SECRET, token);
					save(ctx, { token });
				}
				ctx.memo.set("token", token);
				await call(ctx, token, "getMe");
				return { done: true };
			},
		},
		{
			id: "chat",
			title: "Telegram 대화 찾기",
			detail: "오너가 봇과 대화를 시작하면 getUpdates에서 채팅 ID를 읽어 저장해요.",
			owner: START_OWNER,
			run: async ctx => {
				const token = normalizeToken(ctx.memo.get("token") ?? "") || normalizeToken(ctx.secret(SECRET));
				if (!token) throw new Error("Telegram 봇 토큰이 없어요");
				ctx.seen(token);
				const updates = await call(ctx, token, "getUpdates", { limit: 100, timeout: 0 });
				const found = mainChat(Array.isArray(updates) ? (updates as Update[]) : []);
				if (!found) return { waiting: START_OWNER };
				const chats: TelegramChat[] = [{ id: found.chat, name: "메인", kind: "main" }];
				save(ctx, { chats, allow: [found.author], enabled: true });
				return { done: true };
			},
		},
		{
			id: "verify",
			title: "연결 확인",
			detail: "봇과 대화를 다시 확인하고 알림 라우팅을 켜요.",
			owner: { label: "Telegram 연결 확인", hint: "Telegram에서 봇과 대화를 연 뒤 계속을 누르세요." },
			run: async ctx => {
				const cfg = loadTelegramConfig(ctx.dir);
				const token = normalizeToken(cfg.token);
				if (!token) throw new Error("Telegram 봇 토큰이 없어요");
				ctx.seen(token);
				await call(ctx, token, "getMe");
				if (!cfg.chats.length) throw new Error("Telegram 대화를 찾지 못했어요");
				if (!cfg.enabled) save(ctx, { enabled: true });
				return { done: true };
			},
		},
		{
			id: "done",
			title: "연결 완료",
			detail: "Telegram 봇과 대화를 확인했어요.",
			owner: { label: "다시 확인", hint: "연결을 다시 시작하면 지금 상태를 다시 확인해요." },
			run: async () => ({ done: true }),
		},
	],
};
