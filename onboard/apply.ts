// What onboarding does once the answers are complete: secrets, config.json, state.json, IDENTITY.md, the omp plugin link, `tailscale serve`
// and the Discord bot. Moved out of setup.ts so the terminal wizard and the web onboarding (hub/setup-apply.ts) run the same code;
// every line goes through env.say (console.log in the terminal, the scrubbed stream on the web).
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Answers, identityDoc, type Prior } from "./answers.ts";
import { AsideRepl, createApp, ensureBrowser, invite, isAdmin, PERMISSIONS, resetToken } from "./discord.ts";
import { serveWeb, tailscaleState, type TailscaleState } from "./tailscale.ts";

export type Env = { dir: string; home: string; pkg: string; say: (line: string) => void };

export const tokenFile = (dir: string): string => join(dir, "secrets", "discord-bot-token");
// The key every gateway of this owner shares, so 모니터링 shows all computers together and an action runs on the computer that owns
// the item (docs/peer-monitoring.md). The first computer makes it; the others take the same value.
export const peerTokenFile = (dir: string): string => join(dir, "secrets", "peer-token");

/** One secret file, 0600, replaced atomically; the value is never echoed. */
export function writeSecret(file: string, value: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	chmodSync(join(file, ".."), 0o700);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${value.trim()}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

export function writeSecrets(env: Env, a: Answers): void {
	mkdirSync(join(env.dir, "secrets"), { recursive: true });
	chmodSync(join(env.dir, "secrets"), 0o700);
	if (a.bot_token) writeSecret(tokenFile(env.dir), a.bot_token);
	if (a.peer_token || !existsSync(peerTokenFile(env.dir))) {
		writeSecret(peerTokenFile(env.dir), a.peer_token ?? randomBytes(32).toString("hex"));
		env.say(a.peer_token ? "모니터링: 공유 키를 secrets/ 에 저장했어요 (화면에 표시 안 함)" : "모니터링: 다른 컴퓨터와 함께 보는 공유 키를 만들었어요. 다른 컴퓨터의 setup 에서 이 컴퓨터의 ~/.dotz/secrets/peer-token 내용을 붙여넣으세요.");
	}
}

const pick = (o: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(keys.filter(k => o?.[k] != null).map(k => [k, o![k]]));
const split = (sel: string) => {
	const i = sel.lastIndexOf(":");
	return i > 0 && !sel.slice(i + 1).includes("/") ? { model: sel.slice(0, i), thinking: sel.slice(i + 1) } : { model: sel, thinking: "medium" };
};

/** config.json (no secrets), state.json and IDENTITY.md. `access` is the web access the web onboarding decided; the terminal leaves it as it was. */
export function writeConfig(env: Env, a: Answers, prior: Prior, access?: "local" | "tailscale") {
	const config = {
		_comment: "Written by dotz setup.ts. Secrets live in secrets/ (0600), never here.",
		identity: a.identity,
		discord: { token_file: tokenFile(env.dir).replace(env.home, "~"), owner_id: a.owner_id, guild: a.guild, ...(prior.raw.discord?.app_id ? { app_id: prior.raw.discord.app_id } : {}) },
		// The default name is not saved: an empty web.machine_name keeps following the hostname.
		web: { ...prior.raw.web, port: a.web_port, tailscale_https_port: a.tailscale_https_port, allow_logins: a.allow_logins, ...(access ? { access } : {}), ...(a.machine_name !== prior.defaultMachineName || prior.machineName ? { machine_name: a.machine_name } : {}) },
		orchestrator: { runtime: a.runtime, ...pick(prior.raw.orchestrator, ["rotate_tokens"]) },
		lanes: { runtime: a.runtime, ...pick(prior.raw.lanes, ["max_active"]) },
		models: { ...prior.raw.models, orchestrator: { ...prior.raw.models?.orchestrator, ...split(a.orchestrator_model) }, lanes: { ...prior.raw.models?.lanes, ...split(a.lane_model) } },
	};
	writeFileSync(join(env.dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
	if (!existsSync(join(env.dir, "state.json"))) writeFileSync(join(env.dir, "state.json"), `${JSON.stringify({ open_tasks: [] }, null, 2)}\n`);
	const identityFile = join(env.dir, "identity", "IDENTITY.md");
	if (JSON.stringify(a.identity) !== JSON.stringify(prior.raw.identity ?? null) || !existsSync(identityFile)) {
		mkdirSync(join(env.dir, "identity"), { recursive: true });
		writeFileSync(identityFile, identityDoc(a.identity));
		env.say(`identity: ${identityFile}`);
	}
	env.say(`config: ${join(env.dir, "config.json")}`);
	return config;
}

/** The hub loads the dotz extension into its own OmO processes (--extension); omp is an opt-in runtime: its terminals get the plugin only when omp is installed here. */
export async function linkOmp(env: Env): Promise<boolean> {
	if ((await Bun.$`command -v omp`.nothrow().quiet()).exitCode !== 0) return false;
	const link = join(env.home, ".omp", "agent", "extensions", "dotz");
	mkdirSync(join(env.home, ".omp", "agent", "extensions"), { recursive: true });
	if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) rmSync(link, { force: true, recursive: false });
	symlinkSync(env.pkg, link);
	env.say(`omp plugin linked: ${link} -> ${env.pkg}`);
	return true;
}

/** Opens the web app on the tailnet; `ok` is true only when `tailscale serve` took it, `reason` says why not. */
export async function serveTailnet(env: Env, a: Answers, wantServe: boolean): Promise<{ tsNow: TailscaleState | undefined; ok: boolean; reason: string }> {
	const tsNow = wantServe ? await tailscaleState() : undefined;
	if (wantServe && !tsNow?.running) {
		const reason = `${tsNow?.bin ? "로그인 전이라" : "설치돼 있지 않아서"} 웹 앱을 테일넷에 아직 못 열었어요. 준비되면 bun setup.ts --tailscale 을 실행하세요.`;
		env.say(`tailscale: ${reason}`);
		return { tsNow, ok: false, reason };
	}
	if (!tsNow?.running) return { tsNow, ok: false, reason: "" };
	const r = await serveWeb(tsNow.bin, a.tailscale_https_port, a.web_port);
	const enable = r.out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
	if (r.ok) env.say(`tailscale: 웹 앱을 테일넷에 열었어요 (포트 ${a.tailscale_https_port}, 테일넷 안에서만)`);
	else if (enable) env.say(`tailscale: 이 테일넷에서 HTTPS 공유(serve)가 꺼져 있어요. 이 주소에서 한 번 켜 주고 bun setup.ts --tailscale 을 다시 실행하세요: ${enable}`);
	else env.say(`tailscale serve 실패: ${r.out}`);
	return { tsNow, ok: r.ok, reason: r.ok ? "" : (enable ?? r.out) };
}

type DiscordRun = { a: Answers; config: ReturnType<typeof writeConfig>; prior: Prior; auto: boolean; ownerStep?: () => void };

/** Creates or finds the bot through the Aside browser, invites it as administrator and checks the token. Returns true when it made a new bot token. */
export async function setupDiscord(env: Env, r: DiscordRun): Promise<boolean> {
	const { a, config, prior, auto } = r;
	const token = tokenFile(env.dir);
	let provisioned = false;
	if (!existsSync(token) && a.guild && !auto) env.say("discord: Aside CLI 가 없어서 봇을 자동으로 만들지 않아요. 개발자 포털에서 만든 봇 토큰을 setup 을 다시 실행해 붙여넣어 주세요.");
	if (!existsSync(token) && a.guild && auto) {
		const repl = new AsideRepl();
		try {
			await ensureBrowser();
			env.say(`discord: Aside로 '${a.identity.name}' 앱을 만들거나 기존 앱을 찾는 중...`);
			const appId = prior.raw.discord?.app_id ?? (await createApp(a.identity.name));
			config.discord = { ...config.discord, app_id: appId } as typeof config.discord;
			writeFileSync(join(env.dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
			r.ownerStep?.();
			const fresh = await resetToken(repl, appId, msg => env.say(`discord: ${msg}`));
			writeSecret(token, fresh);
			env.say("discord: 봇 토큰을 secrets/ 에 저장했어요 (화면에 표시 안 함)");
			await invite(repl, appId, a.guild, fresh, msg => env.say(`discord: ${msg}`));
			env.say("discord: 봇이 서버에 들어왔어요");
			provisioned = true;
		} catch (error) {
			env.say(`discord: 자동 설정이 멈췄어요: ${(error as Error).message}. setup 을 다시 실행하면 이어서 해요.`);
		} finally {
			await repl.close();
		}
	}
	await checkBot(env, r);
	return provisioned;
}

async function checkBot(env: Env, { a, auto, ownerStep }: DiscordRun): Promise<void> {
	const file = tokenFile(env.dir);
	const token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
	if (!token) return void (a.guild && env.say("discord: 아직 봇 토큰이 없어요. 웹 앱과 터미널로는 지금도 쓸 수 있어요."));
	const me = await fetch("https://discord.com/api/v10/oauth2/applications/@me", { headers: { Authorization: `Bot ${token}` } });
	if (!me.ok) return void env.say(`discord: 토큰이 거절됐어요 (${me.status}). secrets/discord-bot-token 을 지우고 setup 을 다시 실행하세요.`);
	const app = (await me.json()) as { id: string; name: string };
	// Every install runs the bot as server administrator; an older install invited with fewer rights is re-authorized.
	if (a.guild && !(await isAdmin(token, a.guild))) {
		const url = `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot&permissions=${PERMISSIONS}&guild_id=${a.guild}&disable_guild_select=true`;
		if (!auto) env.say(`discord: 봇에 관리자 권한이 없어요. 이 주소로 다시 승인해 주세요: ${url}`);
		else {
			const repl = new AsideRepl();
			try {
				await ensureBrowser();
				env.say("discord: 봇에 관리자 권한을 주도록 Aside로 다시 승인해요...");
				ownerStep?.();
				await invite(repl, app.id, a.guild, token, msg => env.say(`discord: ${msg}`));
				env.say("discord: 봇이 서버 관리자 권한을 갖게 됐어요");
			} catch (error) {
				env.say(`discord: 관리자 권한 승인이 멈췄어요 (${(error as Error).message}). 이 주소로 직접 승인해 주세요: ${url}`);
			} finally {
				await repl.close();
			}
		}
	} else env.say("discord: 봇 확인됨 (서버 관리자 권한)");
	env.say("discord: 개발자 포털 > Bot > Privileged Gateway Intents > MESSAGE CONTENT 가 켜져 있어야 해요.");
}
