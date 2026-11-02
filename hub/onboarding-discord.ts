import { NAME } from "./config.ts";
import { PERMISSIONS } from "../onboard/discord.ts";
import type { OnboardFlow, OnboardFlowContext, OnboardOwnerStep } from "./onboarding.ts";

const API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{17,20}$/;
const APP_ID = /^\d{15,25}$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}$/;

const APP_OWNER: OnboardOwnerStep = { label: "Discord 앱 확인", hint: "브라우저에 열린 Discord 개발자 포털에서 캡차를 풀거나 앱을 직접 만들어 주세요. 끝나면 계속을 누르세요." };
const TOKEN_OWNER: OnboardOwnerStep = { label: "Discord 로그인 확인", hint: "Aside 창에서 Discord 로그인과 2단계 인증을 마친 뒤 계속을 누르세요." };
const GUILD_OWNER: OnboardOwnerStep = { label: "Discord 서버 선택", hint: "브라우저에서 봇을 쓸 서버를 열어 두고 계속을 누르세요." };
const INVITE_OWNER: OnboardOwnerStep = { label: "봇 초대 승인", hint: "브라우저에 열린 초대 화면에서 계속하기와 승인을 누르고, 캡차가 보이면 풀어 주세요. 끝나면 계속을 누르세요." };
const VERIFY_OWNER: OnboardOwnerStep = { label: "Discord 연결 확인", hint: "Discord 개발자 포털의 Bot 탭에서 MESSAGE CONTENT INTENT를 켜고, 봇을 서버에 관리자로 초대한 뒤 계속을 누르세요." };

type GuildInfo = { id: string; permissions?: string };
type Me = { id: string };

async function get(ctx: OnboardFlowContext, token: string, path: string): Promise<unknown> {
	const res = await ctx.deps.fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
	if (res.status === 401) throw new Error("봇 토큰이 거절됐어요");
	if (!res.ok) return undefined;
	return res.json().catch(() => undefined);
}

async function guildAccess(ctx: OnboardFlowContext, token: string, guild: string): Promise<{ member: boolean; admin: boolean }> {
	if (!SNOWFLAKE.test(guild)) return { member: false, admin: false };
	const guilds = (await get(ctx, token, "/users/@me/guilds")) as GuildInfo[] | undefined;
	if (!Array.isArray(guilds) || !guilds.some(g => g.id === guild)) return { member: false, admin: false };
	const me = (await get(ctx, token, "/users/@me")) as Me | undefined;
	if (!me?.id) return { member: true, admin: false };
	const member = (await get(ctx, token, `/guilds/${guild}/members/${me.id}`)) as { roles: string[] } | undefined;
	const roles = (await get(ctx, token, `/guilds/${guild}/roles`)) as { id: string; permissions: string }[] | undefined;
	if (!member || !roles) return { member: true, admin: false };
	const mine = new Set([...member.roles, guild]);
	return { member: true, admin: roles.some(r => mine.has(r.id) && (BigInt(r.permissions) & 8n) === 8n) };
}

const usedBrowser = async (ctx: OnboardFlowContext, action: string, arg?: Record<string, unknown>) => {
	const result = await ctx.deps.browser.run(action, arg);
	if (result.waiting) return { waiting: true as const, result };
	if (!result.ok) return { waiting: false as const, result };
	return { waiting: false as const, result };
};

const noop = { id: "done", title: "연결 완료", detail: "Discord 봇 연결을 확인했어요.", owner: { label: "다시 확인", hint: "연결을 다시 시작하면 지금 상태를 다시 확인해요." } as OnboardOwnerStep, run: async () => ({ done: true as const }) };

export const discordFlow: OnboardFlow = {
	key: "discord",
	steps: [
		{
			id: "reuse",
			title: "저장된 연결 확인",
			detail: "이미 저장된 봇 토큰과 서버 정보를 먼저 씁니다.",
			owner: { label: "저장된 연결 확인", hint: "이 컴퓨터의 설정에서 Discord 토큰을 지우면 처음부터 다시 연결해요." },
			run: async ctx => {
				const token = ctx.discord.token();
				if (token) ctx.seen(token);
				return { done: true };
			},
		},
		{
			id: "token",
			title: "봇 앱과 토큰",
			detail: "토큰이 없으면 개발자 포털에서 앱을 찾거나 만들고, 봇 토큰을 한 번만 읽어 안전하게 저장해요.",
			owner: TOKEN_OWNER,
			run: async ctx => {
				let cfg = ctx.discord.config();
				let token = ctx.discord.token();
				if (token) ctx.seen(token);
				let appId = cfg.app_id;
				if (token && !APP_ID.test(appId)) {
					const app = (await get(ctx, token, "/oauth2/applications/@me")) as { id?: string } | undefined;
					const found = String(app?.id ?? "");
					if (APP_ID.test(found)) {
						appId = found;
						if (ctx.discord.save({ app_id: appId }).changed) ctx.changed();
					}
				}
				if (!APP_ID.test(appId)) {
					const app = await usedBrowser(ctx, "discord-app", { name: NAME });
					if (app.waiting) return { waiting: APP_OWNER };
					const found = String(app.result.value ?? "");
					if (!APP_ID.test(found)) throw new Error("Discord 앱을 만들지 못했어요");
					appId = found;
					if (ctx.discord.save({ app_id: appId }).changed) ctx.changed();
				}
				if (!token) {
					const got = await usedBrowser(ctx, "discord-token", { appId });
					if (got.waiting) return { waiting: TOKEN_OWNER };
					const value = ctx.seen(String(got.result.value ?? ""));
					if (!TOKEN_SHAPE.test(value)) throw new Error("봇 토큰을 읽지 못했어요");
					ctx.discord.storeToken(value);
					ctx.changed();
					token = value;
				}
				if (!TOKEN_SHAPE.test(token)) throw new Error("저장된 봇 토큰이 올바르지 않아요");
				return { done: true };
			},
		},
		{
			id: "guild",
			title: "서버 찾기",
			detail: "서버 ID가 없으면 Discord 웹에서 오너의 서버를 읽어요.",
			owner: GUILD_OWNER,
			run: async ctx => {
				const cfg = ctx.discord.config();
				if (SNOWFLAKE.test(cfg.guild)) return { done: true };
				const got = await usedBrowser(ctx, "discord-guild");
				if (got.waiting) return { waiting: GUILD_OWNER };
				const guild = String(got.result.value ?? "");
				if (!SNOWFLAKE.test(guild)) throw new Error("Discord 서버를 찾지 못했어요");
				if (ctx.discord.save({ guild }).changed) ctx.changed();
				return { done: true };
			},
		},
		{
			id: "invite",
			title: "봇 초대",
			detail: "봇이 아직 서버에 없으면 관리자 권한 초대 화면을 배경 탭으로 열어요.",
			owner: INVITE_OWNER,
			run: async ctx => {
				const cfg = ctx.discord.config();
				const token = ctx.seen(ctx.discord.token());
				if (!token) throw new Error("봇 토큰이 없어요");
				if (!SNOWFLAKE.test(cfg.guild)) throw new Error("서버 ID가 없어요");
				const before = await guildAccess(ctx, token, cfg.guild);
				if (before.member && before.admin) return { done: true };
				const url = `https://discord.com/oauth2/authorize?client_id=${cfg.app_id}&scope=bot&permissions=${PERMISSIONS}&guild_id=${cfg.guild}&disable_guild_select=true`;
				const got = await usedBrowser(ctx, "discord-invite", { url });
				if (got.waiting) return { waiting: INVITE_OWNER };
				const after = await guildAccess(ctx, token, cfg.guild);
				if (!after.member) throw new Error("봇이 아직 서버에 없어요");
				if (!after.admin) throw new Error("봇에게 관리자 권한이 아직 없어요");
				return { done: true };
			},
		},
		{
			id: "owner",
			title: "오너 확인",
			detail: "서버 소유자 ID를 디스코드 API에서 읽어 저장해요.",
			owner: { label: "서버 소유자 확인", hint: "봇이 서버에서 관리자로 보이는지 확인한 뒤 계속을 누르세요." },
			run: async ctx => {
				const cfg = ctx.discord.config();
				let ownerId = cfg.owner_id;
				const token = ctx.seen(ctx.discord.token());
				if (!token) throw new Error("봇 토큰이 없어요");
				if (!SNOWFLAKE.test(ownerId)) {
					const guild = (await get(ctx, token, `/guilds/${cfg.guild}`)) as { owner_id?: string } | undefined;
					ownerId = String(guild?.owner_id ?? "");
					if (!SNOWFLAKE.test(ownerId)) throw new Error("서버 소유자 ID를 읽지 못했어요");
				}
				const values: Record<string, string> = { guild: cfg.guild, owner_id: ownerId };
				if (APP_ID.test(cfg.app_id)) values.app_id = cfg.app_id;
				if (ctx.discord.save(values).changed) ctx.changed();
				return { done: true };
			},
		},
		{
			id: "verify",
			title: "연결 확인",
			detail: "봇 사용자와 서버 관리자 권한을 디스코드 API로 확인해요.",
			owner: VERIFY_OWNER,
			run: async ctx => {
				const cfg = ctx.discord.config();
				const token = ctx.seen(ctx.discord.token());
				if (!token) throw new Error("봇 토큰이 없어요");
				const me = (await get(ctx, token, "/users/@me")) as Me | undefined;
				if (!me?.id) throw new Error("봇으로 Discord에 연결하지 못했어요");
				const access = await guildAccess(ctx, token, cfg.guild);
				if (!access.member) throw new Error("봇이 서버에 들어가지 않았어요");
				if (!access.admin) throw new Error("봇에게 관리자 권한이 없어요");
				return { done: true };
			},
		},
		noop,
	],
};
