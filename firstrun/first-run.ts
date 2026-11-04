import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

// The first-run marker of a web onboarding: <data dir>/onboarding/first-run.json (0600, written atomically). It is how the gateway tells a seed install
// that still owes its onboarding (status "pending") from an existing one (no file, or "done"). No secret value is ever stored here: the one-time token and
// the setup cookie are kept as sha256, the draft holds the owner's answers except secrets (those go to secrets/ and the draft only notes that they are saved).
// This module imports nothing from the hub, so setup.ts can use it before any config.json exists.

export type FirstRun = {
	status: "pending" | "done";
	token_sha256: string;
	token_expires_at: number;
	cookie_sha256: string;
	step: string;
	draft: Record<string, unknown>;
	intro: "pending" | "seen";
};

export const TOKEN_TTL_MS = 24 * 3600_000;
export const SETUP_COOKIE = "dotz_setup";
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const file = (dir: string): string => join(dir, "onboarding", "first-run.json");

export function readFirstRun(dir: string): FirstRun | undefined {
	try {
		const v = JSON.parse(readFileSync(file(dir), "utf8")) as Partial<FirstRun>;
		return {
			status: v.status === "done" ? "done" : "pending",
			token_sha256: typeof v.token_sha256 === "string" ? v.token_sha256 : "",
			token_expires_at: typeof v.token_expires_at === "number" ? v.token_expires_at : 0,
			cookie_sha256: typeof v.cookie_sha256 === "string" ? v.cookie_sha256 : "",
			step: typeof v.step === "string" ? v.step : "start",
			draft: v.draft && typeof v.draft === "object" && !Array.isArray(v.draft) ? v.draft : {},
			intro: v.intro === "seen" ? "seen" : "pending",
		};
	} catch {
		return undefined;
	}
}

export function writeFirstRun(dir: string, state: FirstRun): void {
	mkdirSync(join(dir, "onboarding"), { recursive: true });
	const tmp = `${file(dir)}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file(dir));
}

export const firstRunPending = (dir: string): boolean => readFirstRun(dir)?.status === "pending";

const update = (dir: string, change: (s: FirstRun) => FirstRun): FirstRun | undefined => {
	const s = readFirstRun(dir);
	if (!s) return undefined;
	const next = change(s);
	writeFirstRun(dir, next);
	return next;
};

/** A fresh one-time token (24 h) for a pending install, creating the marker on the first call. Returns the raw token; only its sha256 is stored. */
export function issueToken(dir: string, now = Date.now()): string {
	const token = randomBytes(32).toString("base64url");
	const s = readFirstRun(dir) ?? { status: "pending", token_sha256: "", token_expires_at: 0, cookie_sha256: "", step: "start", draft: {}, intro: "pending" };
	writeFirstRun(dir, { ...s, status: "pending", token_sha256: sha256(token), token_expires_at: now + TOKEN_TTL_MS });
	return token;
}

/** Trades the token for a cookie value. The right token is used up whether or not it had expired; a wrong guess leaves the real one alone. */
export function redeemToken(dir: string, token: string, now = Date.now()): string | undefined {
	const s = readFirstRun(dir);
	if (s?.status !== "pending" || !s.token_sha256 || !token || sha256(token) !== s.token_sha256) return undefined;
	const cookie = s.token_expires_at > now ? randomBytes(32).toString("base64url") : undefined;
	writeFirstRun(dir, { ...s, token_sha256: "", token_expires_at: 0, ...(cookie ? { cookie_sha256: sha256(cookie) } : {}) });
	return cookie;
}

export function cookieValid(dir: string, cookie: string | undefined): boolean {
	const s = readFirstRun(dir);
	return s?.status === "pending" && !!cookie && !!s.cookie_sha256 && sha256(cookie) === s.cookie_sha256;
}

/** Remembers the step and merges the answers of the step that was left. */
export const saveDraft = (dir: string, step: string, values: Record<string, unknown>): FirstRun | undefined => update(dir, s => ({ ...s, step, draft: { ...s.draft, ...values } }));

/** Onboarding finished: the routes close for good, the token hash and the cookie hash go. */
export const markDone = (dir: string): FirstRun | undefined => update(dir, s => ({ ...s, status: "done", token_sha256: "", token_expires_at: 0, cookie_sha256: "" }));

/** A terminal wizard install ends here: no marker means a fresh install that has not seen the app tour; an existing marker only closes. */
export function markTerminalDone(dir: string, fresh: boolean): void {
	if (readFirstRun(dir)) markDone(dir);
	else if (fresh) writeFirstRun(dir, { status: "done", token_sha256: "", token_expires_at: 0, cookie_sha256: "", step: "done", draft: {}, intro: "pending" });
}

/** The app tour (docs/web-onboarding.md): an install without a marker is an existing one and never shows it. */
export const introOf = (dir: string): "pending" | "seen" => (existsSync(file(dir)) ? (readFirstRun(dir)?.intro ?? "seen") : "seen");
export const setIntro = (dir: string, intro: "pending" | "seen"): void => void update(dir, s => ({ ...s, intro }));
