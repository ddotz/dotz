#!/usr/bin/env bun
// Dotz onboarding wizard (Korean, step by step), modeled on the omonyang ~/.ddotz/setup.ts and the dori-kit setup.ts.
// 1) harness: the coding-agent CLI the orchestrator and lanes run on (onboard/harness.ts; OmO by default, installed with
//    bun when missing; omp and Claude Code selectable; Codex listed, no adapter yet) and its login state
// 2) tools: Aside, Tailscale (onboard/tailscale.ts) and zele. 3) bot identity: name, character, tone, notices, how to address the owner, optional avatar
//    -> ~/.dotz/identity/IDENTITY.md (the orchestrator talks this way)
// 4) Discord: owner id, server id; the bot itself is provisioned through the Aside browser (onboard/discord.ts) unless a
//    token is pasted; the owner only approves Discord's 2FA prompt. 5) web app access (Tailscale, optional). Advanced: ports and models.
// Writes ~/.dotz/config.json (no secrets), secrets/ (0600), links the plugin into omp only when omp is installed (OmO gets
// the extension from the gateway with --extension), writes the service file (launchd plist on macOS, systemd user unit on
// Linux; onboard/service.ts); starts it only with --load, runs tailscale serve only with --tailscale, opens the web app
// only with --open. An interactive run with web logins also runs tailscale serve. Re-running keeps every answer as the default.
//   bun setup.ts [--answers answers.json] [--load] [--tailscale] [--open] [--no-discord-auto] [--dir ~/.dotz]
// Onboarding ends with the macOS permissions step (onboard/permissions.ts): bun is what launchd runs, so the prompts and
// the Settings entries are for bun. Interactive runs and `permissions` turn what they can on themselves (prompts, panes, switches);
// only a step macOS keeps for a person is printed, once. --answers runs only print the state. Standalone, safe to rerun:
//   bun setup.ts permissions [--check]     (--check only prints the state, never raises a dialog; exit 3 = an owner step is left)
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { asideState, installApp, installCli, loginCli, openApp } from "./onboard/aside.ts";
import { AsideRepl, createApp, ensureBrowser, invite, isAdmin, PERMISSIONS, resetToken } from "./onboard/discord.ts";
import { defaultHarness, detectHarnesses, type Detected, harness, harnessLine, HARNESSES, loginState } from "./onboard/harness.ts";
import { checkPermissions, printPermissions, requestPermissions } from "./onboard/permissions.ts";
import { installTailscale, serveWeb, startTailscale, tailscaleState } from "./onboard/tailscale.ts";
import { LABEL, serviceFile, servicePath, UNIT } from "./onboard/service.ts";
import { detectLanguage, languageName } from "./hub/language.ts";
import { cleanName, friendlyName, MAX_NAME } from "./hub/machine-name.ts";

const HOME = homedir();
const PKG = import.meta.dir;
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
const DIR = expandHome(opt("--dir") ?? join(HOME, ".dotz"));
const MAC = process.platform === "darwin";
const PLIST = servicePath({ home: HOME });
const TOKEN_FILE = join(DIR, "secrets", "discord-bot-token");
// The key every gateway of this owner shares, so 모니터링 shows all computers together and an action runs on the computer that owns
// the item (docs/peer-monitoring.md). The first computer makes it; the others take the same value.
const PEER_TOKEN_FILE = join(DIR, "secrets", "peer-token");
const IDENTITY_FILE = join(DIR, "identity", "IDENTITY.md");
const SNOWFLAKE = /^\d{17,20}$/;

type Identity = { name: string; character: string; tone: string; notices?: string; address?: string; avatar?: string; language?: string };
type Answers = {
	identity: Identity;
	owner_id: string;
	guild: string;
	bot_token?: string;
	allow_logins: string[];
	machine_name: string;
	peer_token?: string;
	web_port: number;
	tailscale_https_port: number;
	orchestrator_model: string;
	lane_model: string;
	install_aside?: boolean;
	runtime: string;
	install_harness?: boolean;
};

const prior = existsSync(join(DIR, "config.json")) ? JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")) : {};
// Model settings live in `models` (hub/config.ts).
const priorSelector = (t: "orchestrator" | "lanes") => `${prior.models?.[t]?.model ?? "anthropic/claude-opus-5-5"}:${prior.models?.[t]?.thinking ?? "medium"}`;
// This computer's name in the web app's computer list: the saved one, else the hostname-derived default (hub/machine-name.ts).
const defaultMachineName = friendlyName(hostname());
const priorMachineName = cleanName(prior.web?.machine_name);
const priorIdentity: Identity = { name: "", character: "", tone: "", ...prior.identity };

const CHARACTERS = [
	"차분하고 믿음직한 개인 비서. 먼저 결과를 말하고 필요한 것만 묻는다.",
	"장난기 있지만 일은 확실한 친구 같은 조수. 가볍게 말하되 사실은 정확하게.",
	"꼼꼼한 엔지니어. 근거와 검증을 먼저 챙기고 불확실하면 그렇다고 말한다.",
];
// The first entry of each list is the default (Enter). Examples are everyday errands, not the author's own projects.
const TONES = [
	"편한 해요체로 이어지는 대화. 상대 말에 바로 이어서 자연스러운 문장으로 답하고, 정해진 시작말이나 '한 줄 결론 + 불릿' 틀을 매번 쓰지 않음. 목록은 보고와 선택지에만. 근거와 숫자는 구체적으로. 이모지 없음 (예: \"확인해 봤어요. 내일 회의가 10시에서 11시로 바뀌어서 일정도 같이 옮겨 뒀어요.\")",
	"반말, 친근하고 짧게 (예: \"응, 끝났어. 메일도 보냈어\")",
	"존댓말, 간결하게 (예: \"네, 끝났어요. 메일도 보냈어요\")",
	"존댓말, 정중하게 (예: \"완료했습니다. 메일도 발송했습니다\")",
];
// Style of notices (작업로그, 알림), from everyday speech to ASD-STE100; MODE.md defines each level.
const NOTICES = [
	"일상: 평소 말투 그대로, 관련 내용을 짧게 (예: \"자료 정리 끝났어요. 빠진 파일 없고 남은 일 없어요.\")",
	"간결: 해요체 평서문, 한 문장에 사실 하나, 군말 없이 (예: \"자료 정리를 마쳤어요. 빠진 파일은 없어요. 남은 일은 없어요.\")",
	"STE 80%: ASD-STE100 규칙(짧은 문장, 능동태, 정해진 용어, 절차는 번호 단계)을 80% 강도로, 합니다체. 강도는 'STE 100%'처럼 바꿀 수 있음 (예: \"자료 정리를 완료했습니다. 빠진 파일이 없습니다. 남은 작업은 없습니다.\")",
];

function ask(q: string, def = "", required = true): string {
	for (;;) {
		const v = (prompt(`  ${q}${def ? ` [${def}]` : ""}:`) ?? "").trim() || def;
		if (v || !required) return v;
		console.log("    (꼭 필요한 값이에요)");
	}
}

function askValid(q: string, def: string, ok: (v: string) => boolean, hint: string, required = true): string {
	for (;;) {
		const v = ask(q, def, required);
		if ((!v && !required) || ok(v)) return v;
		console.log(`    ${hint}`);
	}
}

function choose(q: string, options: string[], current: string): string {
	console.log(`  ${q}`);
	options.forEach((o, i) => console.log(`    ${i + 1}) ${o}`));
	console.log(`    ${options.length + 1}) 직접 입력`);
	const strip = (o: string) => o.replace(/\s*\(예:.*\)$/, "");
	const keep = current && !options.map(strip).includes(current) ? current : "";
	const def = keep || current || strip(options[0]);
	console.log(`    Enter) ${keep ? `지금 값 유지: ${keep}` : current ? "지금 값 유지" : "1번 (기본)"}`);
	for (;;) {
		const v = (prompt("  번호 (Enter = 기본/유지):") ?? "").trim();
		if (!v) return def;
		const n = Number(v);
		if (n >= 1 && n <= options.length) return strip(options[n - 1]);
		if (n === options.length + 1) return ask("한 줄로 적어 주세요");
		console.log(`    1~${options.length + 1} 중에서 골라 주세요`);
	}
}

function secret(q: string): string {
	const tty = process.stdin.isTTY;
	if (tty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
	try {
		return (prompt(`  ${q}:`) ?? "").trim();
	} finally {
		if (tty) {
			Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
			console.log("");
		}
	}
}

async function tailnetUrl(port: number): Promise<string> {
	const { host } = await tailscaleState();
	return host ? `https://${host}${port === 443 ? "" : `:${port}`}/` : "";
}

// Step 2 with Aside: install Tailscale when missing and get it signed in, so step 5 finds the login and the web app opens.
async function prepareTailscale(interactiveRun: boolean): Promise<void> {
	let s = await tailscaleState();
	if (!s.bin) {
		console.log("  Tailscale 이 없어요. 휴대폰이나 다른 컴퓨터에서 웹 앱을 열 때 Tailscale 을 써요.");
		if (interactiveRun && !/^n/i.test(ask(`  지금 설치할까요? (${MAC ? "Homebrew: brew install --cask tailscale-app" : "tailscale.com/install.sh"}) Y/n`, "y"))) {
			if (!(await installTailscale())) ask("  브라우저에서 tailscale.com/download 를 열었어요. 설치를 마치면 Enter", "", false);
			s = await tailscaleState();
		}
	}
	while (interactiveRun && s.bin && !s.running) {
		console.log("  Tailscale 에 로그인이 안 돼 있어요. Tailscale 을 열 테니 로그인해 주세요 (휴대폰에서도 같은 계정으로 로그인하면 웹 앱을 열 수 있어요).");
		await startTailscale(s.bin);
		if (ask("  로그인을 마치면 Enter, 나중에 하려면 s", "", false).toLowerCase() === "s") break;
		s = await tailscaleState();
	}
	if (s.running) console.log(`  Tailscale 준비 완료: ${s.login} (${s.host})`);
	else if (s.bin) console.log(`  Tailscale 이 아직 로그인 전이에요${s.error ? ` (${s.error})` : ""}. 로그인 후 setup 을 다시 실행하면 웹 앱이 켜져요.`);
	else console.log("  Tailscale 없이 진행해요. 웹 앱은 이 컴퓨터(127.0.0.1)에서만 열려요.");
}

// Step 1 of the wizard: the Aside app, its CLI and the CLI sign-in. Interactive runs ask before installing; --answers
// runs install only with install_aside: true and otherwise print what is missing (sign-in always needs the owner).
async function prepareAside(interactiveRun: boolean, autoInstall = false): Promise<void> {
	let s = await asideState();
	const yes = (q: string) => interactiveRun ? !/^n/i.test(ask(`${q} Y/n`, "y")) : autoInstall;
	if (!s.app) {
		console.log("  Aside 앱이 없어요. 봇 자동 생성, 로그인 유지, 웹 작업을 모두 Aside로 해요.");
		if (yes("  지금 설치할까요? (Homebrew: brew install --cask aside)")) {
			if (!(await installApp()) && interactiveRun) ask("  브라우저에서 aside.com/download 을 열었어요. 설치를 마치면 Enter", "", false);
		}
	}
	if ((await asideState()).app) {
		await openApp();
		if (interactiveRun && !s.app) ask("  Aside 앱이 열렸어요. 계정으로 로그인하고 쓰는 사이트에 로그인해 두면 Enter", "", false);
	}
	s = await asideState();
	if (!s.cli && yes("  Aside CLI(aside 명령)가 없어요. 지금 설치할까요? (curl -fsSL https://releases.aside.com/install.sh | bash)")) await installCli();
	s = await asideState();
	if (s.cli && !s.signedIn) {
		if (interactiveRun && yes("  Aside CLI 로그인이 필요해요. 지금 할까요?")) {
			console.log("  Aside CLI 로그인: 아래에 나오는 코드를 Aside 앱 설정 > 계정 > 기기에서 승인해 주세요.");
			await loginCli(s.cli);
		} else if (interactiveRun) console.log(`  나중에 ${s.cli} login 으로 로그인하면 돼요.`); else console.log(`  Aside CLI 로그인이 필요해요: ${s.cli} login (Aside 앱 설정 > 계정 > 기기에서 승인)`);
		s = await asideState();
	}
	const missing = [!s.app && "Aside 앱 (brew install --cask aside 또는 aside.com/download)", !s.cli && "Aside CLI (curl -fsSL https://releases.aside.com/install.sh | bash)", s.cli && !s.signedIn && "CLI 로그인 (aside login)"].filter(Boolean);
	if (missing.length) console.log(`  아직 없는 것: ${missing.join(", ")}. 봇 자동 생성과 로그인 유지는 준비되면 동작해요. 설치 후 setup 을 다시 실행하면 이어서 해요.`);
	else console.log(`  Aside 준비 완료: 앱, CLI (${s.cli}), 로그인 ${s.account}`);
}

// Mail and calendar run through zele (long-lived Gmail/IMAP/Calendar tokens). Install with bun; connecting an account is
// zele's own login flow, which the owner approves in the browser (Google/Outlook) or with an app password (IMAP).
async function zeleAccounts(): Promise<string[]> {
	if (!Bun.which("zele")) return [];
	const out = (await Bun.$`zele whoami`.nothrow().quiet()).stdout.toString();
	return /not authenticated/i.test(out) ? [] : [...new Set(out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])];
}

async function prepareZele(interactiveRun: boolean, autoInstall = false): Promise<void> {
	const run = async (cmd: string[]) => (await Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited) === 0;
	const yes = (q: string, def = "y") => (interactiveRun ? !/^n/i.test(ask(`${q} ${def === "y" ? "Y/n" : "y/N"}`, def)) : autoInstall);
	if (!Bun.which("zele") && yes("  메일·일정 도구 zele 가 없어요. 지금 설치할까요? (bun add -g zele)")) await run(["bun", "add", "-g", "zele"]);
	if (!Bun.which("zele")) return void console.log("  zele 없이 진행해요. 메일·일정 감시는 꺼져 있어요 (나중에 bun add -g zele).");
	let accounts = await zeleAccounts();
	console.log(`  zele 계정: ${accounts.join(", ") || "없음"}`);
	while (interactiveRun && yes(accounts.length ? "  메일·캘린더 계정을 하나 더 연결할까요? (Google·Outlook·네이버 등 IMAP)" : "  메일·캘린더 계정을 연결할까요? (Google·Outlook·네이버 등 IMAP)", accounts.length ? "n" : "y")) {
		console.log("  zele login 을 시작해요. Google·Outlook 은 브라우저에서 승인, 네이버 같은 IMAP 은 메일 설정의 앱 비밀번호를 써요.");
		await run(["zele", "login"]);
		accounts = await zeleAccounts();
		console.log(`  zele 계정: ${accounts.join(", ") || "없음"}`);
	}
	if (!interactiveRun && !accounts.length) console.log("  zele 계정이 없어요: zele login 으로 연결하면 게이트웨이가 다음 재시작부터 메일·일정을 봐요.");
}

const priorRuntime = (prior.orchestrator?.runtime ?? prior.lanes?.runtime ?? prior.runtime) as string | undefined;

// Step 1: shows every harness with its install state, lets the user pick one dotz has an adapter for, installs OmO when
// it is the pick and missing (interactive: asked; --answers: only with install_harness), then checks the login.
async function prepareHarness(interactiveRun: boolean, pick?: string, autoInstall = false): Promise<string> {
	let found = await detectHarnesses();
	const def = defaultHarness(pick ?? priorRuntime);
	let id = def;
	if (interactiveRun) {
		console.log("  봇의 오케스트레이터와 세션(프로젝트 작업)이 돌아갈 코딩 에이전트예요. 기본은 OmO 예요.");
		found.forEach((d, i) => console.log(`    ${i + 1}) ${harnessLine(d, d.id === def)}`));
		for (;;) {
			const v = (prompt("  번호 (Enter = 기본):") ?? "").trim();
			const d = v ? found[Number(v) - 1] : harness(def);
			if (d?.adapter) {
				id = d.id as typeof id;
				break;
			}
			console.log(d ? `    ${d.label}: ${d.installHint}. 다른 번호를 골라 주세요.` : `    1~${found.length} 중에서 골라 주세요`);
		}
	}
	const chosen = () => found.find(d => d.id === id) as Detected;
	if (!chosen().found.installed) {
		const h = chosen();
		const yes = h.install && (interactiveRun ? !/^n/i.test(ask(`  ${h.label} 가 없어요. 지금 설치할까요? (${h.installHint}) Y/n`, "y")) : autoInstall);
		if (yes && h.install) {
			await Bun.spawn(h.install, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
			// A fresh bun install's global bin folder is often not on PATH yet (bun add -g only warns about it).
			const globalBin = (await Bun.$`bun pm bin -g`.nothrow().quiet()).stdout.toString().trim();
			if (globalBin && !(process.env.PATH ?? "").split(":").includes(globalBin)) process.env.PATH = `${globalBin}:${process.env.PATH ?? ""}`;
			found = await detectHarnesses();
		}
		if (!chosen().found.installed) console.log(`  ${h.label} 가 아직 없어요: ${h.installHint}. 설치 전에는 게이트웨이가 에이전트를 띄우지 못해요. 설치 후 setup 을 다시 실행하세요.`);
	}
	const d = chosen();
	if (d.found.installed) {
		let login = await loginState(d);
		while (interactiveRun && login.checked && !login.ready) {
			console.log(`  ${d.label} 에 로그인된 계정이 없어요. ${d.loginHint} (명령을 못 찾으면 전체 경로로: ${d.found.path})`);
			if (ask("  다른 터미널에서 로그인한 다음 Enter, 나중에 하려면 s", "", false).toLowerCase() === "s") break;
			login = await loginState(d);
		}
		console.log(`  하네스: ${d.label} ${d.found.version ?? ""} (${d.found.path})${login.checked ? (login.ready ? `, 로그인된 계정 ${login.accounts}개` : `, 로그인 필요: ${d.loginHint}`) : `. 로그인이 안 돼 있으면: ${d.loginHint}`}`);
	}
	return id;
}

async function interactive(): Promise<Answers> {
	console.log("\n봇 온보딩을 시작합니다. 대괄호 [ ] 안의 값은 Enter로 그대로 쓸 수 있어요.\n");
	console.log("1/5 하네스");
	const runtime = await prepareHarness(true);
	console.log("\n2/5 도구 준비: 봇이 쓰는 Aside 브라우저, 웹 앱 접속용 Tailscale, 메일·일정 도구(zele)를 확인하고, 없으면 설치해요.");
	if (MAC) await prepareAside(true);
	else console.log("  Aside 는 macOS 앱이라 건너뛰어요. 봇 자동 생성 대신 디스코드 봇 토큰을 붙여넣어 주세요.");
	await prepareTailscale(true);
	await prepareZele(true);

	console.log("\n3/5 봇 정체성: 이름, 성격, 말투, 호칭. 봇은 디스코드, 웹, 터미널 어디서나 이 성격과 말투로 대답해요.");
	if (!priorIdentity.name) console.log("  먼저 봇의 이름을 지어 주세요. 디스코드 봇 이름, 카테고리, '<이름>모드 켜' 문구가 모두 이 이름을 써요.");
	const name = askValid("봇 이름 (2~32자, 예: 루미, 모모, 비서)", priorIdentity.name, v => v.length >= 2 && v.length <= 32, "2~32자로 적어 주세요");
	const character = choose("성격을 골라 주세요", CHARACTERS, priorIdentity.character);
	const tone = choose("말투를 골라 주세요", TONES, priorIdentity.tone);
	const notices = choose("작업로그·알림 문체를 골라 주세요 (나중에 대화에서 '알림 문체 STE로'처럼 바꿀 수 있어요)", NOTICES, priorIdentity.notices ?? "");
	const address = ask("봇이 주인을 부르는 호칭 (예: 형, 대표님, 이름. 없으면 Enter: 호칭 없이 말해요)", priorIdentity.address ?? "", false);
	const avatar = askValid("프로필 이미지 파일 경로 (png/jpg, 없으면 Enter)", priorIdentity.avatar ?? "", v => existsSync(expandHome(v)), "그 경로에 파일이 없어요", false);

	console.log("\n4/5 디스코드. ID는 디스코드 설정 > 고급 > 개발자 모드를 켠 뒤, 내 프로필이나 서버 이름을 우클릭 > 'ID 복사'로 얻어요.");
	const guild = askValid("봇이 들어갈 서버 ID (디스코드 없이 웹/터미널만 쓰려면 Enter)", prior.discord?.guild ?? "", v => SNOWFLAKE.test(v), "17~20자리 숫자여야 해요", false);
	const owner_id = guild ? askValid("내 디스코드 사용자 ID (이 계정의 말만 명령으로 들어요)", prior.discord?.owner_id ?? "", v => SNOWFLAKE.test(v), "17~20자리 숫자여야 해요") : "";
	let bot_token = "";
	if (guild && !existsSync(TOKEN_FILE)) {
		console.log("  봇은 Aside 브라우저로 자동으로 만들어요 (디스코드 2단계 인증 승인만 해 주시면 돼요).");
		bot_token = secret("이미 만든 봇 토큰이 있으면 붙여넣기 (화면에 안 보여요, 자동 생성은 Enter)");
	} else if (guild) console.log("  저장된 봇 토큰을 그대로 써요.");

	console.log("\n5/5 웹 앱 (테일넷 안에서만 열려요).");
	const ts = await tailscaleState();
	const login = (prior.web?.allow_logins ?? [])[0] ?? ts.login;
	if (!ts.bin && !login) console.log("  Tailscale 이 없어서 웹 앱은 이 컴퓨터에서만 열려요. Tailscale 을 설치한 뒤 setup 을 다시 실행하면 다른 기기에서도 열려요.");
	else if (login) console.log("  아래 로그인으로 들어오면 웹 앱이 열려요. 설정이 끝나면 테일넷에 바로 열어 둘게요.");
	const machine_name = askValid(`이 컴퓨터 이름 (웹 앱의 컴퓨터 목록에 이 이름으로 보여요, ${MAX_NAME}자까지)`, priorMachineName || defaultMachineName, v => cleanName(v).length > 0, "이름을 적어 주세요");
	let peer_token = "";
	if (!existsSync(PEER_TOKEN_FILE)) {
		for (;;) {
			peer_token = secret("다른 컴퓨터의 dotz와 모니터링을 함께 보려면 그 컴퓨터의 공유 키를 붙여넣기 (화면에 안 보여요, 이 컴퓨터가 처음이면 Enter)").trim();
			if (!peer_token || peer_token.length >= 16) break;
			console.log("  공유 키는 16자 이상이에요. 다른 컴퓨터의 ~/.dotz/secrets/peer-token 내용을 그대로 붙여넣으세요.");
		}
	}
	const allow_logins = (ts.bin || login ? ask("웹 앱에 들어올 수 있는 Tailscale 로그인 (쉼표로 여러 개, 없으면 Enter)", login, false) : "").split(",").map(s => s.trim()).filter(Boolean);

	const defaults = {
		web_port: Number(prior.web?.port ?? 7420),
		tailscale_https_port: Number(prior.web?.tailscale_https_port ?? 8443),
		orchestrator_model: priorSelector("orchestrator"),
		lane_model: priorSelector("lanes"),
	};
	const port = (v: string) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536;
	const advanced = /^y/i.test(ask("포트나 모델도 바꿀까요? y/N", "n"));
	const a: Answers = {
		runtime,
		identity: { name, character, tone, notices, ...(address ? { address } : {}), ...(avatar ? { avatar } : {}) },
		owner_id,
		guild,
		bot_token,
		allow_logins,
		machine_name: cleanName(machine_name),
		...(peer_token ? { peer_token } : {}),
		...defaults,
		...(advanced
			? {
					web_port: Number(askValid("로컬 포트", String(defaults.web_port), port, "1~65535")),
					tailscale_https_port: Number(askValid("테일넷 HTTPS 포트", String(defaults.tailscale_https_port), port, "1~65535")),
					orchestrator_model: ask(`${name} 모델:thinking`, defaults.orchestrator_model),
					lane_model: ask("세션(프로젝트 작업) 모델:thinking", defaults.lane_model),
				}
			: {}),
	};

	console.log(`\n정리하면:
  하네스 ${harness(runtime)?.label ?? runtime}
  이름 ${name} / 성격 ${character}
  말투 ${tone}
  알림 문체 ${notices}
  호칭 ${address || "(없음)"}${avatar ? `\n  프로필 이미지 ${avatar}` : ""}
  디스코드 ${guild ? `서버 ${guild}, 주인 ${owner_id}, 봇 ${existsSync(TOKEN_FILE) ? "저장된 토큰" : bot_token ? "붙여넣은 토큰" : "자동 생성"}` : "사용 안 함"}
  이 컴퓨터 이름 ${machine_name}
  웹 ${allow_logins.length ? `${allow_logins.join(", ")}, 포트 ${a.web_port} -> ${a.tailscale_https_port}` : "사용 안 함 (Tailscale 로그인 없음)"}`);
	if (/^n/i.test(ask("이대로 진행할까요? Y/n", "y"))) {
		console.log("취소했어요. 다시 실행하면 방금 값은 저장되지 않은 상태로 시작해요.");
		process.exit(1);
	}
	return a;
}

function validate(a: Partial<Answers>): Answers {
	const errors: string[] = [];
	const identity: Identity = { ...priorIdentity, ...a.identity };
	identity.character ||= CHARACTERS[0];
	identity.tone ||= TONES[0].replace(/\s*\(예:.*\)$/, "");
	identity.notices ||= NOTICES[0].replace(/\s*\(예:.*\)$/, "");
	// The gateway instructs its agents in this language (hub/i18n.ts); detected from the answers' script, else the system locale.
	identity.language ||= detectLanguage([identity.character, identity.tone, identity.notices, identity.address].filter(Boolean).join("\n"));
	if (!identity.name || identity.name.length < 2 || identity.name.length > 32) errors.push("identity.name: 2~32자");
	if (!identity.character) errors.push("identity.character: 성격 한 줄");
	if (!identity.tone) errors.push("identity.tone: 말투 한 줄");
	if (identity.avatar && !existsSync(expandHome(identity.avatar))) errors.push(`identity.avatar: 파일 없음 ${identity.avatar}`);
	const guild = String(a.guild ?? "");
	const owner = String(a.owner_id ?? "");
	if (guild && !SNOWFLAKE.test(guild)) errors.push("guild: 17~20자리 숫자");
	if (guild && !SNOWFLAKE.test(owner)) errors.push("owner_id: 17~20자리 숫자 (guild 가 있으면 필수)");
	const runtime = String(a.runtime ?? defaultHarness(priorRuntime));
	if (!harness(runtime)?.adapter) errors.push(`runtime: ${HARNESSES.filter(h => h.adapter).map(h => h.id).join(" | ")} 중 하나`);
	if (errors.length) {
		console.error(`answers 파일 오류:\n  ${errors.join("\n  ")}`);
		process.exit(1);
	}
	return {
		runtime,
		install_harness: a.install_harness === true,
		identity,
		owner_id: owner,
		guild,
		bot_token: a.bot_token,
		allow_logins: a.allow_logins ?? prior.web?.allow_logins ?? [],
		machine_name: cleanName(a.machine_name) || priorMachineName || defaultMachineName,
		...(typeof a.peer_token === "string" && a.peer_token.trim().length >= 16 ? { peer_token: a.peer_token.trim() } : {}),
		web_port: Number(a.web_port ?? prior.web?.port ?? 7420),
		tailscale_https_port: Number(a.tailscale_https_port ?? prior.web?.tailscale_https_port ?? 8443),
		orchestrator_model: a.orchestrator_model ?? priorSelector("orchestrator"),
		lane_model: a.lane_model ?? priorSelector("lanes"),
		install_aside: a.install_aside === true,
	};
}

function identityDoc(id: Identity): string {
	const code = id.language || "en";
	return `# Bot identity (written by dotz setup.ts; edit freely, re-running setup keeps this file unless the answers change)

- Name: **${id.name}**. Mode phrases: "${id.name}모드 켜" / "${id.name}모드 꺼" (also /dotz on|off).
- Character: ${id.character}
- Tone: ${id.tone}
- Notices (worklog, alert): ${id.notices}
- Language: ${code}
- Owner address: ${id.address ? `call the owner "${id.address}"; no other title` : "no title; never call the owner 사장님, 주인님 or any honorific, just talk to them"}
${id.avatar ? `- Avatar: ${id.avatar}\n` : ""}
## Voice rules
- Speak as ${id.name}, in the character and tone above, in the owner's language: ${languageName(code)} (${code}), unless they switch.
- Before writing, picture what the owner wants, the state they are in and what would actually help.
- Match the owner's length and register; short chat messages, not reports. Status is plain: what happened, the evidence,
  what the owner must decide.
- No emojis in messages, thread and channel names, except the four status emoji the gateway puts in place of a
  [done]/[run]/[ask]/[fail] marker (write the marker, not the emoji); the eyes reaction is the only read receipt.
  Times in local time (KST), never bare UTC.
`;
}

if (args[0] === "permissions") {
	const probeBun = process.execPath;
	if (flag("--check")) printPermissions(probeBun, await checkPermissions(probeBun));
	// Exit 3: a step macOS keeps for a person is left; its one exact step was printed (the bot asks it once).
	else if ((await requestPermissions(probeBun, q => ask(q, "", false))).length) process.exit(3);
	process.exit(0);
}

const answersFile = opt("--answers");
const a = validate(answersFile ? JSON.parse(readFileSync(answersFile, "utf8")) : await interactive());
if (answersFile) {
	await prepareHarness(false, a.runtime, a.install_harness === true);
	if (MAC) await prepareAside(false, a.install_aside === true);
	await prepareZele(false, a.install_aside === true);
}
const pick = (o: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(keys.filter(k => o?.[k] != null).map(k => [k, o![k]]));
const split = (sel: string) => {
	const i = sel.lastIndexOf(":");
	return i > 0 && !sel.slice(i + 1).includes("/") ? { model: sel.slice(0, i), thinking: sel.slice(i + 1) } : { model: sel, thinking: "medium" };
};

mkdirSync(join(DIR, "secrets"), { recursive: true });
chmodSync(join(DIR, "secrets"), 0o700);
if (a.bot_token) {
	writeFileSync(TOKEN_FILE, `${a.bot_token.trim()}\n`);
	chmodSync(TOKEN_FILE, 0o600);
}
if (a.peer_token || !existsSync(PEER_TOKEN_FILE)) {
	writeFileSync(PEER_TOKEN_FILE, `${a.peer_token ?? randomBytes(32).toString("hex")}\n`);
	chmodSync(PEER_TOKEN_FILE, 0o600);
	console.log(a.peer_token ? "모니터링: 공유 키를 secrets/ 에 저장했어요 (화면에 표시 안 함)" : "모니터링: 다른 컴퓨터와 함께 보는 공유 키를 만들었어요. 다른 컴퓨터의 setup 에서 이 컴퓨터의 ~/.dotz/secrets/peer-token 내용을 붙여넣으세요.");
}
const config = {
	_comment: "Written by dotz setup.ts. Secrets live in secrets/ (0600), never here.",
	identity: a.identity,
	discord: { token_file: TOKEN_FILE.replace(HOME, "~"), owner_id: a.owner_id, guild: a.guild, ...(prior.discord?.app_id ? { app_id: prior.discord.app_id } : {}) },
	// The default name is not saved: an empty web.machine_name keeps following the hostname.
	web: { port: a.web_port, tailscale_https_port: a.tailscale_https_port, allow_logins: a.allow_logins, ...(a.machine_name !== defaultMachineName || priorMachineName ? { machine_name: a.machine_name } : {}) },
	orchestrator: { runtime: a.runtime, ...pick(prior.orchestrator, ["rotate_tokens"]) },
	lanes: { runtime: a.runtime, ...pick(prior.lanes, ["max_active"]) },
	models: { ...prior.models, orchestrator: { ...prior.models?.orchestrator, ...split(a.orchestrator_model) }, lanes: { ...prior.models?.lanes, ...split(a.lane_model) } },
};
writeFileSync(join(DIR, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
if (!existsSync(join(DIR, "state.json"))) writeFileSync(join(DIR, "state.json"), `${JSON.stringify({ open_tasks: [] }, null, 2)}\n`);
const identityChanged = JSON.stringify(a.identity) !== JSON.stringify(prior.identity ?? null);
if (identityChanged || !existsSync(IDENTITY_FILE)) {
	mkdirSync(join(DIR, "identity"), { recursive: true });
	writeFileSync(IDENTITY_FILE, identityDoc(a.identity));
	console.log(`identity: ${IDENTITY_FILE}`);
}
console.log(`config: ${join(DIR, "config.json")}`);

// The hub loads the dotz extension into its own OmO processes (--extension); nothing is installed into OmO's agent
// directory. omp is an opt-in runtime: its terminals get the plugin only when omp is installed here.
const ompInstalled = (await Bun.$`command -v omp`.nothrow().quiet()).exitCode === 0;
if (ompInstalled) {
	const link = join(HOME, ".omp", "agent", "extensions", "dotz");
	mkdirSync(join(HOME, ".omp", "agent", "extensions"), { recursive: true });
	if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) rmSync(link, { force: true, recursive: false });
	symlinkSync(PKG, link);
	console.log(`omp plugin linked: ${link} -> ${PKG}`);
}

const bun = (await Bun.$`which bun`.nothrow().quiet()).stdout.toString().trim() || join(HOME, ".bun", "bin", "bun");
// The service PATH reaches every installed harness CLI, whichever one config.json names now or later.
const harnessDirs = (await detectHarnesses()).filter(d => d.found.path).map(d => dirname(d.found.path!));
const plist = serviceFile({ home: HOME, bun, pkg: PKG, dir: DIR, pathDirs: harnessDirs });
const kind = MAC ? "launchd" : "systemd";
// Without --load an existing service file is left alone (a test run with --dir once pointed the live gateway's plist
// at /tmp); the new file goes into the data dir instead.
const plistOut = !flag("--load") && existsSync(PLIST) ? join(DIR, MAC ? `${LABEL}.plist` : UNIT) : PLIST;
mkdirSync(dirname(plistOut), { recursive: true });
writeFileSync(plistOut, plist);
console.log(`${kind}: ${plistOut}${flag("--load") ? "" : plistOut === PLIST ? " (not loaded; re-run with --load)" : " (existing service kept; re-run with --load to install this one)"}`);
if (flag("--load") && !MAC) {
	const r = await Bun.$`systemctl --user daemon-reload && systemctl --user enable --now ${UNIT} && systemctl --user restart ${UNIT}`.nothrow().quiet();
	console.log(r.exitCode === 0 ? "systemd: gateway started (loginctl enable-linger $USER keeps it running after logout)" : `systemd: start failed: ${r.stderr.toString().trim()}`);
}
if (flag("--load") && MAC) {
	const uid = process.getuid?.() ?? 501;
	await Bun.$`launchctl bootout gui/${uid}/${LABEL}`.nothrow().quiet();
	for (let i = 0; i < 20 && (await Bun.$`launchctl print gui/${uid}/${LABEL}`.nothrow().quiet()).exitCode === 0; i++) await Bun.sleep(500);
	let r = await Bun.$`launchctl bootstrap gui/${uid} ${PLIST}`.nothrow().quiet();
	for (let i = 0; i < 5 && r.exitCode !== 0; i++) {
		await Bun.sleep(1000);
		r = await Bun.$`launchctl bootstrap gui/${uid} ${PLIST}`.nothrow().quiet();
	}
	console.log(r.exitCode === 0 ? "launchd: gateway loaded" : `launchd: bootstrap failed: ${r.stderr.toString().trim()}`);
}

// Interactive runs open the web app on the tailnet as soon as logins are set; --answers runs (tests, scripted installs)
// only with --tailscale, so they never change a live machine's serve config by accident.
const wantServe = flag("--tailscale") || (!answersFile && a.allow_logins.length > 0);
const tsNow = wantServe ? await tailscaleState() : undefined;
if (wantServe && !tsNow?.running) console.log(`tailscale: ${tsNow?.bin ? "로그인 전이라" : "설치돼 있지 않아서"} 웹 앱을 테일넷에 아직 못 열었어요. 준비되면 bun setup.ts --tailscale 을 실행하세요.`);
if (tsNow?.running) {
	const r = await serveWeb(tsNow.bin, a.tailscale_https_port, a.web_port);
	const enable = r.out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
	if (r.ok) console.log(`tailscale: 웹 앱을 테일넷에 열었어요 (포트 ${a.tailscale_https_port}, 테일넷 안에서만)`);
	else if (enable) console.log(`tailscale: 이 테일넷에서 HTTPS 공유(serve)가 꺼져 있어요. 이 주소에서 한 번 켜 주고 bun setup.ts --tailscale 을 다시 실행하세요: ${enable}`);
	else console.log(`tailscale serve 실패: ${r.out}`);
}

if (MAC && answersFile) {
	console.log("macOS 권한 상태 (bun 이 launchd 로 도는 프로그램이라 bun 앞으로 묻고 허용돼요):");
	printPermissions(bun, await checkPermissions(bun));
	console.log("빠진 권한은 bun setup.ts permissions 로 켜요: 창을 열고 스위치와 허용까지 직접 눌러요 (종료 코드 3이면 사람이 할 한 단계만 남은 거예요).");
} else if (MAC) {
	console.log("\nmacOS 권한. 게이트웨이가 쓰는 권한을 지금 한 번에 허용해요 (나중에 bun setup.ts permissions 로 다시 할 수 있어요).");
	await requestPermissions(bun, q => ask(q, "", false));
}

let provisioned = false;
// Bot provisioning drives the Aside browser; without the Aside CLI the owner pastes a token instead.
const discordAuto = !flag("--no-discord-auto") && Boolean(Bun.which("aside", { PATH: process.env.PATH }));
if (!existsSync(TOKEN_FILE) && a.guild && !discordAuto) console.log("discord: Aside CLI 가 없어서 봇을 자동으로 만들지 않아요. 개발자 포털에서 만든 봇 토큰을 setup 을 다시 실행해 붙여넣어 주세요.");
if (!existsSync(TOKEN_FILE) && a.guild && discordAuto) {
	const repl = new AsideRepl();
	try {
		await ensureBrowser();
		console.log(`discord: Aside로 '${a.identity.name}' 앱을 만들거나 기존 앱을 찾는 중...`);
		const appId = prior.discord?.app_id ?? (await createApp(a.identity.name));
		config.discord = { ...config.discord, app_id: appId } as typeof config.discord;
		writeFileSync(join(DIR, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
		const fresh = await resetToken(repl, appId, msg => console.log(`discord: ${msg}`));
		writeFileSync(TOKEN_FILE, `${fresh}\n`);
		chmodSync(TOKEN_FILE, 0o600);
		console.log("discord: 봇 토큰을 secrets/ 에 저장했어요 (화면에 표시 안 함)");
		await invite(repl, appId, a.guild, fresh, msg => console.log(`discord: ${msg}`));
		console.log("discord: 봇이 서버에 들어왔어요");
		provisioned = true;
	} catch (error) {
		console.log(`discord: 자동 설정이 멈췄어요: ${(error as Error).message}. setup 을 다시 실행하면 이어서 해요.`);
	} finally {
		await repl.close();
	}
}

const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
if (token) {
	const me = await fetch("https://discord.com/api/v10/oauth2/applications/@me", { headers: { Authorization: `Bot ${token}` } });
	if (me.ok) {
		const app = (await me.json()) as { id: string; name: string };
		// Every install runs the bot as server administrator; an older install invited with fewer rights is re-authorized.
		if (a.guild && !(await isAdmin(token, a.guild))) {
			const url = `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot&permissions=${PERMISSIONS}&guild_id=${a.guild}&disable_guild_select=true`;
			if (!discordAuto) console.log(`discord: 봇에 관리자 권한이 없어요. 이 주소로 다시 승인해 주세요: ${url}`);
			else {
				const repl = new AsideRepl();
				try {
					await ensureBrowser();
					console.log("discord: 봇에 관리자 권한을 주도록 Aside로 다시 승인해요...");
					await invite(repl, app.id, a.guild, token, msg => console.log(`discord: ${msg}`));
					console.log("discord: 봇이 서버 관리자 권한을 갖게 됐어요");
				} catch (error) {
					console.log(`discord: 관리자 권한 승인이 멈췄어요 (${(error as Error).message}). 이 주소로 직접 승인해 주세요: ${url}`);
				} finally {
					await repl.close();
				}
			}
		} else console.log("discord: 봇 확인됨 (서버 관리자 권한)");
		console.log("discord: 개발자 포털 > Bot > Privileged Gateway Intents > MESSAGE CONTENT 가 켜져 있어야 해요.");
	} else console.log(`discord: 토큰이 거절됐어요 (${me.status}). secrets/discord-bot-token 을 지우고 setup 을 다시 실행하세요.`);
} else if (a.guild) console.log("discord: 아직 봇 토큰이 없어요. 웹 앱과 터미널로는 지금도 쓸 수 있어요.");
if (flag("--load") && provisioned) {
	if (MAC) await Bun.$`launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${LABEL}`.nothrow().quiet();
	else await Bun.$`systemctl --user restart ${UNIT}`.nothrow().quiet();
}

const webUrl = a.allow_logins.length ? await tailnetUrl(a.tailscale_https_port) : "";
if (!flag("--load")) console.log(`게이트웨이 시작: bun ${join(PKG, "setup.ts")} --load (또는 지금 창에서 ${DIR === join(HOME, ".dotz") ? "" : `DOTZ_DIR=${DIR} `}bun ${join(PKG, "hub", "main.ts")})`);
const runtimeLabel = harness(a.runtime)?.label ?? a.runtime;
console.log(`\n끝! ${a.identity.name}는 ${runtimeLabel}로 돌아가요.${a.guild ? ` 디스코드에서는 ${a.identity.name} 카테고리의 대화 채널에 말을 걸면 돼요.` : ""}${ompInstalled ? ` omp 터미널에서도 "${a.identity.name}모드 켜"라고 하면 그 터미널이 ${a.identity.name}와(과) 연결돼요.` : ""}`);
// The web address goes last, once the gateway and the tailnet proxy answer: a freshly loaded service needs a few
// seconds, and opening the browser before that showed an error page instead of the app.
if (webUrl) {
	const answers = async (url: string, seconds: number) => {
		for (let i = 0; i < seconds; i++) {
			const r = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
			if (r && r.status < 500) return true;
			await Bun.sleep(1000);
		}
		return false;
	};
	const served = Boolean(tsNow?.running);
	if (served && flag("--load")) console.log("\n웹 앱이 뜨길 기다리는 중...");
	const up = served && flag("--load") && (await answers(`http://127.0.0.1:${a.web_port}/`, 40)) && (await answers(webUrl, 15));
	const why = !served ? (wantServe ? "Tailscale 을 켜고 bun setup.ts --tailscale 을 실행하면 열려요" : "bun setup.ts --tailscale 로 테일넷에 열어요") : !flag("--load") ? "게이트웨이를 시작하면 열려요" : up ? "" : "게이트웨이가 아직 뜨는 중이에요. 1분쯤 뒤에 열어 보세요";
	console.log(`\n웹 앱 주소: ${webUrl}${why ? `  (${why})` : ""}`);
	console.log(`  휴대폰이나 다른 컴퓨터에서는 같은 Tailscale 계정(${a.allow_logins[0]})으로 로그인한 뒤 이 주소를 열면 돼요.`);
	if (flag("--open") && up) await Bun.$`${MAC ? "open" : "xdg-open"} ${webUrl}`.nothrow().quiet();
}
