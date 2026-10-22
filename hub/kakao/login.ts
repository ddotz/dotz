// Background KakaoTalk login by UI automation (login.jxa.js over osascript). The app is opened hidden (`open -g -j`) and no window
// is raised. KakaoTalk enables its login button only on real key input, so the id and password are typed one character at a time
// into the KakaoTalk process alone (keys.ts, CGEventPostToPid); they never reach argv, stdin of another process, or a log. A rejected
// password is remembered by a salted scrypt hash so it is never submitted twice (repeated wrong passwords lock the account).
// Ported from kmsg Auth/KakaoTalkAuthenticator.swift and Auth/CredentialStore.swift (rejected-password guard), MIT: see THIRD_PARTY_NOTICES.md.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import jxa from "./login.jxa.js" with { type: "text" };
import { getSecret, writePrivate } from "./creds.ts";
import { KAKAO_APP, type KakaoPaths, type LoginStatus, type Runner } from "./types.ts";

// `type` posts text as key events to one process; tests inject a recorder.
export type LoginDeps = { paths: KakaoPaths; runner: Runner; sleep?: (ms: number) => Promise<void>; now?: () => number; type?: (pid: number, text: string) => Promise<void> };
export type LoginResult = { status: LoginStatus; detail?: string };
export type KakaoState = { state: "main" | "login" | "locked" | "confirm" | "error" | "unknown"; detail?: string; pid?: number };

const POLL_MS = 1500;
const LOGIN_BUDGET_MS = 45_000;
const CONFIRM_POLL_MS = 3000;
const CONFIRM_BUDGET_MS = 5 * 60_000;
const STATES = new Set(["main", "login", "locked", "confirm", "error", "unknown"]);

const osascript = (...args: string[]) => ["osascript", "-l", "JavaScript", ...args];
const clock = (d: LoginDeps) => ({ sleep: d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))), now: d.now ?? Date.now });
const recordFile = (paths: KakaoPaths) => join(paths.dataDir, "kakao", "login.json");

export async function appInstalled({ runner }: LoginDeps): Promise<boolean> {
	try {
		return (await runner(["/bin/test", "-d", KAKAO_APP])).code === 0;
	} catch {
		return false;
	}
}

export async function accessibilityGranted({ runner }: LoginDeps): Promise<boolean> {
	try {
		const r = await runner(osascript("-e", 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()'));
		return r.code === 0 && r.stdout.trim() === "true";
	} catch {
		return false;
	}
}

export async function launchBackground({ runner }: LoginDeps): Promise<boolean> {
	try {
		return (await runner(["open", "-g", "-j", "-a", KAKAO_APP])).code === 0;
	} catch {
		return false;
	}
}

// One JXA call. The request is a single JSON line on stdin; the answer is its last JSON line (osascript prints a returned string to stdout).
async function ask(deps: LoginDeps, req: Record<string, string>): Promise<KakaoState> {
	try {
		const r = await deps.runner(osascript("-e", jxa), { stdin: `${JSON.stringify(req)}\n`, timeoutMs: 30_000 });
		if (/-1719|-25211|not allowed assistive/i.test(r.stderr)) return { state: "unknown", detail: "no_accessibility" };
		for (const line of `${r.stdout}\n${r.stderr}`.split("\n").reverse()) {
			if (!line.startsWith("{")) continue;
			const j = JSON.parse(line);
			if (STATES.has(j?.state)) return { state: j.state, ...(typeof j.detail === "string" ? { detail: j.detail } : {}), ...(Number.isInteger(j.pid) && j.pid > 0 ? { pid: j.pid } : {}) };
		}
	} catch {
		return { state: "unknown", detail: "osascript" };
	}
	return { state: "unknown", detail: "no_answer" };
}

export const kakaoState = (deps: LoginDeps) => ask(deps, { action: "state" });

// Focus a field (cleared), type into it, then press the login / unlock button once KakaoTalk enabled it.
async function enter(deps: LoginDeps, locked: boolean, id: string, password: string): Promise<KakaoState> {
	const { sleep } = clock(deps);
	const type = deps.type ?? (async (pid: number, text: string) => (await import("./keys.ts")).typeToPid(pid, text, sleep));
	for (const [field, text] of locked ? ([["password", password]] as const) : ([["id", id], ["password", password]] as const)) {
		const f = await ask(deps, { action: "focus", field });
		if (f.detail !== "focused" || !f.pid) return { state: "error", detail: "ui_changed" };
		await sleep(150);
		await type(f.pid, text);
		await sleep(300);
	}
	for (let i = 0; i < 4; i++) {
		const r = await ask(deps, { action: "submit" });
		if (r.detail !== "submit_disabled") return r;
		await sleep(500);
	}
	return { state: "error", detail: "submit_disabled" };
}

type BadRecord = { badAt: string; salt: string; hash: string };
const digest = (id: string, password: string, salt: Buffer) => scryptSync(`${id}\n${password}`, salt, 32);

function rejectedBefore(paths: KakaoPaths, id: string, password: string): boolean {
	try {
		const r: BadRecord = JSON.parse(readFileSync(recordFile(paths), "utf8"));
		const want = Buffer.from(r.hash, "hex");
		const got = digest(id, password, Buffer.from(r.salt, "hex"));
		return want.length === got.length && timingSafeEqual(want, got);
	} catch {
		return false;
	}
}

function rememberRejected(deps: LoginDeps, id: string, password: string): void {
	const salt = randomBytes(16);
	const rec: BadRecord = { badAt: new Date(clock(deps).now()).toISOString(), salt: salt.toString("hex"), hash: digest(id, password, salt).toString("hex") };
	writePrivate(recordFile(deps.paths), `${JSON.stringify(rec)}\n`);
}

const ok = (deps: LoginDeps): LoginResult => {
	rmSync(recordFile(deps.paths), { force: true });
	return { status: "ok" };
};
const failed = (detail: string): LoginResult => ({ status: "failed", detail });

export async function login(deps: LoginDeps): Promise<LoginResult> {
	const { sleep, now } = clock(deps);
	if (!(await appInstalled(deps))) return { status: "not_installed", detail: "카카오톡 앱이 설치되어 있지 않아요" };
	if (!(await accessibilityGranted(deps))) return { status: "no_accessibility", detail: "손쉬운 사용 권한이 필요해요" };
	const id = await getSecret("id", deps);
	const password = await getSecret("password", deps);
	if (!id || !password) return { status: "no_credentials", detail: "저장된 카카오 계정 정보가 없어요" };
	if (rejectedBefore(deps.paths, id, password)) return { status: "bad_credentials", detail: "카카오톡이 이미 거절한 비밀번호예요. 비밀번호를 바꾼 뒤에 다시 시도해요" };
	if (!(await launchBackground(deps))) return failed("카카오톡을 열지 못했어요");

	let submitted = false;
	// A rejection notice already on screen when we submit is the previous attempt's; it counts only after the screen left it once.
	let staleError = false;
	const deadline = now() + LOGIN_BUDGET_MS;
	do {
		const s = await kakaoState(deps);
		if (s.state === "main") return ok(deps);
		if (s.state === "confirm") return { status: "confirm", detail: "휴대폰에서 로그인 확인이 필요해요" };
		if (s.detail === "no_accessibility") return { status: "no_accessibility", detail: "손쉬운 사용 권한이 필요해요" };
		if (s.state === "error" && s.detail !== "rejected") return failed("카카오톡 화면을 읽지 못했어요");
		if (submitted && s.state !== "error") staleError = false;
		if (s.state === "error" && submitted && !staleError) {
			rememberRejected(deps, id, password);
			return { status: "bad_credentials", detail: "카카오톡이 아이디나 비밀번호를 거절했어요" };
		}
		if (s.state === "login" && s.detail === "notice") await ask(deps, { action: "ack" });
		else if (!submitted && (s.state === "login" || s.state === "locked" || s.state === "error")) {
			submitted = true;
			staleError = s.state === "error";
			const r = await enter(deps, s.state === "locked", id, password);
			if (r.detail === "submit_disabled") return failed("입력한 뒤에도 로그인 버튼이 켜지지 않았어요");
			if (r.state === "error") return failed("카카오톡 로그인 화면을 조작하지 못했어요");
		}
		await sleep(POLL_MS);
	} while (now() < deadline);
	return failed(submitted ? "로그인이 끝나지 않았어요" : "카카오톡 로그인 화면을 찾지 못했어요");
}

// After a `confirm`: waits for the owner to approve on the phone. Never submits again.
export async function resumeAfterConfirm(deps: LoginDeps): Promise<LoginResult> {
	const { sleep, now } = clock(deps);
	const deadline = now() + CONFIRM_BUDGET_MS;
	do {
		if ((await kakaoState(deps)).state === "main") return ok(deps);
		await sleep(CONFIRM_POLL_MS);
	} while (now() < deadline);
	return failed("휴대폰에서 확인이 끝나지 않았어요");
}
