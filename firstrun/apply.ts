import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Answers, identityDoc, type Prior, splitSelector } from "./answers.ts";
import { writeAtomic } from "./atomic.ts";
import { ompAgentDir } from "../hub/omp-dirs.ts";
import { saveWebAccessInput } from "../hub/web-access-input.ts";
import { tailscaleState, type TailscaleState } from "../onboard/tailscale.ts";

async function serveWeb(bin: string, httpsPort: number, localPort: number): Promise<{ ok: boolean; out: string }> {
	const r = await Bun.$`${bin} serve --bg --https=${httpsPort} http://127.0.0.1:${localPort}`.nothrow().quiet();
	return { ok: r.exitCode === 0, out: `${r.stdout.toString()}\n${r.stderr.toString()}`.trim() };
}

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

const diskConfig = (dir: string, fallback: Record<string, any>): Record<string, any> => (existsSync(join(dir, "config.json")) ? JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) : fallback);

/** config.json (no secrets), state.json and IDENTITY.md. `access` overrides the web access the answers chose (the web onboarding decides it itself). */
export function writeConfig(env: Env, a: Answers, prior: Prior, access?: "local" | "tailscale") {
	const disk = diskConfig(env.dir, prior.raw);
	const chosen = access ?? (a.access === "cloudflare" ? (prior.access === "cloudflare" ? "cloudflare" : "local") : a.access);
	const config = {
		...disk,
		_comment: disk._comment ?? "Written by dotz setup.ts. Secrets live in secrets/ (0600), never here.",
		identity: a.identity,
		discord: { ...disk.discord, token_file: !a.bot_token && typeof disk.discord?.token_file === "string" ? disk.discord.token_file : tokenFile(env.dir).replace(env.home, "~"), owner_id: a.owner_id, guild: a.guild },
		web: { ...disk.web, port: a.web_port, tailscale_https_port: a.tailscale_https_port, allow_logins: a.allow_logins, access: chosen, ...(a.machine_name !== prior.defaultMachineName || prior.machineName ? { machine_name: a.machine_name } : {}) },
		orchestrator: { ...disk.orchestrator, runtime: a.runtime },
		lanes: { ...disk.lanes, runtime: a.runtime },
		models: { ...disk.models, orchestrator: { ...disk.models?.orchestrator, ...splitSelector(a.orchestrator_model) }, lanes: { ...disk.models?.lanes, ...splitSelector(a.lane_model) } },
	};
	writeAtomic(join(env.dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
	if (a.access === "cloudflare" && a.cloudflare_hostname) saveWebAccessInput(env.dir, { hostname: a.cloudflare_hostname });
	if (!existsSync(join(env.dir, "state.json"))) writeAtomic(join(env.dir, "state.json"), `${JSON.stringify({ open_tasks: [] }, null, 2)}\n`);
	const identityFile = join(env.dir, "identity", "IDENTITY.md");
	if (JSON.stringify(a.identity) !== JSON.stringify(prior.raw.identity ?? null) || !existsSync(identityFile)) {
		mkdirSync(join(env.dir, "identity"), { recursive: true });
		writeAtomic(identityFile, identityDoc(a.identity));
		env.say(`identity: ${identityFile}`);
	}
	env.say(`config: ${join(env.dir, "config.json")}`);
	return config;
}

/** The hub loads the dotz extension into its own OmO processes (--extension); omp terminals get the plugin when omp is installed here. */
export async function linkOmp(env: Env): Promise<boolean> {
	if ((await Bun.$`command -v omp`.nothrow().quiet()).exitCode !== 0) return false;
	const extensions = join(ompAgentDir(process.env, env.home), "extensions");
	const link = join(extensions, "dotz");
	mkdirSync(extensions, { recursive: true });
	const found = lstatSync(link, { throwIfNoEntry: false });
	if (found && !found.isSymbolicLink()) {
		env.say(`omp plugin: ${link} is your own folder or file, so it was left alone. To use dotz there, link ${env.pkg} into it yourself.`);
		return false;
	}
	if (found) rmSync(link, { force: true });
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
