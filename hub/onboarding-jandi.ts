import { rmSync } from "node:fs";
import { join } from "node:path";
import { NAME } from "./config.ts";
import { msg } from "./i18n.ts";
import { checkRoomOf, SelfChatError, selfChatReady, type SelfChatConfig } from "./jandi-selfchat.ts";
import { findRoom, memberIdOf, memberships, openSession, type Session } from "./jandi-session.ts";
import { type JandiConfig, loadJandiConfig, saveJandiConfig } from "./messenger-jandi.ts";
import { loginClose, loginStep } from "./messenger-login.ts";
import type { OnboardFlow, OnboardFlowContext, OnboardFlowStep, OnboardOwnerStep, OnboardStepOutcome } from "./onboarding.ts";
import { readSecretFile } from "./secretbox.ts";

export type JandiStore = { load(): JandiConfig; save(cfg: JandiConfig): JandiConfig };

export function createJandiStore(dir: string): JandiStore {
	return {
		load: () => loadJandiConfig(dir),
		save: cfg => saveJandiConfig(cfg, dir),
	};
}

// The flow: reuse -> notice -> login -> team -> room -> save -> done. The owner logs in to JANDI in the background Aside window and nothing else;
// the refresh token is read from the web client's login cookie (hub/messenger-login.ts) and only ever lives in memory until it is sealed in the secrets dir.
const LOGIN_URL = "https://www.jandi.com/app/";
const COOKIE_READ = "() => { const m = document.cookie.match(/(?:^|; )_jd_\\.refresh_token=([^;]+)/); return m ? { refresh_token: decodeURIComponent(m[1]) } : null; }";
const PENDING = "jandi-pending";
type Text = ReturnType<typeof msg>["connect"]["jandi"];
type StepKey = "reuse" | "notice" | "login" | "team" | "room" | "save" | "done";

const ready = (cfg: JandiConfig): boolean => cfg.rooms.length > 0 && cfg.rooms.every(room => !!room.outgoing_token && !!(room.incoming_url || cfg.incoming_url));
const reused = (ctx: OnboardFlowContext): boolean => ctx.memo.get("reused") === "1";
const owner = (key: StepKey): OnboardOwnerStep => ({ label: msg().connect.jandi[key].label, hint: msg().connect.jandi[key].hint });

function remember(ctx: OnboardFlowContext, cfg: JandiConfig): void {
	if (cfg.incoming_url) ctx.seen(cfg.incoming_url);
	for (const room of cfg.rooms) {
		if (room.outgoing_token) ctx.seen(room.outgoing_token);
		if (room.incoming_url) ctx.seen(room.incoming_url);
	}
}

// One token exchange per run: later steps of the same run share it. A run resumed after the team question has no memory of it, so the question
// parks the token (rotated if JANDI rotated it) sealed under PENDING, which the save, a failure and a cancel remove.
const sessions = new WeakMap<OnboardFlowContext, Session>();
async function sessionOf(ctx: OnboardFlowContext): Promise<Session> {
	const hit = sessions.get(ctx);
	if (hit) return hit;
	let token = ctx.memo.get("refresh");
	if (!token) {
		try {
			token = (JSON.parse(readSecretFile(join(ctx.dir, "secrets", PENDING))) as { refresh_token?: string }).refresh_token;
		} catch (e) {
			throw new Error(msg().connect.jandi.noToken, { cause: e });
		}
	}
	if (!token) throw new Error(msg().connect.jandi.noToken);
	const session = await openSession(ctx.deps.fetch, ctx.seen(token));
	ctx.seen(session.refresh);
	ctx.memo.set("refresh", session.refresh);
	sessions.set(ctx, session);
	return session;
}

const step = (id: StepKey, run: (ctx: OnboardFlowContext, t: Text) => Promise<OnboardStepOutcome>): OnboardFlowStep => ({
	id,
	get title() {
		return msg().connect.jandi[id].title;
	},
	get detail() {
		return msg().connect.jandi[id].detail;
	},
	get owner() {
		return owner(id);
	},
	run: ctx => run(ctx, msg().connect.jandi),
});

const skipped = (ctx: OnboardFlowContext): OnboardStepOutcome | undefined => (reused(ctx) ? { done: true } : undefined);

export const jandiFlow: OnboardFlow = {
	key: "jandi",
	restartOnFail: true,
	cleanup: async ctx => {
		rmSync(join(ctx.dir, "secrets", PENDING), { force: true });
		await loginClose(ctx, "jandi");
	},
	steps: [
		step("reuse", async ctx => {
			const cfg = ctx.jandi.load();
			remember(ctx, cfg);
			if (selfChatReady(cfg.self_chat) || !ready(cfg)) return { done: true };
			if (!cfg.enabled) {
				remember(ctx, ctx.jandi.save({ ...cfg, enabled: true }));
				ctx.changed();
			}
			ctx.memo.set("reused", "1");
			return { done: true };
		}),
		step("notice", async ctx => {
			if (reused(ctx) || ctx.attempt > 0 || selfChatReady(ctx.jandi.load().self_chat)) return { done: true };
			return { waiting: owner("notice"), manual: true };
		}),
		step("login", async ctx => {
			const skip = skipped(ctx);
			if (skip) return skip;
			const got = await loginStep(ctx, { key: "jandi", url: LOGIN_URL, read: COOKIE_READ, owner: owner("login") });
			if ("waiting" in got) return got;
			const token = got.captured.refresh_token;
			if (typeof token !== "string" || !token) throw new Error(msg().connect.jandi.noToken);
			ctx.memo.set("refresh", ctx.seen(token));
			return { done: true };
		}),
		step("team", async (ctx, t) => {
			const skip = skipped(ctx);
			if (skip) return skip;
			const session = await sessionOf(ctx);
			const teams = await memberships(session.get);
			if (!teams.length) throw new Error(t.noTeams);
			const saved = ctx.jandi.load().self_chat?.team_id;
			const pick = teams.find(x => String(x.teamId) === ctx.choice) ?? (teams.length === 1 ? teams[0] : teams.find(x => x.teamId === saved));
			if (!pick) {
				ctx.saveSealed(PENDING, JSON.stringify({ refresh_token: session.refresh }));
				return { waiting: owner("team"), manual: true, choices: teams.map(x => ({ id: String(x.teamId), label: x.teamName })) };
			}
			ctx.memo.set("team", String(pick.teamId));
			ctx.memo.set("member", String(pick.memberId));
			return { done: true };
		}),
		step("room", async (ctx, t) => {
			const skip = skipped(ctx);
			if (skip) return skip;
			const { get } = await sessionOf(ctx);
			const team = Number(ctx.memo.get("team"));
			const member = await memberIdOf(get, team, Number(ctx.memo.get("member")));
			const found = await findRoom(get, team, member);
			await checkRoomOf(get, { team_id: team, ...found }).catch((e: unknown) => {
				throw e instanceof SelfChatError ? new Error(t.notMine) : e;
			});
			ctx.memo.set("room", JSON.stringify({ team_id: team, ...found }));
			return { done: true };
		}),
		step("save", async (ctx, t) => {
			const skip = skipped(ctx);
			if (skip) return skip;
			const ids = JSON.parse(ctx.memo.get("room") ?? "{}") as Pick<SelfChatConfig, "team_id" | "room_id" | "member_id" | "bot_id">;
			if (!ids.room_id) throw new Error(t.noRoom);
			const cfg = ctx.jandi.load();
			const old = cfg.self_chat;
			const self_chat: SelfChatConfig = {
				enabled: true,
				...ids,
				keyword: old?.keyword ?? (/^\S{1,30}$/.test(NAME) ? NAME : "dotz"),
				reply_prefix: old?.reply_prefix || `[${NAME}]`,
				session_secret: old?.session_secret ?? "jandi-session",
				interval_ms: old?.interval_ms ?? 3000,
				...(old?.peers ? { peers: old.peers } : {}),
			};
			const rooms = cfg.rooms.some(r => r.kind === "main") ? cfg.rooms : [...cfg.rooms, { id: "main", name: t.mainRoom, kind: "main" as const, outgoing_token: "", incoming_url: "" }];
			const { refresh } = await sessionOf(ctx);
			ctx.saveSealed(self_chat.session_secret, JSON.stringify({ refresh_token: refresh }));
			ctx.jandi.save({ ...cfg, enabled: true, rooms, self_chat });
			rmSync(join(ctx.dir, "messengers", "jandi-session.json"), { force: true });
			rmSync(join(ctx.dir, "secrets", PENDING), { force: true });
			ctx.changed();
			return { done: true };
		}),
		step("done", async () => ({ done: true })),
	],
};
