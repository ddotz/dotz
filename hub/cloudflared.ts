import { existsSync, readFileSync, statSync } from "node:fs";
import { log } from "./config.ts";

// One `cloudflared tunnel run` child for the web app in web.access = "cloudflare" mode. The token stays in a 0600 file that cloudflared reads
// itself (--token-file): it is never on the command line, in the environment or in a log line.

export type TunnelStatus = { state: "off" | "starting" | "running" | "error"; error?: string };
// `login`: the Cloudflare Access settings. Without a team, an AUD tag and at least one allowed login the tunnel is not started, so the web app is
// never on the internet without Access in front of it.
export type TunnelOpts = { tokenFile: string; login: { team?: string; aud?: string; allow: readonly string[] }; bin?: string; spawn?: typeof Bun.spawn };
const NO_ACCESS_HINT = "Cloudflare Access 설정이 비어 있어 터널을 열지 않았습니다. web.cloudflare.team, web.cloudflare.aud, web.allow_logins를 채우십시오 (docs/web-access-cloudflare.ko.md)";

const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_MS = 60_000;
const MISSING_HINT = "cloudflared를 찾을 수 없습니다. `brew install cloudflared` 로 설치한 뒤 게이트웨이를 다시 시작해 주세요 (docs/web-access-cloudflare.ko.md)";

let status: TunnelStatus = { state: "off" };
let child: ReturnType<typeof Bun.spawn> | undefined;
let timer: Timer | undefined;
let wanted = false;

/** The tunnel's state for the settings screen. */
export const tunnelStatus = (): TunnelStatus => status;

const binary = (): string | undefined => process.env.DOTZ_CLOUDFLARED_BIN || Bun.which("cloudflared") || undefined;

export function startTunnel(opts: TunnelOpts): void {
	stopTunnelNow();
	if (!opts.login.team?.trim() || !opts.login.aud?.trim() || !opts.login.allow.some(s => s.trim())) {
		status = { state: "error", error: NO_ACCESS_HINT };
		return log(`web: ${NO_ACCESS_HINT}`);
	}
	const bin = opts.bin ?? binary();
	if (!bin) {
		status = { state: "error", error: MISSING_HINT };
		return log(`web: ${MISSING_HINT}`);
	}
	if (!existsSync(opts.tokenFile)) {
		status = { state: "error", error: `터널 토큰 파일이 없습니다: ${opts.tokenFile}` };
		return log(`web: ${status.error}`);
	}
	if (statSync(opts.tokenFile).mode & 0o077) log(`web: ${opts.tokenFile} is readable by other users; run chmod 600 on it`);
	const token = readFileSync(opts.tokenFile, "utf8").trim();
	const spawn = opts.spawn ?? Bun.spawn;
	wanted = true;
	let delay = BACKOFF_MIN_MS;

	const run = (): void => {
		timer = undefined;
		status = { state: "starting" };
		const startedAt = Date.now();
		let last = "";
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = spawn([bin, "tunnel", "--no-autoupdate", "run", "--token-file", opts.tokenFile], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		} catch (e) {
			status = { state: "error", error: `cloudflared를 시작하지 못했습니다: ${String(e).slice(0, 200)}` };
			return void schedule();
		}
		child = proc;
		status = { state: "running" };
		void (async () => {
			const lines = proc.stderr instanceof ReadableStream ? proc.stderr : undefined;
			if (lines) {
				const decoder = new TextDecoder();
				let buf = "";
				for await (const chunk of lines) {
					buf += decoder.decode(chunk, { stream: true });
					const parts = buf.split("\n");
					buf = parts.pop() ?? "";
					for (const line of parts) if (/\b(ERR|FTL)\b/.test(line)) last = (token.length > 8 ? line.replaceAll(token, "[token]") : line).slice(0, 300);
				}
			}
		})().catch(() => void 0);
		void proc.exited.then(code => {
			if (child === proc) child = undefined;
			if (!wanted) return;
			if (Date.now() - startedAt >= STABLE_MS) delay = BACKOFF_MIN_MS;
			status = { state: "error", error: `cloudflared가 종료되었습니다 (코드 ${code})${last ? `: ${last}` : ""}` };
			log(`web: ${status.error}; restart in ${delay / 1000}s`);
			schedule();
		});
	};
	const schedule = (): void => {
		if (!wanted) return;
		timer = setTimeout(run, delay);
		timer.unref();
		delay = Math.min(delay * 2, BACKOFF_MAX_MS);
	};
	run();
}

function stopTunnelNow(): ReturnType<typeof Bun.spawn> | undefined {
	wanted = false;
	if (timer) clearTimeout(timer);
	timer = undefined;
	const proc = child;
	child = undefined;
	proc?.kill();
	status = { state: "off" };
	return proc;
}

/** Shutdown step: stops the restart loop and the child, waiting briefly for it to exit. */
export async function stopTunnel(): Promise<void> {
	const proc = stopTunnelNow();
	if (proc) await Promise.race([proc.exited, new Promise(r => setTimeout(r, 3000))]);
}
