// Discord bot provisioning for onboarding, driven through the Aside browser (the owner's logged-in session).
// Fully automatic except what Discord requires from a human: the security-key / 2FA approval when the token is reset
// and any captcha. The token is read from the page and written straight to the secrets file; it is never printed.
// One interactive `aside repl` process is kept for the whole run so the opened tab survives between steps.

import type { Subprocess } from "bun";

const TOKEN_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}/;
const DONE_RE = /\[(ok|error) \| [\d.]+m?s\]/;
// Administrator: the bot gets every right in the owner's server (channels, threads, roles, permission overwrites such
// as hiding its channels from other bots), so no later feature stops at "Missing Permissions".
export const PERMISSIONS = 8;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export class AsideRepl {
	private proc: Subprocess<"pipe", "pipe", "pipe">;
	private buf = "";

	constructor() {
		this.proc = Bun.spawn(["aside", "repl"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		for (const stream of [this.proc.stdout, this.proc.stderr])
			void (async () => {
				const decoder = new TextDecoder();
				for await (const chunk of stream) this.buf += decoder.decode(chunk);
			})();
	}

	async run(code: string, timeoutMs = 130_000): Promise<string> {
		const start = this.buf.length;
		this.proc.stdin.write(`${code.replace(/\s*\n\s*/g, " ")}\n`);
		this.proc.stdin.flush();
		for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(200)) {
			const out = this.buf.slice(start);
			if (DONE_RE.test(out)) return out;
		}
		throw new Error("aside repl command timed out");
	}

	async close(): Promise<void> {
		this.proc.stdin.write("exit\n");
		this.proc.stdin.flush();
		await Promise.race([this.proc.exited, wait(3000)]);
		this.proc.kill();
	}
}

const CLICK = `globalThis.clickText = async (labels, ms = 12000) => { for (let t = 0; t < ms; t += 500) { const hit = await page.evaluate(ls => { const b = [...document.querySelectorAll('button')].find(x => ls.includes(x.innerText.trim())); if (b && !b.disabled) { b.click(); return b.innerText.trim(); } return ''; }, labels); if (hit) return hit; await new Promise(r => setTimeout(r, 500)); } return ''; };`;
const READ_TOKEN = `{ const t = await page.evaluate(() => document.body.innerText + ' ' + [...document.querySelectorAll('input,textarea')].map(x => x.value).join(' ')); const m = t.match(${TOKEN_RE}); if (m) console.log('TOKEN_FOUND ' + m[0]); else console.log('WAITING'); }`;

export async function resetToken(repl: AsideRepl, appId: string, notify: (msg: string) => void, timeoutMs = 300_000): Promise<string> {
	const bot = `https://discord.com/developers/applications/${appId}/bot`;
	const urlOf = async () => (await repl.run("console.log('URL ' + page.url());")).match(/URL (\S+)/)?.[1] ?? "";
	await repl.run(`await openTab('${bot}'); ${CLICK} await new Promise(r => setTimeout(r, 3500));`);
	if ((await urlOf()).includes("/login")) {
		notify("Discord 로그인이 풀려 있습니다. Aside 창의 QR 코드를 휴대폰 Discord 앱으로 스캔해 로그인해 주세요.");
		for (const deadline = Date.now() + timeoutMs; Date.now() < deadline && (await urlOf()).includes("/login"); await wait(4000));
		await repl.run(`await page.goto('${bot}'); await new Promise(r => setTimeout(r, 3500));`);
	}
	const start = await repl.run(`const a = await clickText(['토큰 초기화', 'Reset Token']); const b = await clickText(['네, 할게요!', 'Yes, do it!']);
await new Promise(r => setTimeout(r, 2000)); console.log('STEPS ' + [a, b].map(Boolean).join(','));`);
	if (!/STEPS true,true/.test(start)) throw new Error(`token reset did not start: ${start.replace(TOKEN_RE, "<TOKEN>").slice(-200)}`);
	const direct = (await repl.run(READ_TOKEN)).match(/TOKEN_FOUND (\S+)/)?.[1];
	if (direct) return direct;
	notify("Aside 창에서 Discord 인증(인증 앱 코드, SMS, 보안 키 중 쓰시는 것)을 진행해 주세요. 끝나면 토큰을 자동으로 저장합니다.");
	for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(3000)) {
		const token = (await repl.run(READ_TOKEN)).match(/TOKEN_FOUND (\S+)/)?.[1];
		if (token) return token;
	}
	throw new Error("timed out waiting for the Discord verification");
}
