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

export async function ensureBrowser(): Promise<void> {
	const probe = (await Bun.$`aside repl ${"const p = await openTab('about:blank'); console.log('READY');"}`.nothrow().quiet()).stdout.toString();
	if (/READY/.test(probe)) return;
	await Bun.$`open -a Aside`.nothrow().quiet();
	await wait(6000);
}

export async function createApp(name: string): Promise<string> {
	const task = `In the Discord Developer Portal (https://discord.com/developers/applications), logged in as the current user:
1. If an application named "${name}" exists, open it; otherwise create it with "New Application" (accept the terms; solve a captcha if one appears).
2. Bot tab: turn ON "MESSAGE CONTENT INTENT" and save.
3. Installation tab: set the install link to "None" and save; then Bot tab: turn OFF "Public Bot" and save.
4. Do NOT reset or reveal the token. Do NOT invite the bot anywhere.
5. End your reply with one line exactly: APP_ID=<the application id>`;
	const out = (await Bun.$`aside ${task}`.nothrow().quiet()).stdout.toString();
	const id = out.match(/APP_ID=(\d{15,25})/)?.[1];
	if (!id) throw new Error("could not create or find the Discord application (see the Aside session)");
	return id;
}

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

export async function invite(repl: AsideRepl, appId: string, guild: string, token: string, notify: (msg: string) => void, timeoutMs = 180_000): Promise<void> {
	const inGuild = async () => {
		const r = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers: { Authorization: `Bot ${token}` } });
		return r.ok && ((await r.json()) as { id: string }[]).some(g => g.id === guild);
	};
	if ((await inGuild()) && (await isAdmin(token, guild))) return;
	const url = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${PERMISSIONS}&guild_id=${guild}&disable_guild_select=true`;
	await repl.run(`await openTab('${url}'); ${CLICK} await clickText(['계속하기', '계속', 'Continue'], 15000); await clickText(['승인', 'Authorize'], 15000); console.log('CLICKED');`);
	for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(5000)) {
		if ((await inGuild()) && (await isAdmin(token, guild))) return;
		notify("봇 초대(관리자 권한)를 기다리는 중입니다. Aside 창에 캡차가 보이면 풀어 주세요.");
	}
	throw new Error("bot was not added to the server with administrator rights in time");
}

export async function isAdmin(token: string, guild: string): Promise<boolean> {
	const get = async (path: string) => {
		const r = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
		return r.ok ? r.json() : undefined;
	};
	const me = (await get("/users/@me")) as { id: string } | undefined;
	const member = me && ((await get(`/guilds/${guild}/members/${me.id}`)) as { roles: string[] } | undefined);
	const roles = member && ((await get(`/guilds/${guild}/roles`)) as { id: string; permissions: string }[] | undefined);
	if (!roles) return false;
	const mine = new Set([...member.roles, guild]);
	return roles.some(r => mine.has(r.id) && (BigInt(r.permissions) & 8n) === 8n);
}
