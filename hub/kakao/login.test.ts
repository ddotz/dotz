import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jxa from "./login.jxa.js" with { type: "text" };
import { accessibilityGranted, appInstalled, kakaoState, launchBackground, login, resumeAfterConfirm, type KakaoState } from "./login.ts";
import { kakaoPaths, type Runner } from "./types.ts";

const ID = "tester@example.com";
const PW = "Pw-secret-1";
let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kk-login-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The fake Keychain the fake machine's `security find-generic-password` answers from.
let keychain = new Map<string, string>();
beforeEach(() => void (keychain = new Map()));
function storeCreds(id = ID, password = PW) {
	keychain.set("id", id);
	keychain.set("password", password);
}

type Call = { argv: string[]; stdin?: string };
// A fake machine: credentials come from the fake Keychain, the state script answers {action:"state"}.
function fakeMachine(o: { installed?: boolean; trusted?: boolean; states: KakaoState[]; afterSubmit?: KakaoState[] }) {
	const calls: Call[] = [];
	const states = [...o.states];
	let last: KakaoState = { state: "unknown" };
	const runner: Runner = async (argv, opts) => {
		calls.push({ argv, stdin: opts?.stdin });
		const prog = argv[0];
		if (prog === "/bin/test") return { code: o.installed === false ? 1 : 0, stdout: "", stderr: "" };
		if (prog === "security") {
			const v = argv[1] === "find-generic-password" ? keychain.get(argv[argv.indexOf("-a") + 1]!) : undefined;
			return v === undefined ? { code: 44, stdout: "", stderr: "" } : { code: 0, stdout: `${v}\n`, stderr: "" };
		}
		if (prog === "open") return { code: 0, stdout: "", stderr: "" };
		if (prog === "osascript") {
			if (argv.some(a => a.includes("AXIsProcessTrusted"))) return { code: 0, stdout: `${o.trusted === false ? "false" : "true"}\n`, stderr: "" };
			const req = JSON.parse(opts?.stdin ?? "{}");
			if (req.action === "focus") return { code: 0, stdout: `${JSON.stringify({ state: last.state, detail: "focused", pid: 4242 })}\n`, stderr: "" };
			if (req.action === "submit") {
				if (o.afterSubmit) states.splice(0, states.length, ...o.afterSubmit);
				return { code: 0, stdout: `${JSON.stringify({ state: "login", detail: "submitted" })}\n`, stderr: "" };
			}
			if (req.action === "state") last = states.length > 1 ? states.shift()! : (states[0] ?? last);
			return { code: 0, stdout: `${JSON.stringify(last)}\n`, stderr: "" };
		}
		return { code: 127, stdout: "", stderr: "unexpected" };
	};
	const typed: [number, string][] = [];
	return { calls, runner, typed, type: async (pid: number, text: string) => void typed.push([pid, text]) };
}

function clock() {
	let t = 1_000_000;
	return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}
const deps = (runner: Runner) => ({ paths, runner, type: async () => {}, ...clock() });
const submits = (calls: Call[]) => calls.filter(c => c.stdin?.includes('"action":"submit"'));
const everything = (calls: Call[]) => calls.map(c => c.argv.join(" ")).join("\n");

test("not installed, no accessibility and no credentials stop before anything is launched or submitted", async () => {
	let m = fakeMachine({ installed: false, states: [] });
	expect((await login(deps(m.runner))).status).toBe("not_installed");
	expect(m.calls.some(c => c.argv[0] === "open")).toBe(false);

	m = fakeMachine({ trusted: false, states: [] });
	expect((await login(deps(m.runner))).status).toBe("no_accessibility");

	m = fakeMachine({ states: [] });
	expect((await login(deps(m.runner))).status).toBe("no_credentials");
	expect(m.calls.some(c => c.argv[0] === "open")).toBe(false);
});

test("a login screen is typed into and submitted once, ending ok; the app opens hidden and credentials go only to KakaoTalk's pid", async () => {
	storeCreds();
	const m = fakeMachine({ states: [{ state: "unknown" }, { state: "login" }], afterSubmit: [{ state: "login", detail: "submitted" }, { state: "main" }] });
	expect(await login({ ...deps(m.runner), type: m.type })).toEqual({ status: "ok" });
	expect(m.typed).toEqual([[4242, ID], [4242, PW]]);
	expect(m.calls.filter(c => c.stdin?.includes('"action":"focus"')).map(c => JSON.parse(c.stdin!).field)).toEqual(["id", "password"]);
	const open = m.calls.find(c => c.argv[0] === "open")!;
	expect(open.argv).toContain("-g");
	expect(open.argv).toContain("-j");
	expect(open.argv).not.toContain("-n");
	expect(submits(m.calls)).toHaveLength(1);
	expect(everything(m.calls)).not.toContain(PW);
	expect(everything(m.calls)).not.toContain(ID);
	for (const c of m.calls) expect(c.stdin ?? "").not.toContain(PW);
});

test("an already logged-in app is ok without a submit", async () => {
	storeCreds();
	const m = fakeMachine({ states: [{ state: "main" }] });
	expect(await login(deps(m.runner))).toEqual({ status: "ok" });
	expect(submits(m.calls)).toHaveLength(0);
});

test("a device confirmation returns confirm, and resumeAfterConfirm waits for main without submitting again", async () => {
	storeCreds();
	const m = fakeMachine({ states: [{ state: "login" }], afterSubmit: [{ state: "confirm" }] });
	expect((await login(deps(m.runner))).status).toBe("confirm");
	expect(submits(m.calls)).toHaveLength(1);

	const w = fakeMachine({ states: [{ state: "confirm" }, { state: "confirm" }, { state: "main" }] });
	expect(await resumeAfterConfirm(deps(w.runner))).toEqual({ status: "ok" });
	expect(submits(w.calls)).toHaveLength(0);

	const never = fakeMachine({ states: [{ state: "confirm" }] });
	const t = clock();
	const r = await resumeAfterConfirm({ paths, runner: never.runner, ...t });
	expect(r.status).toBe("failed");
	expect(t.now() - 1_000_000).toBeGreaterThanOrEqual(5 * 60_000);
	expect(t.now() - 1_000_000).toBeLessThan(6 * 60_000);
	expect(submits(never.calls)).toHaveLength(0);
});

test("a rejected password gives bad_credentials, is remembered by hash only, and is never submitted again until it changes", async () => {
	storeCreds();
	const m = fakeMachine({ states: [{ state: "login" }], afterSubmit: [{ state: "login", detail: "submitted" }, { state: "error", detail: "rejected" }] });
	expect((await login(deps(m.runner))).status).toBe("bad_credentials");
	const file = join(dir, "kakao", "login.json");
	expect(statSync(file).mode & 0o777).toBe(0o600);
	const rec = readFileSync(file, "utf8");
	expect(rec).toContain("badAt");
	expect(rec).not.toContain(PW);
	expect(rec).not.toContain(ID);

	const again = fakeMachine({ states: [{ state: "login" }] });
	const r = await login(deps(again.runner));
	expect(r.status).toBe("bad_credentials");
	expect(submits(again.calls)).toHaveLength(0);
	expect(again.calls.some(c => c.argv[0] === "open")).toBe(false);

	storeCreds(ID, "Pw-changed-2");
	const changed = fakeMachine({ states: [{ state: "login" }], afterSubmit: [{ state: "main" }] });
	expect((await login(deps(changed.runner))).status).toBe("ok");
	expect(submits(changed.calls)).toHaveLength(1);
	expect(existsSync(file)).toBe(false);
});

test("a rejection notice left on screen before the submit is not counted against the new password", async () => {
	storeCreds();
	const m = fakeMachine({ states: [{ state: "error", detail: "rejected" }], afterSubmit: [{ state: "error", detail: "rejected" }, { state: "login" }, { state: "main" }] });
	expect((await login(deps(m.runner))).status).toBe("ok");
	expect(submits(m.calls)).toHaveLength(1);
});

test("a screen that never reaches main ends failed within the budget", async () => {
	storeCreds();
	const m = fakeMachine({ states: [{ state: "unknown" }] });
	const t = clock();
	expect((await login({ paths, runner: m.runner, ...t })).status).toBe("failed");
	expect(t.now() - 1_000_000).toBeLessThan(60_000);
	expect(submits(m.calls)).toHaveLength(0);
});

test("the helpers use the documented commands", async () => {
	const m = fakeMachine({ states: [{ state: "login" }] });
	const d = deps(m.runner);
	expect(await appInstalled(d)).toBe(true);
	expect(await accessibilityGranted(d)).toBe(true);
	expect(await launchBackground(d)).toBe(true);
	expect(await kakaoState(d)).toEqual({ state: "login" });
	expect(m.calls.find(c => c.argv[0] === "open")!.argv).toEqual(["open", "-g", "-j", "-a", "/Applications/KakaoTalk.app"]);
	expect(m.calls[1]!.argv.join(" ")).toContain("osascript -l JavaScript -e");
});

test("the JXA source never activates the app, sends System Events keystrokes or raises a window", () => {
	for (const word of ["activate", "keystroke", "key code", "frontmost", "set visible"]) expect(jxa).not.toContain(word);
	expect(() => new Function(jxa)).not.toThrow();
});

// The JXA source run against a fake System Events tree.
type Spec = { role: string; title?: string; value?: string; desc?: string; pos?: [number, number]; enabled?: boolean; kids?: Spec[] };
function node(s: Spec): any {
	const e: any = { _v: s.value, sets: [] as string[], pressed: 0, kids: (s.kids ?? []).map(node) };
	e.role = () => s.role;
	e.title = () => s.title;
	e.name = () => s.title;
	e.description = () => s.desc;
	e.enabled = () => s.enabled ?? true;
	e.position = () => s.pos ?? [0, 0];
	e.uiElements = () => e.kids;
	e.focusedSet = 0;
	Object.defineProperty(e, "focused", { get: () => () => false, set: (v: boolean) => void (v && e.focusedSet++) });
	Object.defineProperty(e, "value", { get: () => () => e._v, set: (v: string) => { e._v = v; e.sets.push(v); } });
	e.actions = { byName: (n: string) => ({ perform: () => { if (n !== "AXPress") throw new Error("only AXPress"); e.pressed++; } }) };
	return e;
}
function runJxa(windows: Spec[], req: unknown, running = true) {
	const wins = windows.map(node);
	const proc = { windows: () => wins, unixId: () => 4242 };
	const app = () => ({ processes: Object.assign(() => (running ? [proc] : []), { whose: () => () => (running ? [proc] : []) }) });
	const $ = { NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: typeof req === "string" ? req : JSON.stringify(req) } }, NSString: { alloc: { initWithDataEncoding: (d: string) => d } }, NSUTF8StringEncoding: 4 };
	const out = new Function("Application", "ObjC", "$", `${jxa}\nreturn run();`)(app, { import() {}, unwrap: (x: unknown) => x }, $) as string;
	return { out, wins, json: JSON.parse(out) as KakaoState };
}
const loginWindow: Spec = {
	role: "AXWindow",
	title: "카카오톡",
	kids: [
		{ role: "AXTextField", pos: [0, 10], title: "email" },
		{ role: "AXSecureTextField", pos: [0, 50] },
		{ role: "AXButton", title: "QR코드로 로그인", pos: [0, 140] },
		{ role: "AXButton", title: "로그인", pos: [0, 90] },
	],
};

test("JXA: state detection for login, lock, confirm, rejection, main and a closed app", () => {
	expect(runJxa([loginWindow], { action: "state" }).json).toEqual({ state: "login" });
	expect(runJxa([{ role: "AXWindow", title: "Chats", kids: [{ role: "AXScrollArea", kids: [{ role: "AXStaticText", value: "로그인" }] }] }], { action: "state" }).json).toEqual({ state: "main" });
	const lock: Spec = { role: "AXWindow", title: "KakaoTalk", kids: [{ role: "AXStaticText", value: "KakaoTalk is currently locked." }, { role: "AXTextField" }, { role: "AXButton", title: "확인" }] };
	expect(runJxa([lock], { action: "state" }).json).toEqual({ state: "locked" });
	const confirm: Spec = { role: "AXWindow", title: "KakaoTalk", kids: [{ role: "AXStaticText", value: "휴대폰에서 인증을 확인해 주세요" }] };
	expect(runJxa([confirm], { action: "state" }).json).toEqual({ state: "confirm" });
	const rejected: Spec = { ...loginWindow, kids: [...loginWindow.kids!, { role: "AXStaticText", value: "비밀번호가 틀렸어요" }] };
	expect(runJxa([rejected], { action: "state" }).json).toEqual({ state: "error", detail: "rejected" });
	expect(runJxa([], { action: "state" }, false).json.state).toBe("unknown");
	expect(runJxa([{ role: "AXWindow", title: "Chats", kids: [{ role: "AXStaticText", value: "비밀번호 틀렸다" }, { role: "AXScrollArea" }] }], { action: "state" }).json).toEqual({ state: "main" });
});

test("JXA: focus clears and focuses one field and answers the pid; submit presses only an enabled login button", () => {
	let r = runJxa([loginWindow], { action: "focus", field: "id" });
	expect(r.json).toEqual({ state: "login", detail: "focused", pid: 4242 });
	expect(r.wins[0].kids[0].sets).toEqual([""]);
	expect(r.wins[0].kids[0].focusedSet).toBe(1);
	r = runJxa([loginWindow], { action: "focus", field: "password" });
	expect(r.wins[0].kids[1].focusedSet).toBe(1);
	expect(r.wins[0].kids[0].focusedSet).toBe(0);
	const korean: Spec = { ...loginWindow, kids: [{ role: "AXTextField", pos: [0, 10], desc: "텍스트 필드" }, { role: "AXTextField", pos: [0, 50], desc: "보안 텍스트 필드" }, { role: "AXButton", title: "로그인", pos: [0, 90] }] };
	r = runJxa([korean], { action: "focus", field: "password" });
	expect(r.wins[0].kids[1].focusedSet).toBe(1);
	r = runJxa([loginWindow], { action: "submit" });
	const [, , qr, button] = r.wins[0].kids;
	expect(button.pressed).toBe(1);
	expect(qr.pressed).toBe(0);
	expect(r.json).toEqual({ state: "login", detail: "submitted" });
	const disabled: Spec = { ...korean, kids: [...korean.kids!.slice(0, 2), { role: "AXButton", title: "로그인", pos: [0, 90], enabled: false }] };
	r = runJxa([disabled], { action: "submit" });
	expect(r.json).toEqual({ state: "login", detail: "submit_disabled" });
	expect(r.wins[0].kids[2].pressed).toBe(0);
});

test("JXA: on the lock screen focus takes its single field and submit presses confirm; a bad request is an error", () => {
	const lock: Spec = { role: "AXWindow", title: "KakaoTalk", kids: [{ role: "AXStaticText", value: "잠금 모드" }, { role: "AXTextField" }, { role: "AXButton", title: "계정 변경" }, { role: "AXButton", title: "확인" }] };
	expect(runJxa([lock], { action: "focus", field: "password" }).wins[0].kids[1].focusedSet).toBe(1);
	const r = runJxa([lock], { action: "submit" });
	const [, , other, ok] = r.wins[0].kids;
	expect(ok.pressed).toBe(1);
	expect(other.pressed).toBe(0);
	expect(r.json).toEqual({ state: "locked", detail: "submitted" });
	expect(runJxa([lock], "not json").json).toEqual({ state: "error", detail: "bad_input" });
});

test("JXA: focus and submit on a logged-in app change nothing", () => {
	const main: Spec = { role: "AXWindow", title: "Chats", kids: [{ role: "AXScrollArea" }, { role: "AXTextField", title: "search" }] };
	for (const req of [{ action: "focus", field: "password" }, { action: "submit" }]) {
		const r = runJxa([main], req);
		expect(r.json).toEqual({ state: "main" });
		expect(r.wins[0].kids[1].sets).toEqual([]);
		expect(r.wins[0].kids[1].focusedSet).toBe(0);
	}
});

test("a 'logged in on another computer' notice after the submit is confirmed and the login ends ok", async () => {
	storeCreds();
	const m = fakeMachine({ states: [{ state: "login" }], afterSubmit: [{ state: "login", detail: "notice" }, { state: "main" }] });
	expect((await login(deps(m.runner))).status).toBe("ok");
	expect(m.calls.filter(c => c.stdin?.includes('"action":"ack"'))).toHaveLength(1);
	expect(submits(m.calls)).toHaveLength(1);
});

test("JXA: the another-device and forced-logout notices are detected and only their OK is pressed, never cancel", () => {
	const notice: Spec = {
		role: "AXWindow",
		title: "카카오톡",
		kids: [
			{ role: "AXStaticText", value: "다른 기기에서 로그인 중입니다." },
			{ role: "AXStaticText", value: "강제 로그아웃하고, 현재 기기에서 로그인 하시겠습니까?" },
			{ role: "AXButton", title: "취소" },
			{ role: "AXButton", title: "확인" },
		],
	};
	expect(runJxa([notice], { action: "state" }).json).toEqual({ state: "login", detail: "notice" });
	const r = runJxa([notice], { action: "ack" });
	expect(r.json).toEqual({ state: "login", detail: "notice_handled" });
	expect(r.wins[0].kids[2].pressed).toBe(0);
	expect(r.wins[0].kids[3].pressed).toBe(1);
	const onlyCancel: Spec = { ...notice, kids: notice.kids!.slice(0, 3) };
	const u = runJxa([onlyCancel], { action: "ack" });
	expect(u.json.detail).toBe("notice_unhandled");
	expect(u.wins[0].kids[2].pressed).toBe(0);
	// Seen on a real screen: the forced-logout notice laid over the login form.
	const loggedOut: Spec = { ...loginWindow, title: "로그인", kids: [...loginWindow.kids!, { role: "AXStaticText", value: "로그아웃 되었습니다." }, { role: "AXStaticText", value: "다른 기기에서 로그인해 로그아웃 되었습니다." }, { role: "AXButton", title: "확인" }] };
	expect(runJxa([loggedOut], { action: "state" }).json).toEqual({ state: "login", detail: "notice" });
	expect(runJxa([loggedOut], { action: "ack" }).wins[0].kids[6].pressed).toBe(1);
	expect(runJxa([loginWindow], { action: "state" }).json).toEqual({ state: "login" });
});
