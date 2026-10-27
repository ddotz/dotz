// The watch's pure core: one poll turn with a conditional keep-alive request, a baseline of seen ids, and the
// "recover from logout once, then ask the owner" rule. It emits one stable line per genuinely new mail and nothing when
// there is none, so an idle inbox wakes no model and spends no tokens. All I/O is injected (ctx.fetch, ctx.cookieHeader,
// recover), so the test suite drives the whole flow against a fake mail server with no browser and no network.
import { keepalive } from "./session.ts";
import { mapMails, type Mail, type PostedFile } from "./adapter.ts";
import { type SiteSpec } from "./spec.ts";
import { type Ctx, type SiteConfig } from "./config.ts";
import { type Gateway } from "./gateway.ts";

export type WatchState = {
	seeded: boolean;
	seen: string[];
	maxNum?: number; // high-water mark when ids are numeric: an old mail sliding back into the window is not "new"
	loggedOut: boolean;
	recoverTried: boolean;
	fails: number;
	etag?: string;
	lastModified?: string;
	lastOk?: string;
};

export const initialState = (): WatchState => ({ seeded: false, seen: [], loggedOut: false, recoverTried: false, fails: 0 });

const SEEN_CAP = 2000;
const FAIL_BEFORE_ALERT = 3;
// After an outage the backlog can be large; one thread per mail would flood the channel, so only the newest few get a line
// each and the rest is one summary line (they stay readable through `mail.ts list`).
export const MAX_MAIL_LINES = 10;

const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const mailLine = (m: Mail): string => `mail ${m.id} from=${oneLine(m.from, 80) || "?"}: ${oneLine(m.subject) || "(제목 없음)"}`;

export type PollResult = { lines: string[]; mails: Mail[]; fail?: string; note: string; state: WatchState };

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
	return { ...state, loggedOut: false, recoverTried: false, fails: 0, lastOk: new Date(now).toISOString(), etag: etag ?? state.etag, lastModified: lastModified ?? state.lastModified };
}

// One poll turn. A logged-out poll always fails (`DOTZ_FAIL webmail-login`): the gateway alerts after two in a row and then at most every 12 h,
// and shows the app as disconnected until a poll passes; a watch that went quiet after the first one was never alerted and read as connected.
// `recover` is attempted at most once per logout outage; it returns whether the session came back (real:
// trigger the stored-credential relogin through Aside / the gateway session watch; test: a canned boolean).
// `relogin` exists only on a run the owner approved (다시 연결 in 모니터링, or his yes to the alert: DOTZ_APPROVED=1): the full
// sign-in, second factor included, tried on every logged-out poll it is given, whatever the silent recover did before.
export async function pollOnce(ctx: Ctx, spec: SiteSpec, config: SiteConfig, state: WatchState, recover: () => Promise<boolean>, relogin?: () => Promise<boolean>): Promise<PollResult> {
	const cookie = await ctx.cookieHeader(spec);
	const ka = await keepalive(ctx, spec, cookie, { etag: state.etag, lastModified: state.lastModified });

	if (ka.status === "notmodified") {
		return { lines: [], mails: [], note: "not modified", state: onAlive(state, ctx.now(), ka.etag, ka.lastModified) };
	}

	if (ka.status === "error") {
		const fails = state.fails + 1;
		if (fails >= FAIL_BEFORE_ALERT) return { lines: [], mails: [], fail: "DOTZ_FAIL network", note: ka.note, state: { ...state, fails } };
		return { lines: [], mails: [], note: `transient (${fails}/${FAIL_BEFORE_ALERT}): ${ka.note}`, state: { ...state, fails } };
	}

	if (ka.status === "loggedout") {
		if (relogin) {
			const back = await relogin().catch(() => false);
			if (back) return pollOnce(ctx, spec, config, { ...state, loggedOut: false, recoverTried: true }, recover);
			return { lines: [], mails: [], fail: "DOTZ_FAIL webmail-login", note: "logged out, approved sign-in failed", state: { ...state, loggedOut: true, recoverTried: true } };
		}
		if (!state.recoverTried) {
			const recovered = await recover().catch(() => false);
			if (recovered) return pollOnce(ctx, spec, config, { ...state, loggedOut: false, recoverTried: true }, recover);
			return { lines: [], mails: [], fail: "DOTZ_FAIL webmail-login", note: "logged out, recover failed", state: { ...state, loggedOut: true, recoverTried: true } };
		}
		return { lines: [], mails: [], fail: "DOTZ_FAIL webmail-login", note: "logged out, waiting", state: { ...state, loggedOut: true } };
	}

	const alive = onAlive(state, ctx.now(), ka.etag, ka.lastModified);
	const mails = mapMails(spec, ka.body);
	const { fresh, state: next } = diffNew(alive, mails);
	const shown = fresh.slice(-MAX_MAIL_LINES);
	const more = fresh.length - shown.length;
	const lines = [...(more > 0 ? [`mail-backlog ${more}: 이전 새 메일 ${more}통은 목록으로만 볼 수 있어요 (mail.ts list)`] : []), ...shown.map(mailLine)];
	return { lines, mails: shown, note: `ok ${mails.length} new ${fresh.length}`, state: next };
}

// Hands each new mail to the gateway (POST /api/mail, docs/custom-plugins.md "Posting a mail"): the gateway opens its thread
// and its web conversation `mail:<site>-<id>` and gives the orchestrator one turn for it, so a web reply there is gated like a
// Discord thread message. A mail the gateway did not take (gateway off, or one without /api/mail) keeps its stdout line, which
// wakes the orchestrator the old way. Returns the lines still to print.
export async function postToGateway(gw: Gateway, site: string, res: Pick<PollResult, "lines" | "mails">, log: (s: string) => void, describe?: (m: Mail) => Promise<{ body?: string; html?: string; attachments?: PostedFile[] }>): Promise<string[]> {
	const posted = new Set<string>();
	for (const m of res.mails) {
		try {
			const more = describe ? await describe(m).catch((error) => (log(`watch ${site}: mail ${m.id} body and files not read (${(error as Error).message})`), {})) : {};
			await gw("POST", "/api/mail", { source: site, id: m.id, from: oneLine(m.from, 300), subject: oneLine(m.subject, 300) || "(제목 없음)", ...more, wake: true });
			posted.add(m.id);
		} catch (error) {
			log(`watch ${site}: mail ${m.id} not posted to the gateway, waking by line (${(error as Error).message})`);
		}
	}
	return res.lines.filter((l) => !(l.startsWith("mail ") && posted.has(l.slice(5).split(" ")[0])));
}
