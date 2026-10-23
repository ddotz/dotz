// bin/onboard.ts: the whole flow, an owner batch, an interruption with resume, codes and reset, against injected runners
// (aside.repl, exec, fetch, otp source, loopback driver), a temp DOTZ_DIR and the real receiver on loopback. Every wizard
// step goes through aside.repl (never the Aside agent). No real network, no real aside, no timers.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Aside, type Deps, type OtpSource, realAside, run } from "../bin/onboard.ts";
import type { Loopback } from "../bin/setup.ts";
import { paths, secretsDir, snsDir } from "../lib/config.ts";
import { codeBody, gcpApi, gcpClient, gcpConsent, gcpConsentFlow, gcpProject, gcpPublish, igAccount, igToken, metaApp, type PageResult, pageBody } from "../lib/pages.ts";
import { MessagesAccessError, type OtpService } from "../lib/otp.ts";
import { fakeCtx, SECRETS } from "./fakes.ts";

const BEFORE = process.env.DOTZ_DIR;
const BEFORE_LEGACY = process.env.DOTZ_LEGACY_SECRETS;
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-onboard-"));
	process.env.DOTZ_DIR = dir;
	process.env.DOTZ_LEGACY_SECRETS = "";
	mkdirSync(secretsDir(), { recursive: true });
	writeFileSync(join(secretsDir(), "hub-token"), `${SECRETS.hub}\n`);
});
afterEach(() => {
	if (BEFORE === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = BEFORE;
	if (BEFORE_LEGACY === undefined) delete process.env.DOTZ_LEGACY_SECRETS;
	else process.env.DOTZ_LEGACY_SECRETS = BEFORE_LEGACY;
	rmSync(dir, { recursive: true, force: true });
});

const RECEIVER_URL = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}/;
const mode = (f: string) => statSync(f).mode & 0o777;
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

type Hooks = { page?: (step: string, n: number) => PageResult | undefined; messagesBlocked: boolean; codes: (string | undefined)[] };

function harness() {
	const f = fakeCtx({ env: { DOTZ_PORT: "47999" } });
	const hooks: Hooks = { messagesBlocked: false, codes: [] };
	const installed = { ffmpeg: false, cloudflared: false };
	const execs: string[][] = [];
	f.ctx.exec = async argv => {
		execs.push(argv);
		const [cmd, arg] = argv;
		if (cmd === "bun" || (cmd === "brew" && arg === "--version")) return { code: 0, stdout: "1", stderr: "" };
		if (cmd === "ffprobe") return { code: installed.ffmpeg ? 0 : 1, stdout: "", stderr: "" };
		if (cmd === "cloudflared") return { code: installed.cloudflared ? 0 : 1, stdout: "", stderr: "" };
		if (cmd === "brew" && arg === "install") {
			installed.ffmpeg ||= argv.includes("ffmpeg");
			installed.cloudflared ||= argv.includes("cloudflared");
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "unexpected" };
	};

	const loopbacks: { deliver: (q: Record<string, string>) => void }[] = [];
	const loopback = (): Loopback => {
		let resolve!: (p: URLSearchParams) => void;
		const lb: Loopback = { port: 4242, redirect: new Promise(r => (resolve = r)), close: () => {} };
		loopbacks.push({ deliver: q => resolve(new URLSearchParams(q)) });
		return lb;
	};

	const log = { steps: [] as string[], repls: [] as string[], typed: [] as string[], waits: [] as { service: OtpService; since: Date }[] };
	const counts = new Map<string, number>();
	const post = async (url: string, body: unknown) => void (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
	const aside: Aside = {
		repl: async body => {
			log.repls.push(body);
			if (body === "return 1") return 1;
			if (body.includes("const secret")) {
				log.typed.push(await (await fetch(RECEIVER_URL.exec(body)![0])).text());
				return { ok: true };
			}
			const step = /^\/\/ dz-step: (\S+)/.exec(body)![1]!;
			log.steps.push(step);
			const n = (counts.get(step) ?? 0) + 1;
			counts.set(step, n);
			const custom = hooks.page?.(step, n);
			if (custom) return custom;
			if (step === "gcp-project") return { state: "ok", data: { projectId: "dotz-youtube-123456" } };
			if (step === "meta-app") return { state: "ok", data: { appId: "555001" } };
			if (step === "youtube-client") await post(RECEIVER_URL.exec(body)![0], { client_id: "1234-abc.apps.googleusercontent.com", client_secret: SECRETS.clientSecret });
			if (step === "instagram-token") await post(RECEIVER_URL.exec(body)![0], { access_token: SECRETS.instagram });
			if (step === "youtube-auth") {
				const consent = /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^"]+/.exec(body)!;
				loopbacks.at(-1)!.deliver({ code: "CODE1", state: new URL(consent[0]).searchParams.get("state")! });
			}
			return { state: "ok" };
		},
	};
	const otp: OtpSource = {
		probe: () => {
			if (hooks.messagesBlocked) throw new MessagesAccessError("blocked");
		},
		wait: async (service, since) => {
			log.waits.push({ service, since });
			return hooks.codes.shift();
		},
	};
	const deps: Deps = { ctx: f.ctx, aside, otp, loopback };
	const sends = () => f.gateway().filter(c => c.method === "POST" && c.url.endsWith("/api/send"));
	const everything = (r: { lines: string[] }) => [...log.repls, ...r.lines, ...sends().map(s => s.body.text)].join("\n");
	return { f, deps, hooks, execs, loopbacks, log, sends, everything };
}

const ok = (lines: string[]) => lines.every(l => l.startsWith("✅"));

test("a work channel given as --target owns the config, project and watches", async () => {
	const h = harness();
	const r = await run(h.deps, ["run", "--target", "ch:55"]);
	expect(r.code).toBe(0);
	expect(read(paths.config()).channel).toBe("ch:55");
	const named = h.f.watches.filter(w => w.name);
	expect(named.length).toBe(7);
	for (const w of named) expect(w).toMatchObject({ channels: ["55"] });
});

test("a full run connects both platforms: every step done, watches, card and project created, one evolving progress message", async () => {
	const h = harness();
	const r = await run(h.deps, ["run", "--target", "discord:dm:7"]);

	expect(r.code).toBe(0);
	expect(r.lines).toHaveLength(15);
	expect(ok(r.lines)).toBe(true);
	expect(h.log.steps).toEqual(["gcp-project", "gcp-api", "gcp-consent", "gcp-publish", "youtube-client", "youtube-auth", "instagram-account", "meta-app", "instagram-token"]);
	for (const argv of h.execs) expect(argv.join(" ")).not.toMatch(/^aside\b/);
	expect(r.lines[0]).toBe("✅ 준비물 확인 - ffmpeg, cloudflared를 설치했어요");
	expect(h.execs).toContainEqual(["brew", "install", "ffmpeg", "cloudflared"]);

	expect(h.f.watches.filter(w => w.name).map(w => w.name)).toEqual(["sns-yt-comments", "sns-ig-comments", "sns-ig-dm", "sns-inbox", "sns-due", "sns-tokens", "sns-yt-login"]);
	expect(h.f.gateway().filter(c => c.method === "PUT" && c.url.endsWith("/api/projects"))).toHaveLength(2);
	expect(existsSync(join(dir, "custom", "cards", "sns-channels", "card.json"))).toBe(true);
	expect(read(paths.config())).toMatchObject({ youtube: { channel_id: "UCabcdefghij1234", upload_via: "aside" }, instagram: { username: "owner" }, posting_times: ["18:00"], approval: "each" });
	expect(read(paths.config()).youtube.languages).toEqual([]);

	const sends = h.sends();
	expect(sends.length).toBeGreaterThanOrEqual(10);
	for (const s of sends) {
		expect(s.body).toMatchObject({ target: "discord:dm:7", update_key: "sns-onboarding" });
		expect(s.hubToken).toBe(SECRETS.hub);
	}
	expect(sends[0]!.body.text).toContain("⏳ 준비물 확인");
	expect(sends.at(-1)!.body.text).toContain("연결 결과예요");
	expect(sends.at(-1)!.body.text).not.toMatch(/⏳|❌|❓/);

	expect(mode(join(secretsDir(), "youtube-client.json"))).toBe(0o600);
	expect(mode(paths.ytOauth())).toBe(0o600);
	expect(mode(paths.instagram())).toBe(0o600);
	expect(existsSync(join(secretsDir(), "instagram-token-new.json"))).toBe(false);
	expect(read(join(snsDir(), "onboard.json")).platforms).toEqual(["youtube", "instagram"]);
	expect(h.log.waits).toEqual([]);

	for (const s of Object.values(SECRETS)) expect(h.everything(r)).not.toContain(s);
	for (const argv of h.execs) for (const s of Object.values(SECRETS)) expect(argv.join(" ")).not.toContain(s);

	const status = await run(h.deps, ["status"]);
	expect(status.lines).toHaveLength(15);
	expect(ok(status.lines)).toBe(true);
	const again = await run(h.deps, ["run"]);
	expect(again.code).toBe(0);
	expect(h.log.steps).toHaveLength(9);
});

test("two steps that need the owner produce ONE ask block and exit 3; the independent steps still ran; the re-run finishes", async () => {
	const h = harness();
	h.hooks.messagesBlocked = true;
	h.hooks.page = step => (step === "instagram-account" && h.hooks.messagesBlocked ? { state: "owner", note: "인스타에 로그인이 안 돼 있어요" } : undefined);

	const first = await run(h.deps, ["run"]);
	expect(first.code).toBe(3);
	expect(first.lines.filter(l => /^확인이 필요한 게 \d+가지/.test(l))).toEqual(["확인이 필요한 게 2가지 있어요"]);
	const asks = first.lines.filter(l => /^\d+\. /.test(l));
	expect(asks).toHaveLength(2);
	expect(asks[0]).toContain("전체 디스크 접근 권한");
	expect(asks[1]).toContain("인스타에 로그인이 안 돼 있어요");
	expect(first.lines.find(l => l.includes("유튜브 로그인"))!.startsWith("✅")).toBe(true);
	expect(first.lines.find(l => l.includes("인스타 계정 종류"))!.startsWith("❓")).toBe(true);
	expect(first.lines.find(l => l.includes("계정 확인"))!.startsWith("⏳")).toBe(true);
	expect(h.f.watches.filter(w => w.name)).toHaveLength(0);
	expect(h.sends().at(-1)!.body.text).toContain("❓");

	h.hooks.messagesBlocked = false;
	const second = await run(h.deps, ["run"]);
	expect(second.code).toBe(0);
	expect(ok(second.lines)).toBe(true);
	expect(second.lines.some(l => /^확인이 필요한/.test(l))).toBe(false);
	expect(h.log.steps.filter(s => s === "gcp-project")).toHaveLength(1);
	expect(h.loopbacks).toHaveLength(1);
	expect(h.execs.filter(a => a[0] === "brew" && a[1] === "install")).toHaveLength(1);
	expect(h.f.watches.filter(w => w.name)).toHaveLength(7);
});

test("interrupted after youtube-auth (the runner throws), the next run resumes at instagram-account without redoing done steps", async () => {
	const h = harness();
	let crash = true;
	h.hooks.page = step => {
		if (crash && step === "instagram-account") throw new Error("aside crashed");
		return undefined;
	};

	const first = await run(h.deps, ["run"]);
	expect(first.code).toBe(1);
	expect(first.lines.slice(0, 7).every(l => l.startsWith("✅"))).toBe(true);
	expect(first.lines[7]).toBe("❌ 인스타 계정 종류 확인 - aside crashed");
	expect(first.lines.slice(8).every(l => l.startsWith("⏳"))).toBe(true);
	expect(first.lines.some(l => /^확인이 필요한/.test(l))).toBe(false);
	expect(read(join(snsDir(), "onboard.json")).steps["youtube-auth"].status).toBe("done");

	crash = false;
	const stepsBefore = h.log.steps.length;
	const second = await run(h.deps, ["run"]);
	expect(second.code).toBe(0);
	expect(ok(second.lines)).toBe(true);
	const redone = h.log.steps.slice(stepsBefore);
	expect(redone).toEqual(["instagram-account", "meta-app", "instagram-token"]);
	expect(h.loopbacks).toHaveLength(1);
	expect(h.execs.filter(a => a[0] === "brew" && a[1] === "install")).toHaveLength(1);
	expect(h.sends().every(s => s.body.update_key === "sns-onboarding")).toBe(true);
});

test("a code prompt is answered from Messages through the one-shot URL; the code is never in a task, a repl body or the output", async () => {
	const h = harness();
	h.hooks.codes = ["482913"];
	h.hooks.page = (step, n) => (step === "instagram-account" && n === 1 ? { state: "code", service: "instagram" } : undefined);

	const r = await run(h.deps, ["run", "--instagram"]);
	expect(r.code).toBe(0);
	expect(h.log.waits).toEqual([{ service: "instagram", since: new Date("2026-10-22T03:00:00Z") }]);
	expect(h.log.typed).toEqual(["482913"]);
	expect(h.log.steps.filter(s => s === "instagram-account")).toHaveLength(2);
	expect(h.everything(r)).not.toContain("482913");
	expect(h.loopbacks).toHaveLength(0);
	expect(h.execs.some(a => a.includes("cloudflared"))).toBe(true);
});

test("a code that never arrives becomes a needs-owner ask instead of a hang", async () => {
	const h = harness();
	h.hooks.codes = [undefined];
	h.hooks.page = step => (step === "instagram-account" ? { state: "code", service: "instagram" } : undefined);
	const r = await run(h.deps, ["run", "--instagram"]);
	expect(r.code).toBe(3);
	expect(r.lines.filter(l => /^\d+\. /.test(l))).toEqual(["1. Aside에서 인스타그램에 로그인해 주세요 (인스타에서 온 인증 코드를 알려 주세요)"]);
});

test("--dry-run only previews: no runner, no gateway call, no state", async () => {
	const h = harness();
	const r = await run(h.deps, ["run", "--youtube", "--dry-run"]);
	expect(r.code).toBe(0);
	expect(r.lines[0]).toContain("미리보기");
	expect(r.lines).toHaveLength(1 + 11);
	expect(h.log.steps).toHaveLength(0);
	expect(h.log.repls).toHaveLength(0);
	expect(h.execs).toHaveLength(0);
	expect(h.f.calls).toHaveLength(0);
	expect(existsSync(join(snsDir(), "onboard.json"))).toBe(false);
});

test("status before any run and the reset command", async () => {
	const h = harness();
	const none = await run(h.deps, ["status"]);
	expect(none.lines).toHaveLength(1);
	expect(none.lines[0]).toContain("아직 연결을 시작하지 않았어요");

	await run(h.deps, ["run"]);
	const reset = await run(h.deps, ["reset", "youtube-auth"]);
	expect(reset.code).toBe(0);
	expect(reset.lines[0]).toBe("유튜브 로그인의 로그인 정보를 지웠어요");
	expect(existsSync(paths.ytOauth())).toBe(false);
	expect(existsSync(join(secretsDir(), "youtube-client.json"))).toBe(true);
	const status = await run(h.deps, ["status"]);
	expect(status.lines.map(l => l[0])).toEqual(["✅", "✅", "✅", "✅", "✅", "✅", "⏳", "✅", "✅", "✅", "✅", "⏳", "⏳", "⏳", "⏳"]);

	const again = await run(h.deps, ["run"]);
	expect(again.code).toBe(0);
	expect(h.loopbacks).toHaveLength(2);
	expect(h.log.steps.filter(s => s === "gcp-project")).toHaveLength(1);

	const bad = await run(h.deps, ["reset", "nope"]);
	expect(bad.code).toBe(1);
	expect((await run(h.deps, ["reset"])).lines.at(-1)).toContain("처음부터");
	expect((await run(h.deps, ["status"])).lines.every(l => l.startsWith("⏳"))).toBe(true);
});

test("a page the script does not know stops that step with an owner ask (exit 3), nothing after it runs, and the re-run resumes at that step", async () => {
	const h = harness();
	let lost = true;
	h.hooks.page = step => (lost && step === "gcp-consent" ? { state: "unexpected", note: "앱 이름 칸을 찾지 못했어요" } : undefined);

	const first = await run(h.deps, ["run", "--youtube"]);
	expect(first.code).toBe(3);
	expect(first.lines.find(l => l.includes("OAuth 동의 화면"))!.startsWith("❓")).toBe(true);
	const ask = first.lines.find(l => /^1\. /.test(l))!;
	expect(ask).toContain("예상하지 못한 화면");
	expect(ask).toContain("https://console.cloud.google.com/auth/overview?project=dotz-youtube-123456");
	expect(h.log.steps).toEqual(["gcp-project", "gcp-api", "gcp-consent"]);

	lost = false;
	const second = await run(h.deps, ["run", "--youtube"]);
	expect(second.code).toBe(0);
	expect(h.log.steps.slice(3)).toEqual(["gcp-consent", "gcp-publish", "youtube-client", "youtube-auth"]);
});

test("a failed step is retried alone: gcp-api failing leaves gcp-project done and the re-run starts at gcp-api", async () => {
	const h = harness();
	h.hooks.page = (step, n) => (step === "gcp-api" && n === 1 ? { state: "failed", note: "API 화면이 비었어요" } : undefined);
	const first = await run(h.deps, ["run", "--youtube"]);
	expect(first.code).toBe(1);
	expect(first.lines.find(l => l.includes("YouTube API 켜기"))).toBe("❌ YouTube API 켜기 - YouTube API 켜기: API 화면이 비었어요");
	expect(read(join(snsDir(), "onboard.json")).ids.projectId).toBe("dotz-youtube-123456");
	const second = await run(h.deps, ["run", "--youtube"]);
	expect(second.code).toBe(0);
	expect(h.log.steps.filter(s => s === "gcp-project")).toHaveLength(1);
	expect(h.log.steps.filter(s => s === "gcp-api")).toHaveLength(2);
});

test("a login page in a Google Cloud step is an owner ask, not a guess", async () => {
	const h = harness();
	h.hooks.page = step => (step === "gcp-project" ? { state: "owner", note: "구글 로그인 화면이 나왔어요" } : undefined);
	const r = await run(h.deps, ["run", "--youtube"]);
	expect(r.code).toBe(3);
	expect(r.lines).toContain("1. Aside에서 구글 계정에 로그인해 주세요 (구글 로그인 화면이 나왔어요)");
	expect(h.log.steps).toEqual(["gcp-project"]);
});

test("realAside runs `aside repl` only; an Aside 429 becomes the Korean limit reason", async () => {
	const f = fakeCtx({ env: {} });
	const argvs: string[][] = [];
	let out = 'RESULT {"data":7}';
	f.ctx.exec = async argv => {
		argvs.push(argv);
		return { code: 0, stdout: argv[0] === "pgrep" ? "1" : out, stderr: "" };
	};
	const aside = realAside(f.ctx);
	expect(await aside.repl("return 7")).toBe(7);
	expect(argvs.filter(a => a[0] === "aside").every(a => a[1] === "repl")).toBe(true);
	out = 'RESULT {"error":"429 rate_limit_error"}';
	await expect(aside.repl("return 7")).rejects.toThrow("Aside 사용 한도를 넘었어요");
});

test("every page script is valid JavaScript for the repl (async function body)", () => {
	const Fn = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown;
	const scripts = [gcpProject(), gcpApi(), gcpConsent(), gcpPublish(), gcpClient("http://127.0.0.1:1/x"), gcpConsentFlow(), igAccount(), metaApp(), igToken("http://127.0.0.1:1/x")];
	for (const s of scripts) expect(() => new Fn("openTab", "closeTab", "sleep", "fetch", pageBody("x", "https://example.com", s))).not.toThrow();
	expect(() => new Fn("listBrowserTabs", "attachBrowserTab", "page", "sleep", "closeTab", "fetch", codeBody("http://127.0.0.1:1/x", ["accounts.google.com"]))).not.toThrow();
});
