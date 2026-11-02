import { loadSlackConfig, saveSlackConfig, type SlackChannel, type SlackConfig } from "./messenger-slack.ts";
import type { OnboardFlow, OnboardFlowContext, OnboardOwnerStep } from "./onboarding.ts";

const SLACK_TOKEN = /^xox[baprs]-[A-Za-z0-9-]{10,}$/;
const API = "https://slack.com/api";
const TYPES = "public_channel,private_channel";
const SECRET = "slack-bot-token";

const LOGIN_OWNER: OnboardOwnerStep = {
	label: "Slack 로그인과 앱 설치",
	hint: "Aside 창에서 Slack에 로그인하고, 앱 설치 화면의 허용을 누른 뒤 계속을 누르세요.",
};
const CHANNEL_OWNER: OnboardOwnerStep = {
	label: "Slack 채널 확인",
	hint: "Slack에서 봇을 대화 채널에 초대한 뒤 계속을 누르세요.",
};

type Listed = { id: string; name: string; is_member?: boolean; is_archived?: boolean };

function normalizeToken(value: string): string {
	const s = value.trim();
	return SLACK_TOKEN.test(s) ? s : "";
}

async function call(ctx: OnboardFlowContext, token: string, method: string, body: Record<string, unknown> = {}): Promise<any> {
	const form = new URLSearchParams();
	for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
	const res = await ctx.deps.fetch(`${API}/${method}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
		body: form.toString(),
	});
	const json = await res.json().catch(() => undefined);
	if (!res.ok || !json?.ok) throw new Error(`Slack ${method}: ${String(json?.error ?? `HTTP ${res.status}`)}`);
	return json;
}

function findChannel(channels: Listed[], pattern: RegExp): Listed | undefined {
	return channels.find(c => pattern.test(c.name));
}

function mapping(channels: Listed[]): SlackChannel[] {
	const usable = channels.filter(c => !c.is_archived);
	const main = findChannel(usable, /(^|[-_])(dotz|메인|main|general)([-_]|$)/i) ?? usable[0];
	if (!main) return [];
	const out: SlackChannel[] = [{ id: main.id, name: main.name, kind: "main" }];
	const alert = findChannel(usable, /알림|alert|경고/i);
	if (alert && alert.id !== main.id) out.push({ id: alert.id, name: alert.name, kind: "alert" });
	const worklog = findChannel(usable, /작업|worklog|로그|log/i);
	if (worklog && worklog.id !== main.id) out.push({ id: worklog.id, name: worklog.name, kind: "worklog" });
	return out;
}

const save = (ctx: OnboardFlowContext, patch: Partial<SlackConfig>): SlackConfig => {
	const before = loadSlackConfig(ctx.dir);
	const next = saveSlackConfig({ ...before, ...patch }, ctx.dir);
	ctx.changed();
	return next;
};

export const slackFlow: OnboardFlow = {
	key: "slack",
	steps: [
		{
			id: "reuse",
			title: "저장된 Slack 연결 확인",
			detail: "messengers/slack.json과 secrets/slack-bot-token을 먼저 씁니다.",
			owner: { label: "저장된 Slack 연결 확인", hint: "설정 → Slack의 직접 입력에서 토큰과 채널을 확인한 뒤 계속을 누르세요." },
			run: async ctx => {
				const cfg = loadSlackConfig(ctx.dir);
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
			title: "Slack 봇 토큰",
			detail: "토큰이 없으면 오너의 브라우저에서 앱을 만들고 설치해 토큰을 읽어 와요.",
			owner: LOGIN_OWNER,
			run: async ctx => {
				let token = normalizeToken(ctx.memo.get("token") ?? "");
				if (!token) {
					const cfg = loadSlackConfig(ctx.dir);
					token = normalizeToken(cfg.token) || normalizeToken(ctx.secret(SECRET));
					if (token) ctx.seen(token);
				}
				if (!token) {
					if (ctx.attempt === 0) return { waiting: LOGIN_OWNER };
					const got = await ctx.deps.browser.run("slack-app", { name: "dotz" });
					if (!got.ok || got.waiting) return { waiting: LOGIN_OWNER };
					token = normalizeToken(String(got.value ?? ""));
					if (!token) throw new Error("Slack 봇 토큰을 읽지 못했어요");
					ctx.seen(token);
					ctx.saveSecret(SECRET, token);
					save(ctx, { token });
				}
				ctx.memo.set("token", token);
				await call(ctx, token, "auth.test");
				return { done: true };
			},
		},
		{
			id: "channels",
			title: "Slack 채널 찾기",
			detail: "봇이 볼 수 있는 채널을 읽어 메인·알림·작업내역을 정해요.",
			owner: CHANNEL_OWNER,
			run: async ctx => {
				const token = normalizeToken(ctx.memo.get("token") ?? "") || normalizeToken(ctx.secret(SECRET));
				if (!token) throw new Error("Slack 봇 토큰이 없어요");
				ctx.seen(token);
				const listed = await call(ctx, token, "conversations.list", { types: TYPES, limit: 200, exclude_archived: true });
				const channels = mapping(Array.isArray(listed.channels) ? (listed.channels as Listed[]) : []);
				if (!channels.length) return { waiting: CHANNEL_OWNER };
				save(ctx, { token, channels, enabled: true });
				return { done: true };
			},
		},
		{
			id: "verify",
			title: "연결 확인",
			detail: "봇 토큰과 채널을 다시 확인하고 알림 라우팅을 켜요.",
			owner: { label: "Slack 연결 확인", hint: "Slack에서 봇을 채널에 초대한 뒤 계속을 누르세요." },
			run: async ctx => {
				const cfg = loadSlackConfig(ctx.dir);
				const token = normalizeToken(cfg.token);
				if (!token) throw new Error("Slack 봇 토큰이 없어요");
				ctx.seen(token);
				await call(ctx, token, "auth.test");
				if (!cfg.channels.length) throw new Error("Slack 채널을 찾지 못했어요");
				if (!cfg.enabled) save(ctx, { enabled: true });
				return { done: true };
			},
		},
		{
			id: "done",
			title: "연결 완료",
			detail: "Slack 봇과 채널을 확인했어요.",
			owner: { label: "다시 확인", hint: "연결을 다시 시작하면 지금 상태를 다시 확인해요." },
			run: async () => ({ done: true }),
		},
	],
};
