// One-sentence onboarding of the YouTube + Instagram feature (DESIGN.md R4): `run`, `status`, `reset [step]`.
// A resumable state machine (state in SNS_DIR/onboard.json). Every external effect goes through an injected runner:
// `aside.repl` (our own code drives a background tab: wizard pages are explicit steps with selectors and state checks, see
// lib/pages.ts; the Aside agent `aside exec` is never used, it spends Aside's own rate limit), `ctx.exec` (brew and version
// checks), `ctx.fetch` (gateway, Google, Instagram), `otp` (Messages codes) and the OAuth loopback.
// A login page, a code prompt that cannot be answered or any page a step does not know stops that step with an owner ask
// (exit 3); nothing is guessed. Secrets never reach argv, a model or a log: they travel page -> localhost receiver -> 0600
// file, and a verification code travels Messages -> one-shot localhost URL -> `const secret` inside `aside repl`.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { asideReason } from "../../../hub/aside-errors.ts";
import { legacyGate } from "../lib/legacy.ts";
import { type Config, type Ctx, loadConfig, paths, readJson, realCtx, secretsDir, snsDir, validateConfig, writeJson } from "../lib/config.ts";
import { me } from "../lib/instagram.ts";
import { MESSAGES_DB, MessagesAccessError, type OtpService, probeMessages, waitForCode } from "../lib/otp.ts";
import { CODE_HOSTS, codeBody, gcpApi, gcpApiUrl, gcpClient, gcpClientUrl, gcpConsent, gcpConsentFlow, gcpConsentUrl, GCP_PROJECT_URL, gcpProject, gcpPublish, gcpPublishUrl, IG_ACCOUNT_URL, igAccount, igToken, igTokenUrl, META_APPS_URL, metaApp, type PageResult, pageBody } from "../lib/pages.ts";
import { serveOnce, startReceiver } from "../lib/receiver.ts";
import { AuthError } from "../lib/watchkit.ts";
import { accessToken, channelStats, myChannel } from "../lib/youtube.ts";
import { run as cardRun } from "./card.ts";
import { defaultLoopback, gateway, type Loopback, run as setupRun } from "./setup.ts";

export type Result = { lines: string[]; code: number };
export type Aside = { repl: (body: string) => Promise<unknown> };
export type OtpSource = { probe: () => void; wait: (service: OtpService, since: Date) => Promise<string | undefined> };
export type Deps = { ctx: Ctx; aside: Aside; otp: OtpSource; loopback?: () => Loopback };

type Platform = "youtube" | "instagram";
type StepId = "deps" | "gcp-project" | "gcp-api" | "gcp-consent" | "gcp-publish" | "youtube-client" | "youtube-auth" | "instagram-account" | "meta-app" | "instagram-token" | "detect" | "apply" | "test-read" | "done";
type Status = "pending" | "done" | "needs-owner" | "failed";
type StepState = { status: Status; at: string; note: string; soft?: boolean };
type State = { steps: Partial<Record<StepId, StepState>>; platforms: Platform[]; asks: string[]; ids: { projectId?: string; appId?: string } };
type Out = { status: Status; note: string; ask?: string; soft?: boolean };
type Run = { d: Deps; platforms: Platform[]; started: Date; target: string; state: State };
type StepDef = { id: StepId; label: string; platform?: Platform; requires: StepId[]; run: (r: Run) => Promise<Out> };

const UPDATE_KEY = "sns-onboarding";
const ICON: Record<Status, string> = { done: "✅", pending: "⏳", "needs-owner": "❓", failed: "❌" };
const CLIENT_FILE = () => join(secretsDir(), "youtube-client.json");
const IG_STAGING = () => join(secretsDir(), "instagram-token-new.json");
const stateFile = () => join(snsDir(), "onboard.json");
const AUTH_GRACE_MS = 30_000;
const RECEIVE_WAIT_MS = 3 * 60_000;
const LOGIN_WAIT_MS = 4 * 60_000;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/[A-Za-z0-9_-]{24,}/g, "…").trim().slice(0, 100);

// ---- real runners ----------------------------------------------------------------------------------------------------

export function realAside(ctx: Ctx): Aside {
	let started = false;
	const ensure = async () => {
		if (started) return;
		if ((await ctx.exec(["pgrep", "-x", "Aside"])).code !== 0) await ctx.exec(["open", "-g", "-j", "-a", "Aside"]);
		started = true;
	};
	return {
		repl: async body => {
			await ensure();
			const code = `try { const dzOut = await (async () => {\n${body}\n})(); console.log("RESULT " + JSON.stringify({ data: dzOut ?? null })); } catch (e) { console.log("RESULT " + JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) })); }`;
			const r = await ctx.exec(["aside", "repl", code], { timeoutMs: 118_000 });
			const m = [...r.stdout.matchAll(/^.*?RESULT (\{.*\})\s*$/gm)].at(-1);
			if (!m) throw new Error(asideReason(r.stdout + r.stderr) || "aside repl가 답하지 않았어요");
			const j = JSON.parse(m[1]!);
			if (j.error) throw new Error(asideReason(String(j.error)));
			return j.data;
		},
	};
}

export function realOtp(ctx: Ctx, db: string = MESSAGES_DB()): OtpSource {
	return { probe: () => probeMessages(db), wait: (service, since) => waitForCode({ db, service, since, sleep: ctx.sleep }) };
}

// ---- helpers shared by the steps -------------------------------------------------------------------------------------

async function enterCode(d: Deps, service: OtpService, since: Date): Promise<boolean> {
	const code = await d.otp.wait(service, since);
	if (!code) return false;
	const once = serveOnce(code);
	try {
		await d.aside.repl(codeBody(once.url, CODE_HOSTS[service]));
	} finally {
		once.stop();
	}
	return true;
}

type Page = { out: Out } | { data: Record<string, string> };
type PageAsk = { what: string; owner: string; noCode: string };

// Runs one wizard page script in a background tab (lib/pages.ts). A code prompt is answered from Messages and the script
// runs again (at most 3 rounds); a login or an unknown page ends the step with an owner ask.
async function page(r: Run, step: string, url: string, script: string, o: PageAsk): Promise<Page> {
	for (let round = 0; round < 3; round++) {
		const res = ((await r.d.aside.repl(pageBody(step, url, script))) ?? { state: "failed", note: "답이 비었어요" }) as PageResult;
		const note = clean(res.note ?? "");
		if (res.state === "ok") return { data: res.data ?? {} };
		if (res.state === "code") {
			if (await enterCode(r.d, res.service ?? "generic", r.started)) continue;
			return { out: { status: "needs-owner", note: o.noCode, ask: `${o.owner} (${o.noCode})` } };
		}
		if (res.state === "owner") return { out: { status: "needs-owner", note: note || o.owner, ask: `${o.owner} (${note})` } };
		if (res.state === "unexpected") return { out: { status: "needs-owner", note: `예상 못 한 화면: ${note}`, ask: `${o.what} 중 예상하지 못한 화면이 나왔어요 (${note}). Aside에서 ${url} 을 열고 이 단계를 직접 해 주세요` } };
		return { out: { status: "failed", note: `${o.what}: ${note || "이유를 알려 주지 않았어요"}` } };
	}
	return { out: { status: "failed", note: `${o.what}: 인증 코드를 여러 번 물어요` } };
}

// Like page(), for a script that POSTs a secret to a one-shot receiver (file, 0600) inside the same run.
async function pageSecret(r: Run, step: string, url: string, script: (postUrl: string) => string, file: string, fields: string[], o: PageAsk): Promise<Out | undefined> {
	const rcv = startReceiver({ file, fields, waitMs: RECEIVE_WAIT_MS, sleep: r.d.ctx.sleep });
	try {
		const g = await page(r, step, url, script(rcv.url), o);
		if ("out" in g) return g.out;
		await rcv.done;
		return undefined;
	} catch {
		return { status: "failed", note: `${o.what}: 화면에서 값을 읽지 못했어요` };
	} finally {
		rcv.stop();
	}
}

const GOOGLE: Omit<PageAsk, "what"> = { owner: "Aside에서 구글 계정에 로그인해 주세요", noCode: "구글에서 문자로 온 인증 코드를 알려 주세요" };
const INSTAGRAM: Omit<PageAsk, "what"> = { owner: "Aside에서 인스타그램에 로그인해 주세요", noCode: "인스타에서 온 인증 코드를 알려 주세요" };
const META: Omit<PageAsk, "what"> = { owner: "Aside에서 페이스북/메타 개발자 계정에 로그인해 주세요", noCode: "메타에서 온 인증 코드를 알려 주세요" };

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

const clientReady = () => has(CLIENT_FILE(), ["client_id", "client_secret"]) || has(paths.ytOauth(), ["client_id", "client_secret"]);
const ALREADY: Out = { status: "done", note: "이미 있어요" };
const NO_PROJECT: Out = { status: "failed", note: "프로젝트 ID를 몰라요. gcp-project 단계를 다시 열어 주세요" };

async function stepGcpProject(r: Run): Promise<Out> {
	if (clientReady()) return ALREADY;
	const g = await page(r, "gcp-project", GCP_PROJECT_URL, gcpProject(), { what: "구글 클라우드 프로젝트", ...GOOGLE });
	if ("out" in g) return g.out;
	if (!g.data.projectId) return { status: "failed", note: "프로젝트 ID를 읽지 못했어요" };
	r.state.ids.projectId = g.data.projectId;
	return { status: "done", note: `프로젝트 ${g.data.projectId}` };
}

async function stepGcpApi(r: Run): Promise<Out> {
	if (clientReady()) return ALREADY;
	const id = r.state.ids.projectId;
	if (!id) return NO_PROJECT;
	const g = await page(r, "gcp-api", gcpApiUrl(id), gcpApi(), { what: "YouTube API 켜기", ...GOOGLE });
	return "out" in g ? g.out : { status: "done", note: "YouTube Data API를 켰어요" };
}

async function stepGcpConsent(r: Run): Promise<Out> {
	if (clientReady()) return ALREADY;
	const id = r.state.ids.projectId;
	if (!id) return NO_PROJECT;
	const g = await page(r, "gcp-consent", gcpConsentUrl(id), gcpConsent(), { what: "OAuth 동의 화면", ...GOOGLE });
	return "out" in g ? g.out : { status: "done", note: "동의 화면을 만들었어요" };
}

async function stepGcpPublish(r: Run): Promise<Out> {
	if (clientReady()) return ALREADY;
	const id = r.state.ids.projectId;
	if (!id) return NO_PROJECT;
	const g = await page(r, "gcp-publish", gcpPublishUrl(id), gcpPublish(), { what: "앱 게시", ...GOOGLE });
	return "out" in g ? g.out : { status: "done", note: "프로덕션으로 게시했어요" };
}

async function stepYoutubeClient(r: Run): Promise<Out> {
	if (clientReady()) return ALREADY;
	const id = r.state.ids.projectId;
	if (!id) return NO_PROJECT;
	const bad = await pageSecret(r, "youtube-client", gcpClientUrl(id), gcpClient, CLIENT_FILE(), ["client_id", "client_secret"], { what: "OAuth 클라이언트", ...GOOGLE });
	return bad ?? { status: "done", note: "OAuth 클라이언트를 만들었어요" };
}

async function stepYoutubeAuth(r: Run): Promise<Out> {
	if (has(paths.ytOauth(), ["refresh_token"])) return { status: "done", note: "이미 로그인돼 있어요" };
	let abort!: (q: URLSearchParams) => void;
	const aborted = new Promise<URLSearchParams>(res => (abort = res));
	const base = (r.d.loopback ?? defaultLoopback)();
	const lb: Loopback = { ...base, redirect: Promise.race([base.redirect, aborted]) };
	let flow: Promise<Out | undefined> | undefined;
	const res = await setupRun(r.d.ctx, ["youtube-auth", "--client", CLIENT_FILE()], {
		loopback: () => lb,
		waitMs: LOGIN_WAIT_MS,
		onLine: l => {
			if (!l.startsWith("open ")) return;
			flow = page(r, "youtube-auth", l.slice(5), gcpConsentFlow(), { what: "유튜브 로그인", ...GOOGLE }).then(
				g => {
					if ("out" in g) abort(new URLSearchParams({ error: "aside" }));
					else void r.d.ctx.sleep(AUTH_GRACE_MS).then(() => abort(new URLSearchParams({ error: "grace" })));
					return "out" in g ? g.out : undefined;
				},
				(e: Error) => {
					abort(new URLSearchParams({ error: "aside" }));
					return { status: "failed", note: `유튜브 로그인: ${clean(e.message)}` } as Out;
				},
			);
		},
	});
	if (res.code === 0) return { status: "done", note: res.lines.at(-1)?.replace(/^youtube-connected \S+ /, "채널 ") ?? "연결했어요" };
	const bad = await flow;
	return bad ?? { status: "failed", note: `유튜브 로그인에 실패했어요 (${clean(res.lines.at(-1) ?? "")})` };
}

async function stepInstagramAccount(r: Run): Promise<Out> {
	if (has(paths.instagram(), ["access_token"])) return { status: "done", note: "이미 연결돼 있어요" };
	const g = await page(r, "instagram-account", IG_ACCOUNT_URL, igAccount(), { what: "인스타 계정 확인", ...INSTAGRAM });
	return "out" in g ? g.out : { status: "done", note: "프로페셔널 계정이에요" };
}

async function stepMetaApp(r: Run): Promise<Out> {
	if (has(paths.instagram(), ["access_token"])) return ALREADY;
	const g = await page(r, "meta-app", META_APPS_URL, metaApp(), { what: "메타 앱 만들기", ...META });
	if ("out" in g) return g.out;
	if (!g.data.appId) return { status: "failed", note: "앱 ID를 읽지 못했어요" };
	r.state.ids.appId = g.data.appId;
	return { status: "done", note: `앱 ${g.data.appId}` };
}

async function stepInstagramToken(r: Run): Promise<Out> {
	if (has(paths.instagram(), ["access_token"])) return ALREADY;
	const appId = r.state.ids.appId;
	if (!appId) return { status: "failed", note: "앱 ID를 몰라요. meta-app 단계를 다시 열어 주세요" };
	const bad = await pageSecret(r, "instagram-token", igTokenUrl(appId), igToken, IG_STAGING(), ["access_token"], { what: "인스타 토큰 만들기", ...META });
	if (bad) return bad;
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
	{ id: "gcp-project", label: "구글 클라우드 프로젝트", platform: "youtube", requires: [], run: stepGcpProject },
	{ id: "gcp-api", label: "YouTube API 켜기", platform: "youtube", requires: ["gcp-project"], run: stepGcpApi },
	{ id: "gcp-consent", label: "OAuth 동의 화면", platform: "youtube", requires: ["gcp-api"], run: stepGcpConsent },
	{ id: "gcp-publish", label: "앱 게시", platform: "youtube", requires: ["gcp-consent"], run: stepGcpPublish },
	{ id: "youtube-client", label: "구글 OAuth 클라이언트", platform: "youtube", requires: ["gcp-publish"], run: stepYoutubeClient },
	{ id: "youtube-auth", label: "유튜브 로그인", platform: "youtube", requires: ["youtube-client"], run: stepYoutubeAuth },
	{ id: "instagram-account", label: "인스타 계정 종류 확인", platform: "instagram", requires: [], run: stepInstagramAccount },
	{ id: "meta-app", label: "메타 앱 만들기", platform: "instagram", requires: ["instagram-account"], run: stepMetaApp },
	{ id: "instagram-token", label: "인스타 토큰 받기", platform: "instagram", requires: ["meta-app"], run: stepInstagramToken },
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
		if (s && typeof s === "object" && s.steps) return { steps: s.steps, platforms: s.platforms ?? [], asks: s.asks ?? [], ids: s.ids ?? {} };
	} catch {}
	return { steps: {}, platforms: [], asks: [], ids: {} };
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
	const legacy = legacyGate([...flags.keys()].map(k => `--${k}`));
	if (legacy.ask) return { code: 3, lines: legacy.lines };
	const target = typeof flags.get("target") === "string" ? (flags.get("target") as string) : "chat";
	const started = d.ctx.now();
	const r: Run = { d, platforms: state.platforms, started, target, state };
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
	return { code: ask.length ? 3 : failed || !finished ? 1 : 0, lines: [...legacy.lines, ...checklist(state), ...ask] };
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
		if (id === "gcp-project") delete s.ids.projectId;
		if (id === "meta-app") delete s.ids.appId;
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
