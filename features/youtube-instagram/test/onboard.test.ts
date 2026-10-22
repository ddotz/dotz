// bin/onboard.ts: the whole flow, an owner batch, an interruption with resume, codes and reset, against injected runners
// (aside, exec, fetch, otp source, loopback driver), a temp DOTZ_DIR and the real receiver on loopback. No real network,
// no real aside, no timers.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Aside, type Deps, type OtpSource, run } from "../bin/onboard.ts";
import type { Loopback } from "../bin/setup.ts";
import { paths, secretsDir, snsDir } from "../lib/config.ts";
import { MessagesAccessError, type OtpService } from "../lib/otp.ts";
import { fakeCtx, SECRETS } from "./fakes.ts";

const BEFORE = process.env.DOTZ_DIR;
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-onboard-"));
	process.env.DOTZ_DIR = dir;
	mkdirSync(secretsDir(), { recursive: true });
	writeFileSync(join(secretsDir(), "hub-token"), `${SECRETS.hub}\n`);
});
afterEach(() => {
	if (BEFORE === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = BEFORE;
	rmSync(dir, { recursive: true, force: true });
});

const DONE = "작업 끝\nRESULT: DONE";
const RECEIVER_URL = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}/;
const mode = (f: string) => statSync(f).mode & 0o777;
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

type Hooks = { exec?: (task: string, n: number) => string | undefined; messagesBlocked: boolean; codes: (string | undefined)[] };

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

	const log = { tasks: [] as string[], repls: [] as string[], typed: [] as string[], waits: [] as { service: OtpService; since: Date }[] };
	const post = async (url: string, body: unknown) => void (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
	const aside: Aside = {
		exec: async task => {
			log.tasks.push(task);
			const custom = hooks.exec?.(task, log.tasks.length);
			if (custom !== undefined) return custom;
			const consent = /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\S+/.exec(task);
			if (consent) loopbacks.at(-1)!.deliver({ code: "CODE1", state: new URL(consent[0]).searchParams.get("state")! });
			return DONE;
		},
		repl: async body => {
			log.repls.push(body);
			if (body === "return 1") return 1;
			if (body.includes("client_secret")) await post(RECEIVER_URL.exec(body)![0], { client_id: "1234-abc.apps.googleusercontent.com", client_secret: SECRETS.clientSecret });
			else if (body.includes("access_token")) await post(RECEIVER_URL.exec(body)![0], { access_token: SECRETS.instagram });
			else if (body.includes("const secret")) log.typed.push(await (await fetch(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}/.exec(body)![0])).text());
			return { ok: true };
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
	const everything = (r: { lines: string[] }) => [...log.tasks, ...log.repls, ...r.lines, ...sends().map(s => s.body.text)].join("\n");
	return { f, deps, hooks, execs, loopbacks, log, sends, everything };
}

const ok = (lines: string[]) => lines.every(l => l.startsWith("✅"));

test("a work channel given as --target owns the config, project and watches", async () => {
	const h = harness();
	const r = await run(h.deps, ["run", "--target", "ch:55"]);
	expect(r.code).toBe(0);
	expect(read(paths.config()).channel).toBe("ch:55");
	const named = h.f.watches.filter(w => w.name);
	expect(named.length).toBe(5);
	for (const w of named) expect(w).toMatchObject({ channels: ["55"] });
});

test("a full run connects both platforms: every step done, watches, card and project created, one evolving progress message", async () => {
	const h = harness();
	const r = await run(h.deps, ["run", "--target", "discord:dm:7"]);

	expect(r.code).toBe(0);
	expect(r.lines).toHaveLength(9);
	expect(ok(r.lines)).toBe(true);
	expect(r.lines[0]).toBe("✅ 준비물 확인 - ffmpeg, cloudflared를 설치했어요");
	expect(h.execs).toContainEqual(["brew", "install", "ffmpeg", "cloudflared"]);

	expect(h.f.watches.filter(w => w.name).map(w => w.name)).toEqual(["sns-yt-comments", "sns-ig-comments", "sns-inbox", "sns-due", "sns-tokens"]);
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
	expect(status.lines).toHaveLength(9);
	expect(ok(status.lines)).toBe(true);
	const again = await run(h.deps, ["run"]);
	expect(again.code).toBe(0);
	expect(h.log.tasks).toHaveLength(4);
});

test("two steps that need the owner produce ONE ask block and exit 3; the independent steps still ran; the re-run finishes", async () => {
	const h = harness();
	h.hooks.messagesBlocked = true;
	h.hooks.exec = task => (task.includes("프로페셔널") && h.hooks.messagesBlocked ? "RESULT: NEEDS_OWNER 인스타에 로그인이 안 돼 있어요" : undefined);

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
	expect(h.log.tasks.filter(t => t.includes("dotz-youtube"))).toHaveLength(1);
	expect(h.loopbacks).toHaveLength(1);
	expect(h.execs.filter(a => a[0] === "brew" && a[1] === "install")).toHaveLength(1);
	expect(h.f.watches.filter(w => w.name)).toHaveLength(5);
});

test("interrupted after youtube-auth (the runner throws), the next run resumes at instagram-account without redoing done steps", async () => {
	const h = harness();
	let crash = true;
	h.hooks.exec = task => {
		if (crash && task.includes("프로페셔널")) throw new Error("aside crashed");
		return undefined;
	};

	const first = await run(h.deps, ["run"]);
	expect(first.code).toBe(1);
	expect(first.lines.slice(0, 3).every(l => l.startsWith("✅"))).toBe(true);
	expect(first.lines[3]).toBe("❌ 인스타 계정 종류 확인 - aside crashed");
	expect(first.lines.slice(4).every(l => l.startsWith("⏳"))).toBe(true);
	expect(first.lines.some(l => /^확인이 필요한/.test(l))).toBe(false);
	expect(read(join(snsDir(), "onboard.json")).steps["youtube-auth"].status).toBe("done");

	crash = false;
	const tasksBefore = h.log.tasks.length;
	const second = await run(h.deps, ["run"]);
	expect(second.code).toBe(0);
	expect(ok(second.lines)).toBe(true);
	const redone = h.log.tasks.slice(tasksBefore);
	expect(redone[0]).toContain("프로페셔널");
	expect(redone.some(t => t.includes("dotz-youtube") || t.includes("accounts.google.com"))).toBe(false);
	expect(h.loopbacks).toHaveLength(1);
	expect(h.execs.filter(a => a[0] === "brew" && a[1] === "install")).toHaveLength(1);
	expect(h.sends().every(s => s.body.update_key === "sns-onboarding")).toBe(true);
});

test("a code prompt is answered from Messages through the one-shot URL; the code is never in a task, a repl body or the output", async () => {
	const h = harness();
	h.hooks.codes = ["482913"];
	h.hooks.exec = task => (task.includes("프로페셔널") && !task.includes("이미 입력 칸에 넣었어요") ? "RESULT: NEEDS_CODE instagram" : undefined);

	const r = await run(h.deps, ["run", "--instagram"]);
	expect(r.code).toBe(0);
	expect(h.log.waits).toEqual([{ service: "instagram", since: new Date("2026-10-22T03:00:00Z") }]);
	expect(h.log.typed).toEqual(["482913"]);
	const continued = h.log.tasks.filter(t => t.includes("프로페셔널"));
	expect(continued).toHaveLength(2);
	expect(continued[1]).toContain("이미 입력 칸에 넣었어요");
	expect(h.everything(r)).not.toContain("482913");
	expect(h.loopbacks).toHaveLength(0);
	expect(h.execs.some(a => a.includes("cloudflared"))).toBe(true);
});

test("a code that never arrives becomes a needs-owner ask instead of a hang", async () => {
	const h = harness();
	h.hooks.codes = [undefined];
	h.hooks.exec = task => (task.includes("프로페셔널") ? "RESULT: NEEDS_CODE instagram" : undefined);
	const r = await run(h.deps, ["run", "--instagram"]);
	expect(r.code).toBe(3);
	expect(r.lines.filter(l => /^\d+\. /.test(l))).toEqual(["1. Aside에서 인스타그램에 로그인해 주세요 (인스타에서 온 인증 코드를 알려 주세요)"]);
});

test("--dry-run only previews: no runner, no gateway call, no state", async () => {
	const h = harness();
	const r = await run(h.deps, ["run", "--youtube", "--dry-run"]);
	expect(r.code).toBe(0);
	expect(r.lines[0]).toContain("미리보기");
	expect(r.lines).toHaveLength(1 + 7);
	expect(h.log.tasks).toHaveLength(0);
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
	expect(status.lines.map(l => l[0])).toEqual(["✅", "✅", "⏳", "✅", "✅", "⏳", "⏳", "⏳", "⏳"]);

	const again = await run(h.deps, ["run"]);
	expect(again.code).toBe(0);
	expect(h.loopbacks).toHaveLength(2);
	expect(h.log.tasks.filter(t => t.includes("dotz-youtube"))).toHaveLength(1);

	const bad = await run(h.deps, ["reset", "nope"]);
	expect(bad.code).toBe(1);
	expect((await run(h.deps, ["reset"])).lines.at(-1)).toContain("처음부터");
	expect((await run(h.deps, ["status"])).lines.every(l => l.startsWith("⏳"))).toBe(true);
});
