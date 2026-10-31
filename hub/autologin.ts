// Signing a kept login in again without the model (owner 2026-10-28: "사이트별 재로그인을 코드로"). A session watch (hub/watch.ts) that
// finds its login lost calls relogin(): the site's login form opens in a background Aside tab (hub/aside.ts replInTab, closed in the same
// run, never brought to the front) and the gateway submits what the browser already filled in from the owner's Mac Passwords app. Only
// when the form stays empty does it type the login kept with `dotz_auth` (a secrets file holding {"username","password"} JSON, fetched
// once from localhost and never put in code or argv). Then it waits for the form to go away. A second factor (push, code, security key)
// is never started without the owner's yes: without it the run stops at the factor and says so; with it (allow2fa, the owner's 다시 연결)
// it waits for the push to be approved.
import { replInTab } from "./aside.ts";

export type ReloginResult = "in" | "need-2fa" | "need-password" | "failed";
export type ReloginOpts = { allow2fa?: boolean; secret?: string };
export type Relogin = (url: string, o?: ReloginOpts) => Promise<ReloginResult>;

const FIRST_WAIT_MS = 3000;
const POLL_MS = 2500;
const WAIT_MS = 25_000;
const WAIT_2FA_MS = 150_000;

// The repl body (hub/aside.ts replInTab gives it `pg`, the background tab, and `secret` when one is named). It returns the verdict.
// A filled field counts by its value or by the browser's autofill mark: a password the browser filled may stay hidden from the page's
// script until the first key press, and pressing Enter in the field is that press.
export function reloginBody(o: ReloginOpts = {}): string {
	const wait = o.allow2fa ? WAIT_2FA_MS : WAIT_MS;
	return `const state = () => pg.evaluate(() => {
	const pw = [...document.querySelectorAll('input[type=password]')].find(e => e.offsetParent !== null) || null;
	const otp = document.querySelector('input[autocomplete=one-time-code], input[name*=otp i], input[id*=otp i], input[name*=verif i]');
	const text = document.body ? document.body.innerText : "";
	const auto = e => { try { return e.matches(':autofill') || e.matches(':-webkit-autofill'); } catch { return false; } };
	return { pw: !!pw, filled: !!(pw && (pw.value || auto(pw))), otp: !!otp, factor: /2-step|two-factor|verification code|security key|one-time|인증 ?코드|인증번호|2단계|2차 인증|보안 ?키|승인 요청|본인 ?확인/i.test(text) };
});
await sleep(${FIRST_WAIT_MS});
let s = await state();
if (!s.pw) return s.otp || s.factor ? "need-2fa" : "in";
if (!s.filled) {
	${o.secret ? `let cred = null; try { cred = JSON.parse(secret); } catch {}
	if (!cred || !cred.password) return "need-password";
	if (cred.username) {
		const user = pg.locator('input[autocomplete=username], input[type=email], input[name*=user i], input[name*=id i], input[name*=email i], input[type=text]').first();
		if (await user.count()) await user.fill(String(cred.username));
	}
	await pg.locator('input[type=password]').first().fill(String(cred.password));` : `return "need-password";`}
}
await pg.locator('input[type=password]').first().press("Enter");
const end = Date.now() + ${wait};
let factor = false;
while (Date.now() < end) {
	await sleep(${POLL_MS});
	s = await state();
	if (!s.pw && !s.otp && !s.factor) return "in";
	if (s.otp || s.factor) { factor = true; ${o.allow2fa ? "" : "break;"} }
}
return factor ? "need-2fa" : "failed";`;
}

const VERDICTS = new Set<ReloginResult>(["in", "need-2fa", "need-password", "failed"]);

/** One sign-in attempt at `url` (the login form, or a page that sends a signed-out visitor to it). Never throws: a run that could not
 *  happen (Aside not answering, a timeout) is "failed". */
export async function relogin(url: string, o: ReloginOpts = {}): Promise<ReloginResult> {
	try {
		const v = await replInTab(url, reloginBody(o), { timeoutMs: (o.allow2fa ? WAIT_2FA_MS : WAIT_MS) + 40_000, ...(o.secret ? { secret: o.secret } : {}) });
		return VERDICTS.has(v as ReloginResult) ? (v as ReloginResult) : "failed";
	} catch {
		return "failed";
	}
}
