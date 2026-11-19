#!/usr/bin/env bun
// Dotz onboarding wizard (Korean, step by step), modeled on the omonyang ~/.ddotz/setup.ts and the dori-kit setup.ts.
// 1) harness: the coding-agent CLI the orchestrator and lanes run on (onboard/harness.ts; OmO by default, installed with
//    bun when missing; omp and Claude Code selectable; Codex listed, no adapter yet) and its login state
// Onboarding ends with the macOS permissions step (onboard/permissions.ts): bun is what launchd runs, so the prompts and
// the Settings entries are for bun. Interactive runs and `permissions` turn what they can on themselves (prompts, panes, switches);
// only a step macOS keeps for a person is printed, once. --answers runs only print the state. Standalone, safe to rerun:
//   bun setup.ts permissions [--check]     (--check only prints the state, never raises a dialog; exit 3 = an owner step is left)
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { asideState, installApp, installCli, loginCli, openApp } from "./onboard/aside.ts";
import { type Answers, type AccessMode, CHARACTERS, CONNECT_KEYS, type ConnectKey, cleanHostname, NOTICES, priorOf, selectorFor, SNOWFLAKE, stripExample, TONES, validateAnswers, type Identity } from "./firstrun/answers.ts";
import { type Env, linkOmp, peerTokenFile, serveTailnet, tokenFile, writeConfig, writeSecrets } from "./firstrun/apply.ts";
import { type ConnectTarget, type ConnectUI, connectAll, gatewayUp, switchAccess } from "./firstrun/connect.ts";
import { defaultHarness, detectHarnesses, type Detected, harness, harnessHint } from "./onboard/harness.ts";
import { type LoginState, loginOf } from "./hub/runtime/login.ts";
import { runtimeModels, validateWithModels } from "./firstrun/models.ts";
import { checkPermissions, printPermissions, requestPermissions } from "./onboard/permissions.ts";
import { realUiBlocked } from "./onboard/selfserve.ts";
import { zeleAccounts } from "./firstrun/scan.ts";
import { installTailscale, startTailscale, tailscaleState, type TailscaleState } from "./onboard/tailscale.ts";
import { openerCommand, windowsToolDirs } from "./hub/opener.ts";
import { LABEL, serviceFile, servicePath, UNIT } from "./onboard/service.ts";
import { firstRunPending, issueToken, markTerminalDone, saveDraft } from "./firstrun/first-run.ts";
import { cleanName, MAX_NAME } from "./hub/machine-name.ts";
import { installDotzCommand } from "./hub/dotz-command.ts";
import { ask, askSecret, bail, type Choice, fit, hinted, intro, makeOut, note, outro, pick, pickMany, setCancelText, stepHeader, whileWorking, type Working, working, yesNo } from "./onboard/tui.ts";

const HOME = homedir();
const PKG = import.meta.dir;
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
const DIR = expandHome(opt("--dir") ?? join(HOME, ".dotz"));
const MAC = process.platform === "darwin";
const PLIST = servicePath({ home: HOME });
const TOKEN_FILE = tokenFile(DIR);
const PEER_TOKEN_FILE = peerTokenFile(DIR);
const P = priorOf(DIR);
const prior = P.raw;
// This computer's name in the web app's computer list: the saved one, else the hostname-derived default (hub/machine-name.ts).
const defaultMachineName = P.defaultMachineName;
const priorMachineName = P.machineName;
const priorIdentity: Identity = P.identity;
const priorRuntime = P.runtime;

const answersFile = opt("--answers");
const subcommand = args[0] === "permissions" || args[0] === "connect" || ["--first-run", "--web-link", "--refresh-service"].some(flag);
const FANCY = Boolean(process.stdin.isTTY) && !answersFile && (!subcommand || (args[0] === "connect" && Boolean(process.stdout.isTTY)));
const out = makeOut(!FANCY);
const readLine = (q: string): string => (prompt(`  ${q}:`) ?? "").trim();
const SPAWN_TIMEOUT_MS = 30 * 60_000;
const TOTAL = 6;
const defaultDir = DIR === join(HOME, ".dotz");
const dirArg = defaultDir ? "" : ` --dir ${DIR}`;

async function runCmd(cmd: string[]): Promise<boolean> {
	return (await Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" }).exited) === 0;
}

async function installQuiet(label: string, cmd: string[]): Promise<boolean> {
	if (!FANCY) return runCmd(cmd);
	const w = working(`${label} 설치하는 중...`);
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code === 0) w.done(`${label} 설치했어요`);
	else {
		w.fail(`${label} 설치에 실패했어요 (${cmd.join(" ")})`);
		out.dim((stderr || stdout).trim().split("\n").slice(-4).join("\n"));
	}
	return code === 0;
}

async function tailnetUrl(port: number): Promise<string> {
	const { host } = await tailscaleState();
	return host ? `https://${host}${port === 443 ? "" : `:${port}`}/` : "";
}

async function prepareTailscale(): Promise<TailscaleState> {
	let s = await whileWorking("Tailscale 상태를 확인하는 중...", tailscaleState);
	if (!s.bin) {
		out.warn("Tailscale 이 없어요. 휴대폰이나 다른 컴퓨터에서 웹 앱을 열 때 Tailscale 을 써요.");
		if (await yesNo("지금 설치할까요?")) {
			out.dim(MAC ? "Homebrew: brew install --cask tailscale-app (설치 로그가 아래에 나와요)" : "tailscale.com/install.sh (설치 로그가 아래에 나와요)");
			if (!(await installTailscale())) await yesNo("브라우저에서 tailscale.com/download 를 열었어요. 설치를 마쳤나요?", true, ["마쳤어요", "나중에 할게요"]);
			s = await tailscaleState();
		}
	}
	while (s.bin && !s.running) {
		out.warn("Tailscale 에 로그인이 안 돼 있어요. Tailscale 을 열 테니 로그인해 주세요. 휴대폰에서도 같은 계정으로 로그인하면 웹 앱을 열 수 있어요.");
		await startTailscale(s.bin);
		if (!(await yesNo("로그인을 마쳤나요?", true, ["마쳤어요", "나중에 할게요"]))) break;
		s = await whileWorking("Tailscale 상태를 확인하는 중...", tailscaleState);
	}
	if (s.running) out.ok(`Tailscale 준비 완료: ${s.login} (${s.host})`);
	else if (s.bin) out.warn(`Tailscale 이 아직 로그인 전이에요${s.error ? ` (${s.error})` : ""}. 로그인 후 setup 을 다시 실행하면 웹 앱이 켜져요.`);
	else out.warn("Tailscale 없이 진행해요. 설치한 뒤 setup 을 다시 실행하면 다른 기기에서도 열려요.");
	return s;
}

async function prepareAside(autoInstall = false) {
	let s = await (FANCY ? whileWorking("Aside 상태를 확인하는 중...", asideState) : asideState());
	const yes = (q: string) => (FANCY ? yesNo(q) : Promise.resolve(autoInstall));
	if (!s.app) {
		out.warn("Aside 앱이 없어요. 봇 자동 연결, 로그인 유지, 웹 작업을 모두 Aside로 해요.");
		if (await yes("지금 설치할까요?")) {
			if (FANCY) out.dim("Homebrew: brew install --cask aside (설치 로그가 아래에 나와요)");
			if (!(await installApp()) && FANCY) await yesNo("브라우저에서 aside.com/download 를 열었어요. 설치를 마쳤나요?", true, ["마쳤어요", "나중에 할게요"]);
		}
	}
	if ((await asideState()).app) {
		await openApp();
		if (FANCY && !s.app) await yesNo("Aside 앱이 열렸어요. 계정으로 로그인하고, 쓰는 사이트에 로그인해 두었나요?", true, ["마쳤어요", "나중에 할게요"]);
	}
	s = await asideState();
	if (!s.cli && (await yes("Aside CLI(aside 명령)가 없어요. 지금 설치할까요?"))) {
		if (FANCY) out.dim("curl -fsSL https://releases.aside.com/install.sh | bash");
		await installCli();
	}
	s = await asideState();
	if (s.cli && !s.signedIn) {
		if (FANCY && (await yes("Aside CLI 로그인이 필요해요. 지금 할까요?"))) {
			out.info("아래에 나오는 코드를 Aside 앱 설정 > 계정 > 기기에서 승인해 주세요.");
			await loginCli(s.cli);
		} else if (FANCY) out.dim(`나중에 ${s.cli} login 으로 로그인하면 돼요.`);
		else console.log(`Aside CLI 로그인이 필요해요: ${s.cli} login (Aside 앱 설정 > 계정 > 기기에서 승인)`);
		s = await asideState();
	}
	const missing = [!s.app && "Aside 앱 (brew install --cask aside 또는 aside.com/download)", !s.cli && "Aside CLI (curl -fsSL https://releases.aside.com/install.sh | bash)", s.cli && !s.signedIn && "CLI 로그인 (aside login)"].filter(Boolean);
	if (missing.length) out.warn(`아직 없는 것: ${missing.join(", ")}. 메신저 자동 연결과 로그인 유지는 준비되면 동작해요. 설치 후 setup 을 다시 실행하면 이어서 해요.`);
	else out.ok(`Aside 준비 완료: 앱, CLI (${s.cli}), 로그인 ${s.account}`);
	return s;
}

// Mail and calendar run through zele (long-lived Gmail/IMAP/Calendar tokens). Install with bun; connecting an account is
// zele's own login flow, which the owner approves in the browser (Google/Outlook) or with an app password (IMAP).
async function prepareZele(autoInstall = false): Promise<void> {
	const yes = (q: string, def = true) => (FANCY ? yesNo(q, def) : Promise.resolve(autoInstall));
	if (!Bun.which("zele") && (await yes("메일·일정 도구 zele 가 없어요. 지금 설치할까요?"))) await installQuiet("zele", ["bun", "add", "-g", "zele"]);
	if (!Bun.which("zele")) return void out.info("zele 없이 진행해요. 메일·일정 감시는 꺼져 있어요 (나중에 bun add -g zele).");
	let accounts = await zeleAccounts();
	out.info(`zele 계정: ${accounts.join(", ") || "없음"}`);
	while (FANCY && (await yes(accounts.length ? "메일·캘린더 계정을 하나 더 연결할까요?" : "메일·캘린더 계정을 연결할까요?", !accounts.length))) {
		out.dim("zele login 을 시작해요. Google·Outlook 은 브라우저에서 승인, 네이버 같은 IMAP 은 메일 설정의 앱 비밀번호를 써요.");
		await runCmd(["zele", "login"]);
		accounts = await zeleAccounts();
		out.info(`zele 계정: ${accounts.join(", ") || "없음"}`);
	}
	if (!FANCY && !accounts.length) console.log("zele 계정이 없어요: zele login 으로 연결하면 게이트웨이가 다음 재시작부터 메일·일정을 봐요.");
}

async function refreshBunPath(): Promise<void> {
	const freshBunGlobalBin = (await Bun.$`bun pm bin -g`.nothrow().quiet()).stdout.toString().trim();
	if (freshBunGlobalBin && !(process.env.PATH ?? "").split(":").includes(freshBunGlobalBin)) process.env.PATH = `${freshBunGlobalBin}:${process.env.PATH ?? ""}`;
}

function reportHarness(d: Detected, login: LoginState): void {
	const pool = d.accountPoolHint && login.checked && login.ready ? ` ${d.accountPoolHint}` : "";
	const text = `하네스: ${d.label} ${d.found.version ?? ""} (${d.found.path})${login.checked ? (login.ready ? `, 로그인된 계정 ${login.accounts}개.` : `, 로그인 필요: ${d.loginHint}`) : `. 로그인이 안 돼 있으면: ${d.loginHint}`}`;
	if (login.checked && !login.ready) out.warn(text);
	else out.ok(`${text}${pool}`);
}

async function chooseHarness(wanted?: string): Promise<string> {
	for (;;) {
		const { found, logins } = await whileWorking(
			"설치된 하네스를 찾는 중...",
			async () => {
				const list = await detectHarnesses();
				return { found: list, logins: await Promise.all(list.map(d => (d.found.installed && d.adapter ? loginOf(d.id, d.found.path) : undefined))) };
			},
			r => `설치된 하네스: ${r.found.filter(d => d.found.installed).map(d => d.label.split(" ")[0]).join(", ") || "없음"}`,
		);
		const installed = new Set(found.filter(d => d.found.installed).map(d => d.id));
		const id = await pick({
			message: "어떤 하네스로 돌릴까요?",
			initial: defaultHarness(wanted ?? priorRuntime, installed),
			options: hinted(found.map((d, i) => ({ value: d.id, label: d.label, hint: harnessHint(d, logins[i]), disabled: !d.adapter }))),
		});
		let d = found.find(x => x.id === id) as Detected;
		if (!d.found.installed) {
			if (d.install && (await yesNo(`${d.label} 가 없어요. 지금 설치할까요?`))) {
				out.dim(d.installHint);
				await installQuiet(d.label, d.install);
				await refreshBunPath();
				d = (await detectHarnesses()).find(x => x.id === id) as Detected;
			}
			if (!d.found.installed) {
				out.warn(`${d.label} 가 아직 없어요: ${d.installHint}`);
				out.dim("다른 터미널에서 설치한 뒤 다시 고르거나, 다른 하네스를 골라요.");
				continue;
			}
		}
		let login = await whileWorking("로그인 상태를 확인하는 중...", () => loginOf(d.id, d.found.path));
		while (login.checked && !login.ready) {
			out.warn(`${d.label} 에 로그인된 계정이 없어요.`);
			note(`${d.loginHint}\n명령을 못 찾으면 전체 경로로: ${d.found.path}`, `${d.label} 로그인`);
			if (!(await yesNo("로그인을 마쳤나요?", true, ["마쳤어요, 다시 확인", "나중에 할게요"]))) break;
			login = await whileWorking("로그인 상태를 확인하는 중...", () => loginOf(d.id, d.found.path));
		}
		reportHarness(d, login);
		return id;
	}
}

async function ensureHarness(id: string, autoInstall: boolean): Promise<void> {
	let d = (await detectHarnesses()).find(x => x.id === id) as Detected;
	if (!d.found.installed && autoInstall && d.install) {
		await installQuiet(d.label, d.install);
		await refreshBunPath();
		d = (await detectHarnesses()).find(x => x.id === id) as Detected;
	}
	if (!d.found.installed) {
		console.error(`${d.label} 가 설치돼 있지 않아요: ${d.installHint}. 설치한 뒤 다시 실행하세요 (answers 에 install_harness: true 를 넣으면 setup 이 설치해요). 아무것도 쓰지 않았어요.`);
		process.exit(1);
	}
	reportHarness(d, await loginOf(d.id, d.found.path));
}

async function chooseLine(message: string, list: readonly string[], current: string): Promise<string> {
	const plain = list.map(stripExample);
	const keep = current && !plain.includes(current) ? current : "";
	const options: Choice<string>[] = list.map((o, i) => {
		const [sentence, ...rest] = plain[i].split(". ");
		const first = fit(sentence, 36) === sentence ? sentence : sentence.split(/, |\(/)[0];
		const example = o.match(/\(예:\s*(.*)\)$/)?.[1]?.replace(/^"|"$/g, "");
		const hint = example ?? (rest.join(". ") || undefined);
		return { value: plain[i], label: fit(first, 36), ...(hint ? { hint: fit(hint, 24) } : {}) };
	});
	if (keep) options.unshift({ value: keep, label: fit(keep, 36), hint: "지금 값 유지" });
	options.push({ value: "\u0000custom", label: "직접 입력", hint: "한 줄로 적어요" });
	const chosen = await pick({ message, options, initial: keep || (plain.includes(current) ? current : plain[0]) });
	return chosen === "\u0000custom" ? ask({ message: "한 줄로 적어 주세요" }) : chosen;
}

const MESSENGERS: Choice<ConnectKey>[] = [
	{ value: "discord", label: "디스코드", hint: "캡차 한 번 풀고 초대 승인" },
	{ value: "slack", label: "슬랙", hint: "워크스페이스 허용 동의 한 번" },
	{ value: "telegram", label: "텔레그램", hint: "BotFather 에서 봇 만들고 Start 누르기" },
	{ value: "jandi", label: "잔디", hint: "잔디 로그인 한 번" },
];
const TITLE: Record<ConnectTarget, string> = { discord: "디스코드", slack: "슬랙", telegram: "텔레그램", jandi: "잔디", "web-access": "Cloudflare 웹 접속" };
const ACCESS_CHOICES: Choice<AccessMode>[] = [
	{ value: "tailscale", label: "Tailscale", hint: "같은 계정의 휴대폰·컴퓨터에서 열려요" },
	{ value: "cloudflare", label: "Cloudflare", hint: "내 도메인 주소로 열려요" },
	{ value: "local", label: "이 컴퓨터만", hint: "이 컴퓨터의 브라우저에서만 열려요" },
];
const hostProblem = (v: string) => (cleanHostname(v) ? undefined : "app.example.com 같은 주소로 적어 주세요");
const portProblem = (v: string) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536 ? undefined : "1~65535 사이 숫자로 적어 주세요");

async function interactive(): Promise<Partial<Answers>> {
	intro("dotz 온보딩");
	out.dim("여섯 단계예요. 방향키로 고르고 Enter 로 확인해요. Ctrl+C 로 언제든 나갈 수 있고, 다시 실행하면 지금 값이 기본값이에요.");

	stepHeader(1, TOTAL, "하네스", "봇과 프로젝트 세션이 돌아갈 코딩 에이전트예요. 기본은 OmO 예요.");
	const runtime = await chooseHarness(opt("--runtime"));
	const models = runtime === "omp" ? await whileWorking("omp 모델 목록을 읽는 중...", () => runtimeModels(runtime)) : await runtimeModels(runtime);
	if (selectorFor(P, "orchestrator", models) !== P.selector("orchestrator")) out.info(`이 하네스에 로그인된 계정이 쓸 수 있는 모델로 맞췄어요: ${selectorFor(P, "orchestrator", models)}`);

	stepHeader(2, TOTAL, "도구", "Aside 는 봇의 브라우저예요. 메신저와 Cloudflare 연결도 Aside 로 해요. 메일·일정은 zele 가 읽어요.");
	const aside = MAC ? await prepareAside() : undefined;
	if (!MAC) out.info("Aside 는 macOS 앱이라 건너뛰어요. 메신저는 설정 > 메신저 > 직접 입력 으로 연결해요.");
	await prepareZele();

	stepHeader(3, TOTAL, "봇", "봇은 메신저, 웹, 터미널 어디서나 이 이름과 성격, 말투로 대답해요.");
	if (!priorIdentity.name) out.dim("먼저 이름을 지어 주세요. 메신저 봇 이름과 '<이름>모드 켜' 문구가 모두 이 이름을 써요.");
	const name = await ask({ message: "봇 이름 (2~32자, 예: 루미, 모모, 비서)", def: priorIdentity.name, check: v => (v.length >= 2 && v.length <= 32 ? undefined : "2~32자로 적어 주세요") });
	const character = await chooseLine("성격을 골라 주세요", CHARACTERS, priorIdentity.character);
	const tone = await chooseLine("말투를 골라 주세요", TONES, priorIdentity.tone);
	const notices = await chooseLine("작업로그·알림 문체를 골라 주세요", NOTICES, priorIdentity.notices ?? "");
	out.dim("알림 문체는 나중에 대화에서 '알림 문체 STE로'처럼 바꿀 수 있어요.");
	const address = await ask({ message: "봇이 나를 부르는 호칭 (예: 형, 대표님, 이름. 비우면 호칭 없이 말해요)", def: priorIdentity.address ?? "", required: false });
	const avatar = await ask({ message: "프로필 이미지 파일 경로 (png/jpg, 없으면 Enter)", def: priorIdentity.avatar ?? "", required: false, check: v => (existsSync(expandHome(v)) ? undefined : "그 경로에 파일이 없어요") });

	stepHeader(4, TOTAL, "메신저", "봇과 대화할 곳이에요. 웹과 터미널은 항상 돼요. 고른 곳은 설정이 끝난 뒤 하나씩 연결해요.");
	let connect: ConnectKey[] = [];
	let bot_token = "";
	let guild: string = prior.discord?.guild ?? "";
	let owner_id: string = prior.discord?.owner_id ?? "";
	if (aside?.cli) {
		if (await yesNo("메신저에서도 대화할까요? (아니요면 웹·터미널만)", false)) connect = await pickMany({ message: "어디서 대화할까요?", options: hinted(MESSENGERS) });
	} else {
		out.warn("Aside CLI 가 없어서 메신저 자동 연결은 못 해요. 슬랙·텔레그램·잔디는 설정 > 메신저 > 직접 입력 으로 연결해요.");
		if (existsSync(TOKEN_FILE)) out.info("저장된 디스코드 봇 토큰을 그대로 써요.");
		else if (await yesNo("디스코드 봇 토큰이 있으면 지금 붙여넣을까요?", false)) {
			bot_token = await askSecret("디스코드 봇 토큰 (화면에 안 보여요)");
			out.dim("ID는 디스코드 설정 > 고급 > 개발자 모드를 켠 뒤 서버 이름이나 내 프로필을 우클릭 > 'ID 복사'로 얻어요.");
			const snowflake = (v: string) => (SNOWFLAKE.test(v) ? undefined : "17~20자리 숫자여야 해요");
			guild = await ask({ message: "봇이 들어갈 서버 ID", def: guild, check: snowflake });
			owner_id = await ask({ message: "내 디스코드 사용자 ID (이 계정의 말만 명령으로 들어요)", def: owner_id, check: snowflake });
		}
	}

	stepHeader(5, TOTAL, "웹 접속", "웹 앱을 어디서 열지 정해요. 터미널에 dotz 를 치면 어느 방식이든 이 컴퓨터에서 로그인된 채로 열려요.");
	const access = await pick({ message: "웹 앱에 어떻게 들어올까요?", options: hinted(ACCESS_CHOICES), initial: P.access === "local" && P.cloudflareHost ? "cloudflare" : P.access });
	let allow_logins: string[] = prior.web?.allow_logins ?? [];
	let cloudflare_hostname = "";
	if (access === "tailscale") {
		const ts = await prepareTailscale();
		const login = (prior.web?.allow_logins ?? [])[0] ?? ts.login;
		allow_logins = (await ask({ message: "웹 앱에 들어올 수 있는 Tailscale 로그인 (쉼표로 여러 개)", def: login, required: false })).split(",").map(s => s.trim()).filter(Boolean);
		if (!allow_logins.length) out.warn("로그인을 비워 두면 테일넷에서 들어올 수 없어요. 나중에 설정 > 웹 접속에서 정해요.");
	} else if (access === "cloudflare") {
		out.info("Cloudflare 승인은 게이트웨이를 시작한 뒤 한 번 해요. 자동 연결은 macOS + Aside + Homebrew 가 있어야 해요.");
		if (!(MAC && aside?.cli && Bun.which("brew"))) out.warn("이 컴퓨터는 자동 연결 조건이 안 돼요. 설정 > 웹 접속 > 직접 입력 으로 이어서 해요.");
		cloudflare_hostname = cleanHostname(await ask({ message: "열 주소 (예: app.example.com, 아직 몰라도 Enter)", def: P.cloudflareHost, required: false, check: hostProblem }));
	} else out.info("이 컴퓨터의 브라우저에서만 열려요. 터미널에 dotz 를 치면 로그인된 채로 열려요.");
	const machine_name = await ask({ message: `이 컴퓨터 이름 (웹 앱의 컴퓨터 목록에 보여요, ${MAX_NAME}자까지)`, def: priorMachineName || defaultMachineName, check: v => (cleanName(v).length > 0 ? undefined : "이름을 적어 주세요") });
	let peer_token = "";
	if (!existsSync(PEER_TOKEN_FILE)) {
		out.dim("같은 Tailscale 로그인의 컴퓨터는 모니터링이 저절로 짝이 맺어져요. 다른 계정의 컴퓨터와 합칠 때만 공유 키가 필요해요.");
		if (await yesNo("다른 컴퓨터의 공유 키를 붙여넣을까요?", false)) peer_token = await askSecret("다른 컴퓨터의 공유 키 (16자 이상, 화면에 안 보여요)", v => (v.length >= 16 ? undefined : "공유 키는 16자 이상이에요. ~/.dotz/secrets/peer-token 내용을 그대로 붙여넣으세요."));
	}

	stepHeader(6, TOTAL, "확인", "고른 것을 정리했어요. 맞으면 저장하고 서비스를 설치해요.");
	const defaults = {
		web_port: Number(prior.web?.port ?? 7420),
		tailscale_https_port: Number(prior.web?.tailscale_https_port ?? 8443),
		orchestrator_model: selectorFor(P, "orchestrator", models),
		lane_model: selectorFor(P, "lanes", models),
	};
	const advanced = await yesNo("포트나 모델도 바꿀까요?", false);
	const settings = advanced
		? {
				web_port: Number(await ask({ message: "로컬 포트", def: String(defaults.web_port), check: portProblem })),
				tailscale_https_port: Number(await ask({ message: "테일넷 HTTPS 포트", def: String(defaults.tailscale_https_port), check: portProblem })),
				orchestrator_model: await ask({ message: `${name} 모델:thinking`, def: defaults.orchestrator_model }),
				lane_model: await ask({ message: "세션(프로젝트 작업) 모델:thinking", def: defaults.lane_model }),
			}
		: defaults;
	const webLine = access === "tailscale" ? `Tailscale (${allow_logins.join(", ") || "로그인 없음"}), 포트 ${settings.web_port} -> ${settings.tailscale_https_port}` : access === "cloudflare" ? `Cloudflare (${cloudflare_hostname || "주소는 연결할 때 정해요"})` : `이 컴퓨터만, 포트 ${settings.web_port}`;
	const messengerLine = connect.length ? connect.map(k => TITLE[k]).join(", ") : bot_token ? "디스코드 봇 토큰 저장 (나머지는 설정에서)" : "웹·터미널만";
	note(
		[`하네스: ${harness(runtime)?.label ?? runtime}`, `봇: ${name}`, `성격: ${fit(character, 40)}`, `말투: ${fit(tone, 40)}`, `알림 문체: ${fit(notices, 40)}`, `호칭: ${address || "없음"}${avatar ? ` · 프로필 ${fit(avatar, 30)}` : ""}`, `메신저: ${messengerLine}`, `웹 접속: ${webLine}`, `이 컴퓨터: ${cleanName(machine_name)}`].join("\n"),
		"정리하면",
	);
	if (!(await yesNo("이대로 진행할까요?"))) bail();
	return {
		runtime,
		identity: { name, character, tone, notices, ...(address ? { address } : {}), ...(avatar ? { avatar } : {}) },
		owner_id,
		guild,
		bot_token,
		allow_logins,
		machine_name: cleanName(machine_name),
		...(peer_token ? { peer_token } : {}),
		...settings,
		access,
		...(cloudflare_hostname ? { cloudflare_hostname } : {}),
		connect,
	};
}

const runtimeOpt = opt("--runtime");
if (runtimeOpt && !harness(runtimeOpt)?.adapter) {
	console.error(`--runtime: ${runtimeOpt} 는 고를 수 없어요`);
	process.exit(2);
}

function fail(errors: string[]): never {
	console.error(`answers 파일 오류:\n  ${errors.join("\n  ")}`);
	process.exit(1);
}

function validate(a: Partial<Answers>): Answers {
	const checked = validateAnswers(a, P, HOME);
	return checked.ok ? checked.answers : fail(checked.errors);
}

function isThisInstallsService(file: string): boolean {
	if (!existsSync(file)) return false;
	const text = readFileSync(file, "utf8");
	return [...new Set([PKG, realpathSync(PKG)])].some(pkg => text.includes(join(pkg, "hub", "main.ts"))) && text.includes(DIR);
}

async function loadService(): Promise<void> {
	if (!MAC) {
		const r = await Bun.$`systemctl --user daemon-reload && systemctl --user enable --now ${UNIT} && systemctl --user restart ${UNIT}`.nothrow().quiet();
		if (r.exitCode === 0) out.ok("systemd: gateway started (loginctl enable-linger $USER keeps it running after logout)");
		else out.warn(`systemd: start failed: ${r.stderr.toString().trim()}`);
		return;
	}
	const uid = process.getuid?.() ?? 501;
	await Bun.$`launchctl bootout gui/${uid}/${LABEL}`.nothrow().quiet();
	for (let i = 0; i < 20 && (await Bun.$`launchctl print gui/${uid}/${LABEL}`.nothrow().quiet()).exitCode === 0; i++) await Bun.sleep(500);
	let r = await Bun.$`launchctl bootstrap gui/${uid} ${PLIST}`.nothrow().quiet();
	for (let i = 0; i < 5 && r.exitCode !== 0; i++) {
		await Bun.sleep(1000);
		r = await Bun.$`launchctl bootstrap gui/${uid} ${PLIST}`.nothrow().quiet();
	}
	if (r.exitCode === 0) out.ok("launchd: gateway loaded");
	else out.warn(`launchd: bootstrap failed: ${r.stderr.toString().trim()}`);
}

// The service file (launchd plist or systemd unit) and, with --load, its start. Returns the bun the service runs.
async function installService(load: boolean): Promise<string> {
	const bun = (await Bun.$`which bun`.nothrow().quiet()).stdout.toString().trim() || join(HOME, ".bun", "bin", "bun");
	// The service PATH reaches every installed harness CLI, whichever one config.json names now or later.
	const harnessDirs = (await detectHarnesses()).filter(d => d.found.path).map(d => dirname(d.found.path!));
	const plist = serviceFile({ home: HOME, bun, pkg: PKG, dir: DIR, pathDirs: harnessDirs, windowsDirs: windowsToolDirs() });
	const kind = MAC ? "launchd" : "systemd";
	const ours = isThisInstallsService(PLIST);
	const otherInstallsServiceKept = !load && existsSync(PLIST) && !ours;
	const plistOut = otherInstallsServiceKept ? join(DIR, MAC ? `${LABEL}.plist` : UNIT) : PLIST;
	mkdirSync(dirname(plistOut), { recursive: true });
	writeFileSync(plistOut, plist);
	const note = load ? "" : plistOut !== PLIST ? " (existing service kept; re-run with --load to install this one)" : ours ? " (PATH refreshed; the running gateway reads it at its next load: --refresh-service)" : " (not loaded; re-run with --load)";
	out.tight(`${kind}: ${plistOut}${note}`);
	if (load) {
		for (const l of installDotzCommand({ dir: DIR, pkg: PKG, bun, home: HOME, expose: true, shell: process.env.SHELL })) out.tight(l);
		await loadService();
	}
	return bun;
}

if (flag("--refresh-service")) {
	if (!isThisInstallsService(PLIST)) {
		console.log("service: not this install's service file, left alone");
		process.exit(3);
	}
	await installService(false);
	await loadService();
	process.exit(0);
}

if (args[0] === "permissions") {
	const probeBun = process.execPath;
	if (flag("--check")) printPermissions(probeBun, await checkPermissions(probeBun));
	// Exit 3: a step macOS keeps for a person is left; its one exact step was printed (the bot asks it once).
	else if ((await requestPermissions(probeBun, readLine)).length) process.exit(3);
	process.exit(0);
}

type Settled = "done" | "later" | "failed";
const failedSeen = new Set<ConnectTarget>();
const settledOf = (results: Partial<Record<ConnectTarget, Settled>>, t: ConnectTarget): Settled => (results[t] === "done" ? "done" : failedSeen.has(t) ? "failed" : (results[t] ?? "later"));

function connectUi(doneUrl: Partial<Record<ConnectTarget, string>>): ConnectUI {
	let spinner: Working | undefined;
	const settle = () => {
		spinner?.clear();
		spinner = undefined;
	};
	if (!FANCY) {
		return {
			step: (t, title, detail) => console.log(`${TITLE[t]}: ${title} ${detail}`),
			waiting: async (t, owner) => {
				console.log(`${TITLE[t]}: 내가 할 일: ${owner.label} ${owner.hint}`);
				return { action: "later" };
			},
			done: (t, url) => {
				if (url) doneUrl[t] = url;
				console.log(`${TITLE[t]}: 연결했어요${url ? ` (${url})` : ""}`);
			},
			failed: async (t, error) => {
				failedSeen.add(t);
				console.log(`${TITLE[t]}: 안 됐어요: ${error}`);
				return "later";
			},
		};
	}
	return {
		step: (t, title) => {
			if (spinner) spinner.update(`${TITLE[t]}: ${title}`);
			else spinner = working(`${TITLE[t]}: ${title}`);
		},
		waiting: async (t, owner, choices) => {
			settle();
			note(`${owner.label}\n${owner.hint}`, `${TITLE[t]}: 내가 할 일`);
			if (choices?.length) {
				const picked = await pick({ message: "고르면 계속해요", options: [...choices.map(c => ({ value: c.id, label: c.label })), { value: "\u0000later", label: "나중에 할게요" }] });
				return picked !== "\u0000later" ? { action: "continue", choice: picked } : { action: "later" };
			}
			const next = await pick({ message: "끝났으면 계속해요", options: [{ value: "continue", label: "끝냈어요, 계속해요" }, { value: "later", label: "나중에 할게요" }] });
			return next === "continue" ? { action: "continue" } : { action: "later" };
		},
		done: (t, url) => {
			settle();
			if (url) doneUrl[t] = url;
			out.ok(`${TITLE[t]}: 연결했어요${url ? ` ${url}` : ""}`);
		},
		failed: async (t, error, owner) => {
			failedSeen.add(t);
			settle();
			out.warn(`${TITLE[t]}: 안 됐어요. ${error}`);
			if (owner) note(`${owner.label}\n${owner.hint}`, `${TITLE[t]}: 내가 할 일`);
			return (await pick({ message: "어떻게 할까요?", options: [{ value: "retry", label: "다시 해 볼게요" }, { value: "later", label: "나중에 할게요" }] })) === "retry" ? "retry" : "later";
		},
	};
}

const CONNECT_TARGETS: readonly ConnectTarget[] = [...CONNECT_KEYS, "web-access"];
const resultLine = (t: ConnectTarget, r: Settled) => `${TITLE[t]}: ${r === "done" ? "연결했어요" : r === "later" ? "나중에 해요" : "안 됐어요"}`;
const connectCommand = (left: ConnectTarget[]) => `bun ${join(PKG, "setup.ts")} connect ${left.join(" ")}${dirArg}`;

if (args[0] === "connect") {
	const wanted = args.slice(1).filter((x, i, all) => !x.startsWith("-") && all[i - 1] !== "--dir");
	const bad = wanted.filter(x => !CONNECT_TARGETS.includes(x as ConnectTarget));
	if (!wanted.length || bad.length) {
		console.error(`사용법: bun setup.ts connect <${CONNECT_TARGETS.join("|")}> ... [--dir 폴더]${bad.length ? `\n알 수 없는 이름: ${bad.join(", ")}` : ""}`);
		process.exit(2);
	}
	const port = Number(prior.web?.port ?? 7420);
	if (!(await gatewayUp({ port, seconds: 3 }))) {
		console.error(`게이트웨이가 ${port} 포트에서 답하지 않아요. 먼저 시작해 주세요: bun ${join(PKG, "setup.ts")} --load${dirArg}`);
		process.exit(1);
	}
	if (FANCY) intro("메신저·웹 접속 연결");
	setCancelText("연결을 멈췄어요. 저장한 설정은 그대로예요. 이어서 하려면 같은 명령을 다시 실행해요.");
	const results = await connectAll({ dir: DIR, port, targets: wanted as ConnectTarget[], ui: connectUi({}) });
	const settled = (wanted as ConnectTarget[]).map(t => [t, settledOf(results, t)]) as [ConnectTarget, Settled][];
	if (FANCY) outro(settled.map(([t, r]) => resultLine(t, r)).join(" · "));
	else for (const [t, r] of settled) console.log(resultLine(t, r));
	process.exit(settled.some(([, r]) => r === "failed") ? 1 : 0);
}

// Web onboarding (docs/web-onboarding.md). --first-run writes the seed config.json and the first-run marker and prints the one-time address; --web-link
// prints a fresh address for an install that is still waiting for its web onboarding. The address is printed, never written to a log.
async function freePort(start: number): Promise<number> {
	for (let port = start; port < start + 100; port++) {
		const free = await new Promise<boolean>(done => {
			const probe = createServer();
			probe.once("error", () => done(false));
			probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
		});
		if (free) return port;
	}
	throw new Error(`${start} 부터 100개 포트가 모두 차 있어요`);
}
const setupUrl = (port: number, token: string) => `setup-url: http://127.0.0.1:${port}/setup?token=${token}`;
if (flag("--web-link")) {
	if (!firstRunPending(DIR)) {
		console.error("이 설치는 웹 온보딩을 기다리고 있지 않아요 (첫 실행 표시가 없거나 이미 끝났어요).");
		process.exit(1);
	}
	console.log(setupUrl(Number(prior.web?.port ?? 7420), issueToken(DIR)));
	process.exit(0);
}
if (flag("--first-run")) {
	if (existsSync(join(DIR, "config.json"))) {
		console.error("config.json 이 이미 있어요. 기존 설치에는 --first-run 을 쓰지 않아요 (온보딩을 기다리는 설치는 --web-link).");
		process.exit(1);
	}
	const port = await freePort(Number(opt("--port") ?? 7420));
	mkdirSync(DIR, { recursive: true });
	chmodSync(DIR, 0o700);
	writeFileSync(join(DIR, "config.json"), `${JSON.stringify({ web: { port, access: "local" } }, null, 2)}\n`);
	const token = issueToken(DIR);
	if (runtimeOpt) saveDraft(DIR, "start", { runtime: runtimeOpt });
	if (flag("--load")) await installService(true);
	console.log(setupUrl(port, token));
	process.exit(0);
}

if (!answersFile && !process.stdin.isTTY) {
	console.error("대화형 설정은 터미널에서만 해요. 스크립트에서는 --answers answers.json 을 쓰세요.");
	process.exit(2);
}
const given: Partial<Answers> = answersFile ? { ...(runtimeOpt ? { runtime: runtimeOpt } : {}), ...JSON.parse(readFileSync(answersFile, "utf8")) } : await interactive();
const early = validate(given);
if (answersFile) {
	await ensureHarness(early.runtime, early.install_harness === true);
	if (MAC) await prepareAside(early.install_aside === true);
	await prepareZele(early.install_aside === true);
}
const checked = answersFile ? await validateWithModels(given, P, HOME) : undefined;
const a = !checked ? early : checked.ok ? checked.answers : fail(checked.errors);
const env: Env = { dir: DIR, home: HOME, pkg: PKG, say: line => out.tight(line) };
const cloudflareLive = a.access === "cloudflare" && P.access === "cloudflare" && (!a.cloudflare_hostname || a.cloudflare_hostname === P.cloudflareHost);
const targets: ConnectTarget[] = [...a.connect, ...(a.access === "cloudflare" && !cloudflareLive ? (["web-access"] as const) : [])];
setCancelText(`중단했어요. 저장한 설정은 그대로예요.${targets.length ? ` 남은 연결은 ${connectCommand(targets)} 로 이어서 해요.` : ""}`);
if (FANCY) out.info("저장하고 서비스를 준비해요.");
writeSecrets(env, a);
if (a.runtime === "omp") out.tight(`omp 모델: ${a.orchestrator_model} (봇), ${a.lane_model} (세션)`);
writeConfig(env, a, P);
markTerminalDone(DIR, Object.keys(prior).length === 0);

const ompInstalled = await linkOmp(env);

const bun = await installService(flag("--load"));

const wantServe = a.access === "tailscale" && (flag("--tailscale") || !answersFile);
const { tsNow } = await serveTailnet(env, a, wantServe);
if (answersFile && a.access === "tailscale" && !a.allow_logins.length) out.warn("allow_logins 가 비어 있어서 테일넷에서는 아무도 들어올 수 없어요. 웹 앱은 이 컴퓨터에서만 열려요.");

if (MAC && answersFile) {
	console.log("macOS 권한 상태 (bun 이 launchd 로 도는 프로그램이라 bun 앞으로 묻고 허용돼요):");
	printPermissions(bun, await checkPermissions(bun));
	console.log("빠진 권한은 bun setup.ts permissions 로 켜요: 창을 열고 스위치와 허용까지 직접 눌러요 (종료 코드 3이면 사람이 할 한 단계만 남은 거예요).");
} else if (MAC && realUiBlocked()) {
	out.info("macOS 권한 상태 (이 환경에서는 창을 열지 않고 상태만 봐요):");
	printPermissions(bun, await checkPermissions(bun), line => out.tight(line));
} else if (MAC) {
	out.info("macOS 권한. 게이트웨이가 쓰는 권한을 지금 한 번에 허용해요 (나중에 bun setup.ts permissions 로 다시 할 수 있어요).");
	await requestPermissions(bun, readLine, undefined, undefined, line => out.tight(line));
}

const waitFor = async (url: string, seconds: number) => {
	for (let i = 0; i < seconds; i++) {
		const r = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
		if (r && r.status < 500) return true;
		await Bun.sleep(1000);
	}
	return false;
};

const doneUrl: Partial<Record<ConnectTarget, string>> = {};
let results: Partial<Record<ConnectTarget, Settled>> = {};
let gatewayRunning = false;
if (flag("--load")) {
	gatewayRunning = FANCY ? await whileWorking("게이트웨이가 뜨길 기다리는 중...", () => gatewayUp({ port: a.web_port, seconds: 40 })) : await gatewayUp({ port: a.web_port, seconds: 40 });
	if (!gatewayRunning) out.warn("게이트웨이가 아직 안 떴어요. 1분쯤 뒤에 아래 명령으로 연결을 이어서 해요.");
	else {
		if (a.access !== "cloudflare" && a.access !== P.access) {
			const switched = await switchAccess({ dir: DIR, port: a.web_port, mode: a.access });
			if (!switched.ok) out.warn(`웹 접속을 ${a.access === "tailscale" ? "Tailscale" : "이 컴퓨터만"}로 바꾸지 못했어요: ${switched.error ?? "알 수 없는 오류"}. 설정 > 웹 접속에서 바꿔 주세요.`);
		}
		if (targets.length) results = await connectAll({ dir: DIR, port: a.web_port, targets, ...(a.cloudflare_hostname ? { hostname: a.cloudflare_hostname } : {}), ui: connectUi(doneUrl) });
	}
}
if (P.access === "cloudflare" && a.access !== "cloudflare" && !gatewayRunning) out.warn(`지금 열려 있는 웹 접속은 아직 Cloudflare 예요. 게이트웨이를 켠 뒤 설정 > 웹 접속에서 ${a.access === "tailscale" ? "Tailscale" : "이 컴퓨터만"}으로 바꿔요.`);

const localUrl = `http://127.0.0.1:${a.web_port}/`;
const webUrl = a.access === "tailscale" ? await tailnetUrl(a.tailscale_https_port) : "";
const left = targets.filter(t => results[t] !== "done");
const runtimeLabel = harness(a.runtime)?.label ?? a.runtime;
const discordDone = results.discord === "done";
const closing = [`${a.identity.name} 준비가 끝났어요. ${runtimeLabel}로 돌아가요.${discordDone ? ` 디스코드에서는 ${a.identity.name} 카테고리의 대화 채널에 말을 걸면 돼요.` : ""}${ompInstalled ? ` omp 터미널에서도 "${a.identity.name}모드 켜"라고 하면 그 터미널이 ${a.identity.name}와(과) 연결돼요.` : ""}`];

let openUrl = "";
const where: string[] = [];
if (a.access === "tailscale") {
	const served = Boolean(tsNow?.running);
	const up = served && flag("--load") && gatewayRunning && (await waitFor(localUrl, 40)) && webUrl !== "" && (await waitFor(webUrl, 15));
	const why = !served ? (wantServe ? "Tailscale 을 켜고 bun setup.ts --tailscale 을 실행하면 열려요" : "bun setup.ts --tailscale 로 테일넷에 열어요") : !flag("--load") ? "게이트웨이를 시작하면 열려요" : up ? "" : "게이트웨이가 아직 뜨는 중이에요. 1분쯤 뒤에 열어 보세요";
	where.push(`웹 앱 주소: ${webUrl || "Tailscale 주소를 아직 못 읽었어요"}${why ? `  (${why})` : ""}`);
	if (a.allow_logins[0]) where.push(`휴대폰이나 다른 컴퓨터에서는 같은 Tailscale 계정(${a.allow_logins[0]})으로 로그인한 뒤 이 주소를 열어요.`);
	if (up) openUrl = webUrl;
} else if (a.access === "cloudflare") {
	const host = a.cloudflare_hostname || P.cloudflareHost;
	const live = results["web-access"] === "done" ? (doneUrl["web-access"] ?? `https://${host}`) : cloudflareLive && host ? `https://${host}` : "";
	where.push(live ? `웹 앱 주소: ${live}` : `웹 앱 주소: 아직 없어요${host ? ` (${host} 연결을 마치면 열려요)` : " (Cloudflare 연결을 마치면 열려요)"}`);
	if (live) openUrl = live;
} else {
	where.push(`웹 앱 주소: ${localUrl}`);
	if (flag("--load") && gatewayRunning && (await waitFor(localUrl, 40))) openUrl = localUrl;
}
where.push(`이 컴퓨터에서는 터미널에 dotz 를 치면 로그인된 채로 열려요${flag("--load") ? "" : " (게이트웨이를 시작하면 생겨요)"}.`);
where.push("문제가 있으면 dotz status 로 상태를 보고, dotz restart 로 다시 시작해요.");
const connections = targets.map(t => resultLine(t, settledOf(results, t)));
const nextSteps = [...(flag("--load") ? [] : [`게이트웨이 시작: bun ${join(PKG, "setup.ts")} --load${dirArg}`]), ...(left.length ? [`이어서 연결: ${connectCommand(left)}`] : [])];
if (FANCY) {
	note([...where, ...(connections.length ? ["", ...connections] : []), ...(nextSteps.length ? ["", ...nextSteps] : [])].join("\n"), "이제 이렇게 열어요");
	outro(closing[0]);
} else {
	for (const l of nextSteps) console.log(l);
	console.log(`\n끝! ${closing[0]}`);
	for (const l of connections) console.log(l);
	console.log("");
	for (const l of where) console.log(l);
}
if (flag("--open") && openUrl) await Bun.$`${openerCommand(openUrl)}`.nothrow().quiet();
