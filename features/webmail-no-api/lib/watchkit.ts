// The watch's pure core: one poll turn with a conditional keep-alive request, a baseline of seen ids, and the
// "recover from logout once, then ask the owner" rule. It emits one stable line per genuinely new mail and nothing when
// there is none, so an idle inbox wakes no model and spends no tokens. All I/O is injected (ctx.fetch, ctx.cookieHeader,
// recover), so the test suite drives the whole flow against a fake mail server with no browser and no network.
import { keepalive } from "./session.ts";
import { mapMails, type Mail } from "./adapter.ts";
import { type SiteSpec } from "./spec.ts";
import { type Ctx, type SiteConfig } from "./config.ts";

export type WatchState = {
	seeded: boolean;
	seen: string[];
	maxNum?: number; // high-water mark when ids are numeric: an old mail sliding back into the window is not "new"
	loggedOut: boolean;
	recoverTried: boolean;
	asked: boolean;
	fails: number;
	etag?: string;
	lastModified?: string;
	lastOk?: string;
};

export const initialState = (): WatchState => ({ seeded: false, seen: [], loggedOut: false, recoverTried: false, asked: false, fails: 0 });

const SEEN_CAP = 2000;
const FAIL_BEFORE_ALERT = 3;

const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const mailLine = (m: Mail): string => `mail ${m.id} from=${oneLine(m.from, 80) || "?"}: ${oneLine(m.subject) || "(제목 없음)"}`;

export type PollResult = { lines: string[]; fail?: string; note: string; state: WatchState };

function diffNew(state: WatchState, mails: Mail[]): { fresh: Mail[]; state: WatchState } {
	const ids = mails.map((m) => m.id);
	const numeric = ids.length > 0 && ids.every((id) => /^\d+$/.test(id));
	if (!state.seeded) {
		return { fresh: [], state: { ...state, seeded: true, seen: ids.slice(0, SEEN_CAP), maxNum: numeric ? Math.max(0, ...ids.map(Number)) : undefined } };
	}
	const seen = new Set(state.seen);
	const fresh = mails.filter((m) => !seen.has(m.id) && (numeric && state.maxNum !== undefined ? Number(m.id) > state.maxNum : true)).reverse();
	const nextSeen = [...new Set([...ids, ...state.seen])].slice(0, SEEN_CAP);
	const nextMax = numeric ? Math.max(state.maxNum ?? 0, ...ids.map(Number)) : state.maxNum;
	return { fresh, state: { ...state, seen: nextSeen, maxNum: nextMax } };
}

function onAlive(state: WatchState, now: number, etag?: string, lastModified?: string): WatchState {
	return { ...state, loggedOut: false, recoverTried: false, asked: false, fails: 0, lastOk: new Date(now).toISOString(), etag: etag ?? state.etag, lastModified: lastModified ?? state.lastModified };
}

// One poll turn. `recover` is attempted at most once per logout outage; it returns whether the session came back (real:
// trigger the stored-credential relogin through Aside / the gateway session watch; test: a canned boolean).
export async function pollOnce(ctx: Ctx, spec: SiteSpec, config: SiteConfig, state: WatchState, recover: () => Promise<boolean>): Promise<PollResult> {
	const cookie = await ctx.cookieHeader(spec);
	const ka = await keepalive(ctx, spec, cookie, { etag: state.etag, lastModified: state.lastModified });

	if (ka.status === "notmodified") {
		return { lines: [], note: "not modified", state: onAlive(state, ctx.now(), ka.etag, ka.lastModified) };
	}

	if (ka.status === "error") {
		const fails = state.fails + 1;
		if (fails >= FAIL_BEFORE_ALERT) return { lines: [], fail: "DOTZ_FAIL network", note: ka.note, state: { ...state, fails } };
		return { lines: [], note: `transient (${fails}/${FAIL_BEFORE_ALERT}): ${ka.note}`, state: { ...state, fails } };
	}

	if (ka.status === "loggedout") {
		if (!state.recoverTried) {
			const recovered = await recover().catch(() => false);
			if (recovered) return pollOnce(ctx, spec, config, { ...state, loggedOut: false, recoverTried: true }, recover);
			if (!state.asked) return { lines: [], fail: "DOTZ_FAIL webmail-login", note: "logged out, recover failed", state: { ...state, loggedOut: true, recoverTried: true, asked: true } };
			return { lines: [], note: "logged out, waiting", state: { ...state, loggedOut: true, recoverTried: true } };
		}
		if (!state.asked) return { lines: [], fail: "DOTZ_FAIL webmail-login", note: "logged out", state: { ...state, loggedOut: true, asked: true } };
		return { lines: [], note: "logged out, waiting", state: { ...state, loggedOut: true } };
	}

	const alive = onAlive(state, ctx.now(), ka.etag, ka.lastModified);
	const mails = mapMails(spec, ka.body);
	const { fresh, state: next } = diffNew(alive, mails);
	return { lines: fresh.map(mailLine), note: `ok ${mails.length} new ${fresh.length}`, state: next };
}
