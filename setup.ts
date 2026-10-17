#!/usr/bin/env bun
// Dotz onboarding wizard (Korean, step by step), modeled on the omonyang ~/.ddotz/setup.ts and the dori-kit setup.ts.
// 1) bot identity: name, character, tone, notices, how to address the owner, optional avatar -> ~/.dotz/identity/IDENTITY.md
//    (the orchestrator talks this way)
// 2) Discord: owner id, server id; the bot itself is provisioned through the Aside browser (onboard/discord.ts) unless a
//    token is pasted; the owner only approves Discord's 2FA prompt. 3) web app access. Advanced: ports and models.
// Writes ~/.dotz/config.json (no secrets), secrets/ (0600), links the plugin into omp, writes the launchd plist; runs
// launchctl only with --load and tailscale serve only with --tailscale. Re-running keeps every answer as the default.
//   bun setup.ts [--answers answers.json] [--load] [--tailscale] [--no-discord-auto] [--dir ~/.dotz]
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asideState, installApp, installCli, loginCli, openApp } from "./onboard/aside.ts";
import { AsideRepl, createApp, ensureBrowser, invite, isAdmin, PERMISSIONS, resetToken } from "./onboard/discord.ts";

const HOME = homedir();
const PKG = import.meta.dir;
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
const DIR = expandHome(opt("--dir") ?? join(HOME, ".dotz"));
const LABEL = "dev.dotz.gateway";
const PLIST = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const TOKEN_FILE = join(DIR, "secrets", "discord-bot-token");
const IDENTITY_FILE = join(DIR, "identity", "IDENTITY.md");
const SNOWFLAKE = /^\d{17,20}$/;

type Identity = { name: string; character: string; tone: string; notices?: string; address?: string; avatar?: string };
type Answers = {
	identity: Identity;
	owner_id: string;
	guild: string;
	bot_token?: string;
	allow_logins: string[];
	web_port: number;
	tailscale_https_port: number;
	orchestrator_model: string;
	lane_model: string;
	install_aside?: boolean;
};

const prior = existsSync(join(DIR, "config.json")) ? JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")) : {};
const priorIdentity: Identity = { name: "", character: "", tone: "", ...prior.identity };

const CHARACTERS = [
	"차분하고 믿음직한 개인 비서. 먼저 결과를 말하고 필요한 것만 묻는다.",
	"장난기 있지만 일은 확실한 친구 같은 조수. 가볍게 말하되 사실은 정확하게.",
	"꼼꼼한 엔지니어. 근거와 검증을 먼저 챙기고 불확실하면 그렇다고 말한다.",
];
// The first entry of each list is the default (Enter). The default tone is the one the macmini secretary (오모냥) uses.
const TONES = [
	"편한 해요체. 결론부터 짧게 말하고, 근거와 숫자는 구체적으로, 긴 내용은 줄바꿈 목록으로. 가벼운 지시는 'ㅇㅋ ~할게요'처럼 받고, 끝은 다음 할 일이나 짧은 질문. 이모지 없음 (예: \"원인 찾았어요. 04:30 업데이트 때 세션이 잘못 복원됐어요. 고쳤어요: 재시작 때 먼저 종료하게 함\")",
	"반말, 친근하고 짧게 (예: \"응, 끝났어. 테스트도 통과\")",
	"존댓말, 간결하게 (예: \"네, 끝났어요. 테스트도 통과했어요\")",
	"존댓말, 정중하게 (예: \"완료했습니다. 테스트도 통과했습니다\")",
];
// Style of notices (작업로그, 알림), from everyday speech to ASD-STE100; MODE.md defines each level.
const NOTICES = [
	"일상: 평소 말투 그대로, 관련 내용을 짧게 (예: \"hbtest 레인 끝났어요. 응답 확인했고 남은 일 없어요.\")",
	"간결: 해요체 평서문, 한 문장에 사실 하나, 군말 없이 (예: \"hbtest 레인을 마쳤어요. 응답은 정상이에요. 남은 일은 없어요.\")",
	"STE 80%: ASD-STE100 규칙(짧은 문장, 능동태, 정해진 용어, 절차는 번호 단계)을 80% 강도로, 합니다체. 강도는 'STE 100%'처럼 바꿀 수 있음 (예: \"hbtest 레인을 완료했습니다. 응답이 정상입니다. 남은 작업은 없습니다.\")",
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

async function tailscaleLogin(): Promise<string> {
	const r = await Bun.$`tailscale status --json`.nothrow().quiet();
	try {
		const d = JSON.parse(r.stdout.toString());
		return String(d.User?.[String(d.Self?.UserID)]?.LoginName ?? "");
	} catch {
		return "";
	}
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
		if (interactiveRun) {
			console.log("  Aside CLI 로그인: 아래에 나오는 코드를 Aside 앱 설정 > 계정 > 기기에서 승인해 주세요.");
			await loginCli(s.cli);
		} else console.log(`  Aside CLI 로그인이 필요해요: ${s.cli} login (Aside 앱 설정 > 계정 > 기기에서 승인)`);
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

async function interactive(): Promise<Answers> {
	console.log("\n봇 온보딩을 시작합니다. 대괄호 [ ] 안의 값은 Enter로 그대로 쓸 수 있어요.\n");
	console.log("1/4 도구 준비: 봇이 쓰는 Aside 브라우저와 메일·일정 도구(zele)를 확인하고, 없으면 설치해요.");
	await prepareAside(true);
	await prepareZele(true);

	console.log("\n2/4 봇 정체성: 이름, 성격, 말투, 호칭. 봇은 디스코드, 웹, 터미널 어디서나 이 성격과 말투로 대답해요.");
	if (!priorIdentity.name) console.log("  먼저 봇의 이름을 지어 주세요. 디스코드 봇 이름, 카테고리, '<이름>모드 켜' 문구가 모두 이 이름을 써요.");
	const name = askValid("봇 이름 (2~32자, 예: 땃쥐, 오모냥)", priorIdentity.name, v => v.length >= 2 && v.length <= 32, "2~32자로 적어 주세요");
	const character = choose("성격을 골라 주세요", CHARACTERS, priorIdentity.character);
	const tone = choose("말투를 골라 주세요", TONES, priorIdentity.tone);
	const notices = choose("작업로그·알림 문체를 골라 주세요 (나중에 대화에서 '알림 문체 STE로'처럼 바꿀 수 있어요)", NOTICES, priorIdentity.notices ?? "");
	const address = ask("봇이 주인을 부르는 호칭 (예: 형, 대표님, 이름. 없으면 Enter: 호칭 없이 말해요)", priorIdentity.address ?? "", false);
	const avatar = askValid("프로필 이미지 파일 경로 (png/jpg, 없으면 Enter)", priorIdentity.avatar ?? "", v => existsSync(expandHome(v)), "그 경로에 파일이 없어요", false);

	console.log("\n3/4 디스코드. ID는 디스코드 설정 > 고급 > 개발자 모드를 켠 뒤, 내 프로필이나 서버 이름을 우클릭 > 'ID 복사'로 얻어요.");
	const guild = askValid("봇이 들어갈 서버 ID (디스코드 없이 웹/터미널만 쓰려면 Enter)", prior.discord?.guild ?? "", v => SNOWFLAKE.test(v), "17~20자리 숫자여야 해요", false);
	const owner_id = guild ? askValid("내 디스코드 사용자 ID (이 계정의 말만 명령으로 들어요)", prior.discord?.owner_id ?? "", v => SNOWFLAKE.test(v), "17~20자리 숫자여야 해요") : "";
	let bot_token = "";
	if (guild && !existsSync(TOKEN_FILE)) {
		console.log("  봇은 Aside 브라우저로 자동으로 만들어요 (디스코드 2단계 인증 승인만 해 주시면 돼요).");
		bot_token = secret("이미 만든 봇 토큰이 있으면 붙여넣기 (화면에 안 보여요, 자동 생성은 Enter)");
	} else if (guild) console.log("  저장된 봇 토큰을 그대로 써요.");

	console.log("\n4/4 웹 앱 (테일넷 안에서만 열려요).");
	const login = (prior.web?.allow_logins ?? [])[0] ?? (await tailscaleLogin());
	const allow_logins = ask("웹 앱에 들어올 수 있는 Tailscale 로그인 (쉼표로 여러 개)", login).split(",").map(s => s.trim()).filter(Boolean);

	const defaults = {
		web_port: Number(prior.web?.port ?? 7420),
		tailscale_https_port: Number(prior.web?.tailscale_https_port ?? 8443),
		orchestrator_model: `${prior.orchestrator?.model ?? "anthropic/claude-opus-5-5"}:${prior.orchestrator?.thinking ?? "medium"}`,
		lane_model: `${prior.lanes?.model ?? "anthropic/claude-opus-5-5"}:${prior.lanes?.thinking ?? "medium"}`,
	};
	const port = (v: string) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536;
	const advanced = /^y/i.test(ask("포트나 모델도 바꿀까요? y/N", "n"));
	const a: Answers = {
		identity: { name, character, tone, notices, ...(address ? { address } : {}), ...(avatar ? { avatar } : {}) },
		owner_id,
		guild,
		bot_token,
		allow_logins,
		...defaults,
		...(advanced
			? {
					web_port: Number(askValid("로컬 포트", String(defaults.web_port), port, "1~65535")),
					tailscale_https_port: Number(askValid("테일넷 HTTPS 포트", String(defaults.tailscale_https_port), port, "1~65535")),
					orchestrator_model: ask(`${name} 모델:thinking`, defaults.orchestrator_model),
					lane_model: ask("레인(프로젝트 작업) 모델:thinking", defaults.lane_model),
				}
			: {}),
	};

	console.log(`\n정리하면:
  이름 ${name} / 성격 ${character}
  말투 ${tone}
  알림 문체 ${notices}
  호칭 ${address || "(없음)"}${avatar ? `\n  프로필 이미지 ${avatar}` : ""}
  디스코드 ${guild ? `서버 ${guild}, 주인 ${owner_id}, 봇 ${existsSync(TOKEN_FILE) ? "저장된 토큰" : bot_token ? "붙여넣은 토큰" : "자동 생성"}` : "사용 안 함"}
  웹 ${allow_logins.join(", ") || "(허용 로그인 없음)"}, 포트 ${a.web_port} -> ${a.tailscale_https_port}`);
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
	if (!identity.name || identity.name.length < 2 || identity.name.length > 32) errors.push("identity.name: 2~32자");
	if (!identity.character) errors.push("identity.character: 성격 한 줄");
	if (!identity.tone) errors.push("identity.tone: 말투 한 줄");
	if (identity.avatar && !existsSync(expandHome(identity.avatar))) errors.push(`identity.avatar: 파일 없음 ${identity.avatar}`);
	const guild = String(a.guild ?? "");
	const owner = String(a.owner_id ?? "");
	if (guild && !SNOWFLAKE.test(guild)) errors.push("guild: 17~20자리 숫자");
	if (guild && !SNOWFLAKE.test(owner)) errors.push("owner_id: 17~20자리 숫자 (guild 가 있으면 필수)");
	if (errors.length) {
		console.error(`answers 파일 오류:\n  ${errors.join("\n  ")}`);
		process.exit(1);
	}
	return {
		identity,
		owner_id: owner,
		guild,
		bot_token: a.bot_token,
		allow_logins: a.allow_logins ?? prior.web?.allow_logins ?? [],
		web_port: Number(a.web_port ?? prior.web?.port ?? 7420),
		tailscale_https_port: Number(a.tailscale_https_port ?? prior.web?.tailscale_https_port ?? 8443),
		orchestrator_model: a.orchestrator_model ?? `${prior.orchestrator?.model ?? "anthropic/claude-opus-5-5"}:${prior.orchestrator?.thinking ?? "medium"}`,
		lane_model: a.lane_model ?? `${prior.lanes?.model ?? "anthropic/claude-opus-5-5"}:${prior.lanes?.thinking ?? "medium"}`,
		install_aside: a.install_aside === true,
	};
}

function identityDoc(id: Identity): string {
	return `# Bot identity (written by dotz setup.ts; edit freely, re-running setup keeps this file unless the answers change)

- Name: **${id.name}**. Mode phrases: "${id.name}모드 켜" / "${id.name}모드 꺼" (also /dotz on|off).
- Character: ${id.character}
- Tone: ${id.tone}
- Notices (worklog, alert): ${id.notices}
- Owner address: ${id.address ? `call the owner "${id.address}"; no other title` : "no title; never call the owner 사장님, 주인님 or any honorific, just talk to them"}
${id.avatar ? `- Avatar: ${id.avatar}\n` : ""}
## Voice rules
- Speak as ${id.name}, in the character and tone above, in the owner's language (Korean unless they switch).
- Before writing, picture what the owner wants, the state they are in and what would actually help.
- Match the owner's length and register; short chat messages, not reports. Status is plain: what happened, the evidence,
  what the owner must decide.
- No emojis anywhere: messages, thread and channel names (the gateway's eyes reaction is the only read receipt).
  Times in local time (KST), never bare UTC.
`;
}

const answersFile = opt("--answers");
const a = validate(answersFile ? JSON.parse(readFileSync(answersFile, "utf8")) : await interactive());
if (answersFile) {
	await prepareAside(false, a.install_aside === true);
	await prepareZele(false, a.install_aside === true);
}
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
const config = {
	_comment: "Written by dotz setup.ts. Secrets live in secrets/ (0600), never here.",
	identity: a.identity,
	discord: { token_file: TOKEN_FILE.replace(HOME, "~"), owner_id: a.owner_id, guild: a.guild, ...(prior.discord?.app_id ? { app_id: prior.discord.app_id } : {}) },
	web: { port: a.web_port, tailscale_https_port: a.tailscale_https_port, allow_logins: a.allow_logins },
	orchestrator: { ...split(a.orchestrator_model), ...(prior.orchestrator?.rotate_tokens ? { rotate_tokens: prior.orchestrator.rotate_tokens } : {}) },
	lanes: { ...split(a.lane_model), ...(prior.lanes?.max_active ? { max_active: prior.lanes.max_active } : {}) },
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

const link = join(HOME, ".omp", "agent", "extensions", "dotz");
mkdirSync(join(HOME, ".omp", "agent", "extensions"), { recursive: true });
if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) rmSync(link, { force: true, recursive: false });
symlinkSync(PKG, link);
console.log(`omp plugin linked: ${link} -> ${PKG}`);

const bun = (await Bun.$`which bun`.nothrow().quiet()).stdout.toString().trim() || join(HOME, ".bun", "bin", "bun");
const ompDir = (await Bun.$`dirname "$(command -v omp)"`.nothrow().quiet()).stdout.toString().trim();
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${bun}</string><string>${join(PKG, "hub", "main.ts")}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>${[ompDir, join(HOME, ".bun", "bin"), join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":")}</string>
    <key>DOTZ_DIR</key><string>${DIR}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${join(DIR, "gateway.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(DIR, "gateway.err.log")}</string>
</dict></plist>
`;
mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
writeFileSync(PLIST, plist);
console.log(`launchd: ${PLIST}${flag("--load") ? "" : " (not loaded; re-run with --load)"}`);
if (flag("--load")) {
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

if (flag("--tailscale")) {
	const r = await Bun.$`tailscale serve --bg --https=${a.tailscale_https_port} http://127.0.0.1:${a.web_port}`.nothrow().quiet();
	console.log(r.exitCode === 0 ? `tailscale: web app on port ${a.tailscale_https_port} (tailnet only)` : `tailscale serve failed: ${r.stderr.toString().trim()}`);
}

let provisioned = false;
if (!existsSync(TOKEN_FILE) && a.guild && !flag("--no-discord-auto")) {
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
			if (flag("--no-discord-auto")) console.log(`discord: 봇에 관리자 권한이 없어요. 이 주소로 다시 승인해 주세요: ${url}`);
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
if (flag("--load") && provisioned) await Bun.$`launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${LABEL}`.nothrow().quiet();
console.log(`\n끝! 아무 omp 터미널에서 "${a.identity.name}모드 켜"라고 하면 그 터미널이 ${a.identity.name}와(과) 연결돼요.${a.guild ? ` 디스코드에서는 ${a.identity.name} 카테고리의 대화 채널에 말을 걸면 돼요.` : ""}`);
