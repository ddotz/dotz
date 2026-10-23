// Signs in to a webmail site through `aside repl` (a background tab driven by our own code; the Aside agent `aside exec` is
// never used, it spends Aside's own rate limit). The browser's saved password autofills the form; this code only submits it.
// No password is typed or read here. The runner is injected so tests need no Aside.
import type { LoginResult } from "./onboard.ts";

export type Repl = (code: string, timeoutMs: number) => Promise<string>;

const FIRST_WAIT_MS = 3000;
const POLL_MS = 3000;

export function loginCode(url: string, allowSecondFactor: boolean): string {
	const waitMs = allowSecondFactor ? 150_000 : 25_000;
	return `const pg = await openTab(${JSON.stringify(url)});
let verdict = "LOGIN_FAILED";
try {
	const state = () => pg.evaluate(() => {
		const pw = document.querySelector('input[type=password]');
		const otp = document.querySelector('input[autocomplete=one-time-code], input[name*=otp i], input[name*=code i], input[inputmode=numeric]');
		const text = (document.body ? document.body.innerText : "");
		return { pw: !!pw, filled: !!(pw && pw.value), otp: !!otp, factor: /2-step|two-factor|verification code|인증 코드|2단계|보안 키/i.test(text) };
	});
	await sleep(${FIRST_WAIT_MS});
	let s = await state();
	if (!s.pw) verdict = s.otp || s.factor ? "NEED_2FA" : "LOGIN_OK";
	else if (!s.filled) verdict = "NEED_PASSWORD";
	else {
		await pg.locator('input[type=password]').first().press("Enter");
		const end = Date.now() + ${waitMs};
		let factor = false;
		verdict = "LOGIN_FAILED";
		while (Date.now() < end) {
			await sleep(${POLL_MS});
			s = await state();
			if (!s.pw && !s.otp && !s.factor) { verdict = "LOGIN_OK"; break; }
			if (s.otp || s.factor) { factor = true; if (!${allowSecondFactor}) break; }
		}
		if (verdict !== "LOGIN_OK" && factor) verdict = "NEED_2FA";
	}
} finally { await closeTab(pg).catch(() => {}); }
console.log("WM_LOGIN " + verdict);`;
}

export async function loginViaRepl(repl: Repl, url: string, allowSecondFactor: boolean): Promise<LoginResult> {
	const out = await repl(loginCode(url, allowSecondFactor), allowSecondFactor ? 175_000 : 60_000);
	const m = out.match(/WM_LOGIN (LOGIN_OK|NEED_2FA|NEED_PASSWORD|LOGIN_FAILED)/);
	if (m?.[1] === "LOGIN_OK") return "in";
	if (m?.[1] === "NEED_2FA") return "need-2fa";
	if (m?.[1] === "NEED_PASSWORD") return "need-password";
	return "failed";
}
