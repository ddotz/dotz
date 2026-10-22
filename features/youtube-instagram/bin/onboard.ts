// One-sentence onboarding of the YouTube + Instagram feature (DESIGN.md R4): `run`, `status`, `reset [step]`.
// A resumable state machine (state in SNS_DIR/onboard.json). Every external effect goes through an injected runner:
// `aside` (exec = navigation task, repl = read a value out of a page and POST it to the one-shot receiver), `ctx.exec`
// (brew and version checks), `ctx.fetch` (gateway, Google, Instagram), `otp` (Messages codes) and the OAuth loopback.
// Secrets never reach argv, an aside task text, a model or a log: they travel page -> localhost receiver -> 0600 file,
// and a verification code travels Messages -> one-shot localhost URL -> `const secret` inside `aside repl`.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Config, type Ctx, loadConfig, paths, readJson, realCtx, secretsDir, snsDir, validateConfig, writeJson } from "../lib/config.ts";
import { me } from "../lib/instagram.ts";
import { MESSAGES_DB, MessagesAccessError, type OtpService, probeMessages, waitForCode } from "../lib/otp.ts";
import { serveOnce, startReceiver } from "../lib/receiver.ts";
import { AuthError } from "../lib/watchkit.ts";
import { accessToken, channelStats, myChannel } from "../lib/youtube.ts";
import { run as cardRun } from "./card.ts";
import { defaultLoopback, gateway, type Loopback, run as setupRun } from "./setup.ts";

export type Result = { lines: string[]; code: number };
export type Aside = { exec: (task: string) => Promise<string>; repl: (body: string) => Promise<unknown> };
export type OtpSource = { probe: () => void; wait: (service: OtpService, since: Date) => Promise<string | undefined> };
export type Deps = { ctx: Ctx; aside: Aside; otp: OtpSource; loopback?: () => Loopback };

type Platform = "youtube" | "instagram";
type StepId = "deps" | "youtube-client" | "youtube-auth" | "instagram-account" | "instagram-token" | "detect" | "apply" | "test-read" | "done";
type Status = "pending" | "done" | "needs-owner" | "failed";
type StepState = { status: Status; at: string; note: string; soft?: boolean };
type State = { steps: Partial<Record<StepId, StepState>>; platforms: Platform[]; asks: string[] };
type Out = { status: Status; note: string; ask?: string; soft?: boolean };
type Run = { d: Deps; platforms: Platform[]; started: Date; target: string };
type StepDef = { id: StepId; label: string; platform?: Platform; requires: StepId[]; run: (r: Run) => Promise<Out> };

const UPDATE_KEY = "sns-onboarding";
const ICON: Record<Status, string> = { done: "✅", pending: "⏳", "needs-owner": "❓", failed: "❌" };
const CLIENT_FILE = () => join(secretsDir(), "youtube-client.json");
const IG_STAGING = () => join(secretsDir(), "instagram-token-new.json");
const stateFile = () => join(snsDir(), "onboard.json");
const AUTH_GRACE_MS = 30_000;
const RECEIVE_WAIT_MS = 15_000;
const LOGIN_WAIT_MS = 4 * 60_000;

const PROTOCOL =
	"\n\n비밀번호, 토큰, 인증 코드 같은 값은 읽거나 옮겨 적거나 말하지 않아요. 백그라운드 탭에서 해요. 마지막 줄에는 다음 중 하나만 적어요.\n" +
	"RESULT: DONE\nRESULT: NEEDS_OWNER <한 줄 이유>\nRESULT: NEEDS_CODE <google 또는 instagram>\nRESULT: FAILED <한 줄 이유>\n" +
	"비밀번호를 물으면 NEEDS_OWNER, 문자나 이메일로 온 인증 코드를 물으면 NEEDS_CODE로 멈춰요.";

type Verdict = { kind: "done" } | { kind: "owner" | "failed"; reason: string } | { kind: "code"; service: OtpService };

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/[A-Za-z0-9_-]{24,}/g, "…").trim().slice(0, 100);

function verdict(text: string): Verdict {
	const m = [...text.matchAll(/RESULT:\s*(DONE|NEEDS_OWNER|NEEDS_CODE|FAILED)\b[ \t]*([^\n]*)/g)].at(-1);
	if (!m) return { kind: "failed", reason: "Aside가 끝났다고 알려 주지 않았어요" };
	if (m[1] === "DONE") return { kind: "done" };
	if (m[1] === "NEEDS_CODE") return { kind: "code", service: /google/i.test(m[2]!) ? "google" : /instagram|facebook|meta/i.test(m[2]!) ? "instagram" : "generic" };
	return { kind: m[1] === "NEEDS_OWNER" ? "owner" : "failed", reason: clean(m[2]!) || "이유를 알려 주지 않았어요" };
}

// ---- real runners ----------------------------------------------------------------------------------------------------

export function realAside(ctx: Ctx): Aside {
	let started = false;
	const ensure = async () => {
		if (started) return;
		if ((await ctx.exec(["pgrep", "-x", "Aside"])).code !== 0) await ctx.exec(["open", "-g", "-j", "-a", "Aside"]);
		started = true;
	};
	return {
		exec: async task => {
			await ensure();
			const r = await ctx.exec(["aside", "exec", task], { timeoutMs: 15 * 60_000 });
			return r.stdout || r.stderr;
		},
		repl: async body => {
			await ensure();
			const code = `try { const dzOut = await (async () => {\n${body}\n})(); console.log("RESULT " + JSON.stringify({ data: dzOut ?? null })); } catch (e) { console.log("RESULT " + JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) })); }`;
			const r = await ctx.exec(["aside", "repl", code], { timeoutMs: 118_000 });
			const m = [...r.stdout.matchAll(/^.*?RESULT (\{.*\})\s*$/gm)].at(-1);
			if (!m) throw new Error("aside repl가 답하지 않았어요");
			const j = JSON.parse(m[1]!);
			if (j.error) throw new Error(String(j.error));
			return j.data;
		},
	};
}

export function realOtp(ctx: Ctx, db: string = MESSAGES_DB()): OtpSource {
	return { probe: () => probeMessages(db), wait: (service, since) => waitForCode({ db, service, since, sleep: ctx.sleep }) };
}

// ---- helpers shared by the steps -------------------------------------------------------------------------------------

const readBody = (host: string, pats: Record<string, string>, postUrl: string) => `
const tabs = await getTabs();
let text = "";
for (const t of tabs) {
  const u = String(typeof t.url === "function" ? t.url() : t.url);
  if (!u.includes(${JSON.stringify(host)})) continue;
  text += "\\n" + await t.evaluate(() => document.body.innerText);
}
const pats = ${JSON.stringify(pats)};
const found = {};
for (const [k, p] of Object.entries(pats)) { const m = new RegExp(p).exec(text); if (m) found[k] = m[1] ?? m[0]; }
if (Object.keys(found).length !== Object.keys(pats).length) return { ok: false };
const res = await fetch(${JSON.stringify(postUrl)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(found) });
return { ok: res.ok };`;

const codeBody = (url: string) => `
const secret = await (await fetch(${JSON.stringify(url)})).text();
const sel = 'input[autocomplete="one-time-code"], input[name="idvPin"], input[name="Pin"], input[name="confirmationCode"], input[name="verificationCode"], input[inputmode="numeric"], input[type="tel"]';
for (const t of await getTabs()) {
  const box = t.locator(sel).first();
  if (await box.count()) { await box.fill(secret); await box.press("Enter"); return { ok: true }; }
}
return { ok: false };`;

async function enterCode(d: Deps, service: OtpService, since: Date): Promise<boolean> {
	const code = await d.otp.wait(service, since);
	if (!code) return false;
	const once = serveOnce(code);
	try {
		await d.aside.repl(codeBody(once.url));
	} finally {
		once.stop();
	}
	return true;
}

// Runs an aside task; when it stops at a verification-code prompt, fetches the code from Messages and types it in through
// `aside repl`, then lets the task continue (at most 3 rounds).
async function drive(r: Run, task: string, noCodeAsk: string): Promise<Verdict> {
	let text = task;
	for (let round = 0; round < 3; round++) {
		const v = verdict(await r.d.aside.exec(text + PROTOCOL));
		if (v.kind !== "code") return v;
		if (!(await enterCode(r.d, v.service, r.started))) return { kind: "owner", reason: noCodeAsk };
		text = `${task}\n\n인증 코드는 이미 입력 칸에 넣었어요. 화면 상태를 보고 남은 단계만 이어서 해요.`;
	}
	return { kind: "failed", reason: "인증 코드를 여러 번 물어요" };
}

const fromVerdict = (v: Verdict, what: string, owner: string): Out | undefined => {
	if (v.kind === "done") return undefined;
	if (v.kind === "owner") return { status: "needs-owner", note: v.reason, ask: `${owner} (${v.reason})` };
	if (v.kind === "failed") return { status: "failed", note: `${what}: ${v.reason}` };
	return { status: "failed", note: what };
};

async function receive(r: Run, file: string, fields: string[], body: (url: string) => string): Promise<boolean> {
	const rcv = startReceiver({ file, fields, waitMs: RECEIVE_WAIT_MS, sleep: r.d.ctx.sleep });
	try {
		const res = (await r.d.aside.repl(body(rcv.url))) as { ok?: boolean } | null;
		if (!res?.ok) return false;
		await rcv.done;
		return true;
	} catch {
		return false;
	} finally {
		rcv.stop();
	}
}

const has = (file: string, keys: string[]) => {
	try {
		const j = readJson<Record<string, unknown>>(file);
		return Boolean(j) && keys.every(k => typeof j![k] === "string" && j![k]);
	} catch {
		return false;
	}
};

// ---- steps -----------------------------------------------------------------------------------------------------------

async function stepDeps(r: Run): Promise<Out> {
	const { ctx, aside, otp } = r.d;
	const ok = async (argv: string[]) => (await ctx.exec(argv)).code === 0;
	if (!(await ok(["bun", "--version"]))) return { status: "failed", note: "bun을 찾지 못했어요" };
	try {
		await aside.repl("return 1");
	} catch {
		return { status: "failed", note: "Aside가 답하지 않아요. Aside 앱에 브라우저 창이 하나 열려 있어야 해요" };
	}
	const need = [(await ok(["ffprobe", "-version"])) ? "" : "ffmpeg", r.platforms.includes("instagram") && !(await ok(["cloudflared", "--version"])) ? "cloudflared" : ""].filter(Boolean);
	if (need.length) {
		if (!(await ok(["brew", "--version"]))) return { status: "failed", note: `Homebrew가 없어서 ${need.join(", ")}를 설치하지 못했어요` };
		const inst = await ctx.exec(["brew", "install", ...need], { timeoutMs: 15 * 60_000 });
		if (inst.code !== 0) return { status: "failed", note: `${need.join(", ")} 설치에 실패했어요` };
	}
	try {
		otp.probe();
	} catch (e) {
		if (e instanceof MessagesAccessError)
			return { status: "needs-owner", soft: true, note: need.length ? `${need.join(", ")}를 설치했어요. 문자 읽기 권한은 아직이에요` : "문자 읽기 권한이 아직 없어요", ask: "Mac 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한에서 bun을 켜 주세요 (인증 코드를 문자에서 읽으려고 해요. 안 켜면 코드가 올 때마다 알려 주셔야 해요)" };
		throw e;
	}
	return { status: "done", note: need.length ? `${need.join(", ")}를 설치했어요` : "다 갖춰져 있어요" };
}

async function stepYoutubeClient(r: Run): Promise<Out> {
	if (has(CLIENT_FILE(), ["client_id", "client_secret"]) || has(paths.ytOauth(), ["client_id", "client_secret"])) return { status: "done", note: "이미 있어요" };
	const task =
		"Google Cloud Console(console.cloud.google.com)에서 차례로 해요. " +
		"1) 프로젝트 'dotz-youtube'를 만들고, 이미 있으면 그걸 써요. 2) YouTube Data API v3를 사용 설정해요. " +
		"3) OAuth 동의 화면을 외부(External)로 만들고 앱 이름은 'dotz', 지원 이메일과 개발자 연락처는 지금 로그인된 구글 계정으로 해요. " +
		"4) 앱을 '프로덕션으로 게시'해요. 테스트 상태로 두면 로그인이 7일 뒤에 풀려요. " +
		"5) 사용자 인증 정보에서 OAuth 클라이언트 ID를 '데스크톱 앱' 유형으로 만들어요. " +
		"6) 만들고 나면 클라이언트 ID와 보안 비밀번호가 보이는 창이 열려 있어요. 그 창을 닫지 말고 멈춰요.";
	const v = await drive(r, task, "구글에서 문자로 온 인증 코드를 알려 주세요");
	const bad = fromVerdict(v, "구글 클라우드 설정", "Aside에서 구글 계정에 로그인해 주세요");
	if (bad) return bad;
	const ok = await receive(r, CLIENT_FILE(), ["client_id", "client_secret"], url =>
		readBody("console.cloud.google.com", { client_id: "(\\d+-[a-z0-9]+\\.apps\\.googleusercontent\\.com)", client_secret: "(GOCSPX-[A-Za-z0-9_-]+)" }, url),
	);
	return ok ? { status: "done", note: "OAuth 클라이언트를 만들었어요" } : { status: "failed", note: "화면에서 클라이언트 값을 읽지 못했어요" };
}

async function stepYoutubeAuth(r: Run): Promise<Out> {
	if (has(paths.ytOauth(), ["refresh_token"])) return { status: "done", note: "이미 로그인돼 있어요" };
	let abort!: (q: URLSearchParams) => void;
	const aborted = new Promise<URLSearchParams>(res => (abort = res));
	const base = (r.d.loopback ?? defaultLoopback)();
	const lb: Loopback = { ...base, redirect: Promise.race([base.redirect, aborted]) };
	let flow: Promise<Verdict> | undefined;
	const res = await setupRun(r.d.ctx, ["youtube-auth", "--client", CLIENT_FILE()], {
		loopback: () => lb,
		waitMs: LOGIN_WAIT_MS,
		onLine: l => {
			if (!l.startsWith("open ")) return;
			const task = `다음 주소를 열어요: ${l.slice(5)}\n구글 로그인 화면이 나오면 이미 로그인된 계정을 골라요. '확인되지 않은 앱' 경고가 나오면 '고급'을 누르고 '이동(안전하지 않음)'을 눌러요. 권한 요청 화면에서는 유튜브 관리 권한을 허용해요. 연결됐다는 안내가 나오면 끝이에요.`;
			flow = drive(r, task, "구글에서 문자로 온 인증 코드를 알려 주세요").then(
				v => {
					if (v.kind !== "done") abort(new URLSearchParams({ error: "aside" }));
					else void r.d.ctx.sleep(AUTH_GRACE_MS).then(() => abort(new URLSearchParams({ error: "grace" })));
					return v;
				},
				(e: Error) => {
					abort(new URLSearchParams({ error: "aside" }));
					return { kind: "failed", reason: clean(e.message) } as Verdict;
				},
			);
		},
	});
	if (res.code === 0) return { status: "done", note: res.lines.at(-1)?.replace(/^youtube-connected \S+ /, "채널 ") ?? "연결했어요" };
	const v = await flow;
	const bad = v && fromVerdict(v, "유튜브 로그인", "Aside에서 구글 계정에 로그인하고 권한을 허용해 주세요");
	return bad || { status: "failed", note: `유튜브 로그인에 실패했어요 (${clean(res.lines.at(-1) ?? "")})` };
}

async function stepInstagramAccount(r: Run): Promise<Out> {
	if (has(paths.instagram(), ["access_token"])) return { status: "done", note: "이미 연결돼 있어요" };
	const task =
		"instagram.com에서 로그인된 계정이 프로페셔널(크리에이터 또는 비즈니스) 계정인지 설정에서 확인해요. " +
		"아니면 설정 > 계정 유형 및 도구 > 프로페셔널 계정으로 전환에서 '크리에이터'로 바꿔요. 이미 프로페셔널이면 아무것도 바꾸지 않아요.";
	const v = await drive(r, task, "인스타에서 온 인증 코드를 알려 주세요");
	return fromVerdict(v, "인스타 계정 확인", "Aside에서 인스타그램에 로그인해 주세요") ?? { status: "done", note: "프로페셔널 계정이에요" };
}

async function stepInstagramToken(r: Run): Promise<Out> {
	if (has(paths.instagram(), ["access_token"])) return { status: "done", note: "이미 있어요" };
	const task =
		"developers.facebook.com에서 차례로 해요. 1) 개발자로 등록이 안 돼 있으면 등록해요. 2) 앱 'dotz-instagram'을 만들어요. 사용 사례는 'Instagram API with Instagram Login'을 골라요. " +
		"3) 앱 대시보드 Instagram > API 설정에서 지금 로그인된 인스타 계정을 추가하고, 초대가 오면 수락해요. 4) '토큰 생성'을 눌러 장기 토큰이 화면에 보이게 해요. 그 창을 닫지 말고 멈춰요.";
	const v = await drive(r, task, "메타에서 온 인증 코드를 알려 주세요");
	const bad = fromVerdict(v, "인스타 토큰 만들기", "Aside에서 페이스북/메타 개발자 계정에 로그인해 주세요");
	if (bad) return bad;
	const ok = await receive(r, IG_STAGING(), ["access_token"], url => readBody("developers.facebook.com", { access_token: "\\b(IG[A-Za-z0-9_-]{60,})" }, url));
	if (!ok) return { status: "failed", note: "화면에서 토큰을 읽지 못했어요" };
	try {
		const res = await setupRun(r.d.ctx, ["instagram-token", "--from", IG_STAGING()]);
		return res.code === 0 ? { status: "done", note: res.lines.at(-1)?.replace(/^instagram-connected \S+ /, "@") ?? "연결했어요" } : { status: "failed", note: `토큰 확인에 실패했어요 (${clean(res.lines.at(-1) ?? "")})` };
	} finally {
		rmSync(IG_STAGING(), { force: true });
	}
}

async function stepDetect(r: Run): Promise<Out> {
	const parts: string[] = [];
	if (r.platforms.includes("youtube")) {
		const ch = await myChannel(r.d.ctx, await accessToken(r.d.ctx));
		parts.push(`유튜브 ${ch.title}`);
	}
	if (r.platforms.includes("instagram")) parts.push(`인스타 @${(await me(r.d.ctx)).username}`);
	return { status: "done", note: parts.join(", ") };
}

async function stepApply(r: Run): Promise<Out> {
	// A work channel given as the progress target also owns the project and the watches.
	const flags = [...r.platforms.map(p => `--${p}`), ...(r.target.startsWith("ch:") ? ["--channel", r.target] : [])];
	const res = await setupRun(r.d.ctx, ["apply", ...flags]);
	return res.code === 0 ? { status: "done", note: "설정, 카드, 프로젝트, 감시를 켰어요" } : { status: "failed", note: `설정 적용에 실패했어요 (${clean(res.lines.at(-1) ?? "")})` };
}

async function stepTestRead(r: Run): Promise<Out> {
	const cfg: Config = loadConfig();
	const parts: string[] = [];
	if (cfg.youtube) parts.push(`구독자 ${(await channelStats(r.d.ctx, cfg.youtube.channel_id)).subscribers}명`);
	if (cfg.instagram) parts.push(`팔로워 ${(await me(r.d.ctx)).followers}명`);
	const card = await cardRun(r.d.ctx);
	if (card.code !== 0) return { status: "failed", note: "홈 카드가 읽히지 않아요" };
	return { status: "done", note: parts.join(", ") || "읽기 시험을 통과했어요" };
}

async function stepDone(): Promise<Out> {
	const cfg = readJson<Config>(paths.config());
	const names = [cfg?.youtube && `유튜브 ${cfg.youtube.title ?? ""}`.trim(), cfg?.instagram && `인스타 @${cfg.instagram.username}`].filter(Boolean);
	return { status: "done", note: `${names.join(", ")} 연결을 마쳤어요` };
}

const STEPS: StepDef[] = [
	{ id: "deps", label: "준비물 확인", requires: [], run: stepDeps },
	{ id: "youtube-client", label: "구글 클라우드 앱 만들기", platform: "youtube", requires: [], run: stepYoutubeClient },
	{ id: "youtube-auth", label: "유튜브 로그인", platform: "youtube", requires: ["youtube-client"], run: stepYoutubeAuth },
	{ id: "instagram-account", label: "인스타 계정 종류 확인", platform: "instagram", requires: [], run: stepInstagramAccount },
	{ id: "instagram-token", label: "인스타 토큰 받기", platform: "instagram", requires: ["instagram-account"], run: stepInstagramToken },
	{ id: "detect", label: "계정 확인", requires: ["youtube-auth", "instagram-token"], run: stepDetect },
	{ id: "apply", label: "설정과 감시 켜기", requires: ["detect"], run: stepApply },
	{ id: "test-read", label: "읽기 시험", requires: ["apply"], run: stepTestRead },
	{ id: "done", label: "마무리", requires: ["test-read"], run: stepDone },
];

const activeSteps = (platforms: Platform[]) => STEPS.filter(s => !s.platform || platforms.includes(s.platform));
const requiresOf = (s: StepDef, platforms: Platform[]) => ["deps" as StepId, ...s.requires].filter(id => id !== s.id && activeSteps(platforms).some(a => a.id === id));

// ---- state and output ------------------------------------------------------------------------------------------------

function loadState(): State {
	try {
		const s = readJson<State>(stateFile());
		if (s && typeof s === "object" && s.steps) return { steps: s.steps, platforms: s.platforms ?? [], asks: s.asks ?? [] };
	} catch {}
	return { steps: {}, platforms: [], asks: [] };
}
const saveState = (s: State) => writeJson(stateFile(), s);

const stepLine = (def: StepDef, st?: StepState) => `${ICON[st?.status ?? "pending"]} ${def.label}${st?.note ? ` - ${st.note}` : ""}`;
const checklist = (s: State) => activeSteps(s.platforms).map(d => stepLine(d, s.steps[d.id]));

function askBlock(s: State): string[] {
	const asks = activeSteps(s.platforms).flatMap(d => (s.steps[d.id]?.status === "needs-owner" && d.id ? [s.asks.find(a => a.startsWith(`${d.id}|`))?.slice(d.id.length + 1)] : [])).filter((a): a is string => Boolean(a));
	if (!asks.length) return [];
	return [`확인이 필요한 게 ${asks.length}가지 있어요`, ...asks.map((a, i) => `${i + 1}. ${a}`), "끝나면 알려 주세요. 이어서 진행해요"];
}

async function sendProgress(d: Deps, target: string, s: State, finished: boolean): Promise<void> {
	const text = `${finished ? "유튜브·인스타 연결 결과예요" : "유튜브·인스타 연결을 진행 중이에요"}\n${checklist(s).join("\n")}`;
	try {
		await gateway(d.ctx, "POST", "/api/send", { target, update_key: UPDATE_KEY, text });
	} catch {}
}

function parseArgs(args: string[]): { cmd: string; flags: Map<string, string | true>; rest: string[] } {
	const flags = new Map<string, string | true>();
	const rest: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const a = args[i]!;
		if (!a.startsWith("--")) {
			rest.push(a);
			continue;
		}
		const next = args[i + 1];
		if (a === "--target" && next && !next.startsWith("--")) {
			flags.set("target", next);
			i++;
		} else flags.set(a.slice(2), true);
	}
	return { cmd: args[0] ?? "", flags, rest };
}

// ---- commands --------------------------------------------------------------------------------------------------------

async function cmdRun(d: Deps, flags: Map<string, string | true>): Promise<Result> {
	const state = loadState();
	const asked = (["youtube", "instagram"] as Platform[]).filter(p => flags.get(p));
	state.platforms = asked.length ? asked : state.platforms.length ? state.platforms : ["youtube", "instagram"];
	if (flags.get("dry-run")) {
		return { code: 0, lines: ["미리보기예요. 아무것도 바꾸지 않았어요", ...activeSteps(state.platforms).map(def => `⏳ ${def.label}`)] };
	}
	const target = typeof flags.get("target") === "string" ? (flags.get("target") as string) : "chat";
	const started = d.ctx.now();
	const r: Run = { d, platforms: state.platforms, started, target };
	const ok = (id: StepId) => state.steps[id]?.status === "done" || (state.steps[id]?.status === "needs-owner" && state.steps[id]?.soft === true);

	saveState(state);
	await sendProgress(d, target, state, false);
	for (const def of activeSteps(state.platforms)) {
		if (state.steps[def.id]?.status === "done") continue;
		const at = () => d.ctx.now().toISOString();
		if (!requiresOf(def, state.platforms).every(ok)) {
			state.steps[def.id] = { status: "pending", at: at(), note: "앞 단계가 끝나야 해요" };
			continue;
		}
		let out: Out;
		try {
			out = await def.run(r);
		} catch (e) {
			out = { status: "failed", note: e instanceof AuthError ? "로그인이 풀렸어요" : clean((e as Error).message) };
		}
		state.steps[def.id] = { status: out.status, at: at(), note: out.note, ...(out.soft ? { soft: true } : {}) };
		state.asks = state.asks.filter(a => !a.startsWith(`${def.id}|`));
		if (out.status === "needs-owner" && out.ask) state.asks.push(`${def.id}|${out.ask}`);
		saveState(state);
		await sendProgress(d, target, state, false);
	}
	const steps = activeSteps(state.platforms);
	const finished = steps.every(s => state.steps[s.id]?.status === "done");
	await sendProgress(d, target, state, true);
	const ask = askBlock(state);
	const failed = steps.some(s => state.steps[s.id]?.status === "failed");
	return { code: ask.length ? 3 : failed || !finished ? 1 : 0, lines: [...checklist(state), ...ask] };
}

function cmdStatus(): Result {
	const s = loadState();
	if (!s.platforms.length) return { code: 0, lines: ["아직 연결을 시작하지 않았어요. 채팅에서 유튜브·인스타 연결을 요청해 주세요"] };
	return { code: 0, lines: checklist(s) };
}

const OWNED_SECRET: Partial<Record<StepId, () => string>> = { "youtube-client": CLIENT_FILE, "youtube-auth": paths.ytOauth, "instagram-token": paths.instagram };

function cmdReset(rest: string[]): Result {
	const s = loadState();
	const platforms = s.platforms.length ? s.platforms : (["youtube", "instagram"] as Platform[]);
	const lines: string[] = [];
	const reopen = new Set<StepId>();
	if (!rest[0]) STEPS.forEach(d => reopen.add(d.id));
	else {
		const first = STEPS.find(d => d.id === rest[0]);
		if (!first) return { code: 1, lines: [`단계 이름을 모르겠어요. ${STEPS.map(d => d.id).join(", ")} 중 하나예요`] };
		reopen.add(first.id);
		for (const d of STEPS) if (requiresOf(d, platforms).some(id => reopen.has(id))) reopen.add(d.id);
	}
	for (const id of reopen) {
		delete s.steps[id];
		s.asks = s.asks.filter(a => !a.startsWith(`${id}|`));
		const secret = rest[0] ? OWNED_SECRET[id]?.() : undefined;
		if (secret) {
			rmSync(secret, { force: true });
			lines.push(`${STEPS.find(d => d.id === id)!.label}의 로그인 정보를 지웠어요`);
		}
	}
	saveState(s);
	lines.push(rest[0] ? `${[...reopen].join(", ")} 단계를 다시 열었어요` : "처음부터 다시 하도록 비웠어요");
	return { code: 0, lines };
}

export async function run(d: Deps, args: string[]): Promise<Result> {
	const { cmd, flags, rest } = parseArgs(args);
	if (cmd === "run") return cmdRun(d, flags);
	if (cmd === "status") return cmdStatus();
	if (cmd === "reset") return cmdReset(rest);
	return { code: 1, lines: ["명령은 run, status, reset 중 하나예요"] };
}

if (import.meta.main) {
	const ctx = realCtx();
	const { lines, code } = await run({ ctx, aside: realAside(ctx), otp: realOtp(ctx) }, process.argv.slice(2));
	for (const l of lines) console.log(l);
	process.exit(code);
}
