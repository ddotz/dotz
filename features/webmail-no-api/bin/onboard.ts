// The one command behind "use this mail": bun onboard.ts <site> --url <inbox URL> [--channel ch:<id>] [--approve] [--har <file>]
// [--restart] | --status. Runs lib/onboard.ts with the live Io: the owner's Aside browser in the background only (a tab that
// is never focused and is closed at once; Aside itself is started hidden if it is not running), the browser's saved
// password through `aside exec` (no secret ever goes into a prompt), the local gateway for the watches and the one
// evolving progress message. Exit 0 done, 3 waiting for the owner (the printed ask), 1 failed (the printed reason).
import { blockedByFeatures } from "../../../hub/featuredirs.ts";
import { dataDir, liveCtx } from "../lib/config.ts";
import { cookieHeaderFromAside } from "../lib/cookies.ts";
import { liveGateway } from "../lib/gateway.ts";
import { loadOnboard, render, runOnboard, type Io, type LoginResult } from "../lib/onboard.ts";
import { readRecording, recordViaAside } from "./capture.ts";

async function run(argv: string[], ms: number): Promise<string> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(9), ms);
	const out = await new Response(proc.stdout).text().catch(() => "");
	await proc.exited;
	clearTimeout(timer);
	return out;
}

async function asideReady(): Promise<boolean> {
	if (!Bun.which("aside")) return false;
	const running = (await run(["pgrep", "-x", "Aside"], 5_000)).trim();
	if (!running) await run(["open", "-g", "-j", "-a", "Aside"], 15_000);
	return true;
}

async function loginState(url: string): Promise<"in" | "form" | "unknown"> {
	const code = `const pg = await openTab(${JSON.stringify(url)});
try {
	await new Promise((r) => setTimeout(r, 4000));
	const s = await pg.evaluate(() => ({ pw: !!document.querySelector('input[type=password]'), href: location.href }));
	console.log('WM_LOGIN ' + (s.pw ? 'form' : 'in'));
} finally { await closeTab(pg).catch(() => {}); }`;
	const out = await run(["aside", "repl", code], 45_000);
	const m = out.match(/WM_LOGIN (form|in)/);
	return m ? (m[1] as "form" | "in") : "unknown";
}

// Aside's own agent signs in with the password the browser saved for the site. It is told to stay in the background, to
// stop before any second factor unless the owner already said OK, and to answer with one marker word.
async function login(url: string, allowSecondFactor: boolean): Promise<LoginResult> {
	const task = [
		`Open ${url} in a new background tab. Do not focus, raise or switch to any window or tab.`,
		"Sign in using the password this browser has saved for that site. Never type a password that is not saved in the browser.",
		allowSecondFactor
			? "If a second factor (code, app approval, security key) is needed, request it once and wait up to 3 minutes for the owner to approve it; do not request it again."
			: "If the site asks for a second factor (code, app approval, security key), stop before requesting it.",
		"Close the tab you opened. Reply with exactly one word: LOGIN_OK when the mailbox is visible, NEED_2FA if a second factor is needed and was not completed, NEED_PASSWORD if no saved password exists, LOGIN_FAILED otherwise.",
	].join(" ");
	const out = await run(["aside", "exec", task], allowSecondFactor ? 300_000 : 180_000);
	if (/LOGIN_OK/.test(out)) return "in";
	if (/NEED_2FA/.test(out)) return "need-2fa";
	if (/NEED_PASSWORD/.test(out)) return "need-password";
	return "failed";
}

function liveIo(site: string, channel?: string): Io {
	return {
		ctx: liveCtx(cookieHeaderFromAside),
		mailElsewhere: () => blockedByFeatures(dataDir(), "zele mail list")?.reason,
		asideReady,
		loginState,
		login,
		record: recordViaAside,
		gateway: liveGateway,
		progress: async (text) => {
			await liveGateway("POST", "/api/send", { target: channel ?? "chat", update_key: `webmail-onboard-${site}`, text });
		},
	};
}

async function main(argv: string[]): Promise<number> {
	const site = argv[0] ?? "";
	const get = (flag: string) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
	if (!site || site.startsWith("--")) {
		console.log("사용법: onboard.ts <site> --url <받은메일함 URL> [--channel ch:<id>] [--approve] [--har <파일>] [--restart] | <site> --status");
		return 1;
	}
	if (argv.includes("--status")) {
		const s = loadOnboard(site);
		console.log(s ? render(s) : `${site}: 연결을 시작한 적이 없어요`);
		return 0;
	}
	const har = get("--har");
	const channel = get("--channel") ?? loadOnboard(site)?.channel;
	const res = await runOnboard(liveIo(site, channel), { site, url: get("--url"), channel, approve: argv.includes("--approve"), restart: argv.includes("--restart"), ...(har ? { har: readRecording(har) } : {}) });
	console.log(render(res.state));
	console.log(`WEBMAIL_ONBOARD ${res.status}${res.step ? ` ${res.step}` : ""}`);
	if (res.status === "waiting") console.log(`다음: 위 질문을 오너에게 한 번에 묻고, 답을 받으면 같은 명령에 --approve를 붙여 다시 실행해요`);
	if (res.status === "failed") console.log("다음: 원인을 오너에게 알리고, 고친 뒤 같은 명령을 다시 실행하면 멈춘 단계부터 이어서 해요");
	return res.status === "done" ? 0 : res.status === "waiting" ? 3 : 1;
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
