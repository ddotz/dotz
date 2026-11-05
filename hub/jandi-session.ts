import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import { msg } from "./i18n.ts";
import { API, refreshAccess, SessionLost } from "./jandi-selfchat.ts";

// Reads the owner's JANDI session the way the web client does (an undocumented API, parsed defensively: the shapes were not seen on a live account):
// the token exchange, the teams of the account, the member id, and the JANDI bot with the owner's chat with it ("나와의 대화").
// The final gate is checkRoomOf (hub/jandi-selfchat.ts); nothing is saved by this module.

export type Get = (path: string, version: number) => Promise<unknown>;
export type Membership = { teamId: number; memberId: number; teamName: string };
export type Session = { get: Get; refresh: string };
export type FoundRoom = { member_id: number; bot_id: number; room_id: number };

const int = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Exchanges the refresh token and returns a reader of the API plus the refresh token to keep (the rotated one when JANDI sent one). */
export async function openSession(f: typeof fetch, refreshToken: string): Promise<Session> {
	const got = await refreshAccess(f, API, refreshToken).catch((e: unknown) => {
		throw e instanceof SessionLost ? new Error(msg().connect.jandi.denied) : e;
	});
	const get: Get = async (path, version) => {
		const res = await f(API + path, { headers: { Authorization: `bearer ${got.access}`, Accept: `application/vnd.tosslab.jandi-v${version}+json` }, signal: AbortSignal.timeout(20_000) });
		if (!res.ok) {
			void res.body?.cancel();
			throw new Error(`JANDI ${path} HTTP ${res.status}`);
		}
		return res.json();
	};
	return { get, refresh: got.refresh ?? refreshToken };
}

export async function memberships(get: Get): Promise<Membership[]> {
	return list(obj(await get("start-api/v4/account", 4)).memberships).flatMap(m => {
		const o = obj(m);
		const teamId = int(o.teamId);
		const memberId = int(o.memberId);
		return teamId && memberId ? [{ teamId, memberId, teamName: typeof o.teamName === "string" && o.teamName ? o.teamName : String(teamId) }] : [];
	});
}

/** The owner's member id in the team: the team's own answer, the membership's when that gives nothing usable. */
export async function memberIdOf(get: Get, team: number, fallback: number): Promise<number> {
	return int(obj(obj(await get(`start-api/v4/teams/${team}/me`, 4)).member).id) || fallback;
}

/** The JANDI bot ("MrJ") and the room of the owner's chat with it: from the team record's bot member, else from the room and bot lists (a connector is never the JANDI bot). */
export async function findRoom(get: Get, team: number, member: number): Promise<FoundRoom> {
	const base = `start-api/v4/teams/${team}`;
	const bot = list(obj(await get(base, 4)).members).map(obj).find(m => m.type === "bot" && int(m.id) && int(m.entityId));
	if (bot) return { member_id: member, bot_id: int(bot.id), room_id: int(bot.entityId) };
	const bots = new Set(list(await get(`${base}/bots`, 4)).map(obj).filter(b => b.botType !== "connect_bot").map(b => int(b.id)).filter(Boolean));
	for (const r of list(await get(`${base}/rooms`, 4)).map(obj)) {
		if (r.type === "chat" && bots.has(int(r.companionId)) && int(r.id) && list(r.members).includes(member)) return { member_id: member, bot_id: int(r.companionId), room_id: int(r.id) };
	}
	throw new Error(msg().connect.jandi.noRoom);
}

/** The mark that the owner's login ended (messengers/jandi-session.json, kept over restarts): one alert per loss, cleared by the next good tick. */
export function createSessionMark(dataDir: string, alert?: (text: string) => void) {
	const file = join(dataDir, "messengers", "jandi-session.json");
	return {
		file,
		state: (): "ok" | "lost" => (existsSync(file) ? "lost" : "ok"),
		lost(): void {
			if (existsSync(file)) return;
			writeAtomic(file, `${JSON.stringify({ lost_at: Date.now() })}\n`, 0o600);
			alert?.(msg().connect.expiry.alert);
		},
		ok(): void {
			if (existsSync(file)) rmSync(file, { force: true });
		},
	};
}
