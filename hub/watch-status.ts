// Whether an app is still connected, read from the gateway watches it owns (hub/app-features.ts ownedWatches), apart from whether an alert went out.
// A watch says "disconnected" by failing (two runs in a row, the same count hub/watch.ts alerts on; stopped until approval; or waiting for the
// owner's approval), or, when its check posts its own alerts and exits 0, by a line `DOTZ_DISCONNECTED [since=<ISO time>]` in its output.
// An owner-paused watch says nothing either way.
import type { Watch } from "./watch.ts";

export type WatchStatusLike = Pick<Watch, "name"> & Partial<Pick<Watch, "session" | "paused">> & {
	state: Pick<Watch["state"], "fails"> & Partial<Pick<Watch["state"], "failSince" | "kind" | "paused" | "approvalAskedAt" | "last">>;
};
export type Connection = { state: "connected" } | { state: "disconnected"; since?: string; reason: "login" | "check" };

const DOWN_AFTER = 2; // hub/watch.ts FAIL_ALERT_AFTER (not imported: that module loads watches.json when imported)
const MARK = /^DOTZ_DISCONNECTED\b(?:[^\n]*?\bsince=(\S+))?/m;
const LOGIN_KIND = /login|approval|session|auth/;

const iso = (t: number | string | undefined): string | undefined => {
	if (t === undefined) return undefined;
	const ms = typeof t === "number" ? t : Date.parse(t);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

export function watchConnection(w: WatchStatusLike): Connection {
	if (w.paused) return { state: "connected" };
	const s = w.state;
	if (s.fails >= DOWN_AFTER || s.paused || s.approvalAskedAt) {
		const login = !!w.session || !!s.approvalAskedAt || LOGIN_KIND.test(`${s.kind ?? ""} ${s.paused ?? ""}`);
		const since = iso(s.failSince);
		return { state: "disconnected", ...(since ? { since } : {}), reason: login ? "login" : "check" };
	}
	const m = s.fails === 0 ? MARK.exec(s.last ?? "") : null;
	if (m) {
		const since = iso(m[1]);
		return { state: "disconnected", ...(since ? { since } : {}), reason: "login" };
	}
	return { state: "connected" };
}

/** The app's connection: disconnected when any of its watches is, since the earliest outage among them. */
export function appConnection(watches: readonly WatchStatusLike[]): Connection {
	const down = watches.map(watchConnection).filter((c): c is Extract<Connection, { state: "disconnected" }> => c.state === "disconnected");
	if (!down.length) return { state: "connected" };
	const since = down.map(c => c.since).filter((s): s is string => !!s).sort()[0];
	return { state: "disconnected", ...(since ? { since } : {}), reason: down.some(c => c.reason === "login") ? "login" : "check" };
}

function localTime(at: string, timeZone?: string): string {
	const p = Object.fromEntries(new Intl.DateTimeFormat("ko-KR", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
	return `${p.month}월 ${p.day}일 ${p.hour}:${p.minute}`;
}

/** The row text of a disconnected app: "연결 끊김 · 10월 23일 21:29부터 · 다시 로그인 필요". Undefined when connected. */
export function connectionText(c: Connection, timeZone?: string): string | undefined {
	if (c.state !== "disconnected") return undefined;
	return ["연결 끊김", c.since ? `${localTime(c.since, timeZone)}부터` : "", c.reason === "login" ? "다시 로그인 필요" : "확인이 계속 실패해요"].filter(Boolean).join(" · ");
}
