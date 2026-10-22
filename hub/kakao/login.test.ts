import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function storeFallback(id = ID, password = PW) {
	mkdirSync(join(dir, "secrets"), { recursive: true });
	writeFileSync(paths.secretFile, JSON.stringify({ username: id, password }), { mode: 0o600 });
}

type Call = { argv: string[]; stdin?: string };
// A fake machine: the Keychain is empty (credentials come from the fallback file), the state script answers {action:"state"}.
function fakeMachine(o: { installed?: boolean; trusted?: boolean; states: KakaoState[]; afterSubmit?: KakaoState[] }) {
	const calls: Call[] = [];
	const states = [...o.states];
	let last: KakaoState = { state: "unknown" };
	const runner: Runner = async (argv, opts) => {
		calls.push({ argv, stdin: opts?.stdin });
		const prog = argv[0];
		if (prog === "/bin/test") return { code: o.installed === false ? 1 : 0, stdout: "", stderr: "" };
		if (prog === "security") return { code: 44, stdout: "", stderr: "" };
		if (prog === "open") return { code: 0, stdout: "", stderr: "" };
		if (prog === "osascript") {
			if (argv.some(a => a.includes("AXIsProcessTrusted"))) return { code: 0, stdout: `${o.trusted === false ? "false" : "true"}\n`, stderr: "" };
			const req = JSON.parse(opts?.stdin ?? "{}");
			if (req.action === "login") {
				if (o.afterSubmit) states.splice(0, states.length, ...o.afterSubmit);
				return { code: 0, stdout: `${JSON.stringify({ state: "login", detail: "submitted" })}\n`, stderr: "" };
			}
			if (req.action === "state") last = states.length > 1 ? states.shift()! : (states[0] ?? last);
			return { code: 0, stdout: `${JSON.stringify(last)}\n`, stderr: "" };
		}
		return { code: 127, stdout: "", stderr: "unexpected" };
	};
	return { calls, runner };
}

function clock() {
	let t = 1_000_000;
	return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}
const deps = (runner: Runner) => ({ paths, runner, ...clock() });
const submits = (calls: Call[]) => calls.filter(c => c.stdin?.includes('"action":"login"'));
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

test("a login screen is submitted once and ends ok; the app opens hidden and credentials travel only on stdin", async () => {
	storeFallback();
	const m = fakeMachine({ states: [{ state: "unknown" }, { state: "login" }], afterSubmit: [{ state: "login", detail: "submitted" }, { state: "main" }] });
	expect(await login(deps(m.runner))).toEqual({ status: "ok" });
	const open = m.calls.find(c => c.argv[0] === "open")!;
	expect(open.argv).toContain("-g");
	expect(open.argv).toContain("-j");
	expect(open.argv).not.toContain("-n");
	const sent = submits(m.calls);
	expect(sent).toHaveLength(1);
	expect(JSON.parse(sent[0]!.stdin!)).toEqual({ action: "login", id: ID, password: PW });
	expect(everything(m.calls)).not.toContain(PW);
	expect(everything(m.calls)).not.toContain(ID);
	for (const c of m.calls) if (!c.stdin?.includes('"action":"login"')) expect(c.stdin ?? "").not.toContain(PW);
});

test("an already logged-in app is ok without a submit", async () => {
	storeFallback();
	const m = fakeMachine({ states: [{ state: "main" }] });
	expect(await login(deps(m.runner))).toEqual({ status: "ok" });
	expect(submits(m.calls)).toHaveLength(0);
});

test("a device confirmation returns confirm, and resumeAfterConfirm waits for main without submitting again", async () => {
	storeFallback();
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
	storeFallback();
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

	storeFallback(ID, "Pw-changed-2");
	const changed = fakeMachine({ states: [{ state: "login" }], afterSubmit: [{ state: "main" }] });
	expect((await login(deps(changed.runner))).status).toBe("ok");
	expect(submits(changed.calls)).toHaveLength(1);
	expect(existsSync(file)).toBe(false);
});

test("a rejection notice left on screen before the submit is not counted against the new password", async () => {
	storeFallback();
	const m = fakeMachine({ states: [{ state: "error", detail: "rejected" }], afterSubmit: [{ state: "error", detail: "rejected" }, { state: "login" }, { state: "main" }] });
	expect((await login(deps(m.runner))).status).toBe("ok");
	expect(submits(m.calls)).toHaveLength(1);
});

test("a screen that never reaches main ends failed within the budget", async () => {
	storeFallback();
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

test("the JXA source never activates the app, types keys or raises a window", () => {
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
	Object.defineProperty(e, "value", { get: () => () => e._v, set: (v: string) => { e._v = v; e.sets.push(v); } });
	e.actions = { byName: (n: string) => ({ perform: () => { if (n !== "AXPress") throw new Error("only AXPress"); e.pressed++; } }) };
	return e;
}
function runJxa(windows: Spec[], req: unknown, running = true) {
	const wins = windows.map(node);
	const proc = { windows: () => wins };
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

test("JXA: login fills the two fields by AXValue, presses only the login button and never prints the input", () => {
	const r = runJxa([loginWindow], { action: "login", id: ID, password: PW });
	const [idField, pwField, qr, button] = r.wins[0].kids;
	expect(idField._v).toBe(ID);
	expect(pwField._v).toBe(PW);
	expect(button.pressed).toBe(1);
	expect(qr.pressed).toBe(0);
	expect(r.json).toEqual({ state: "login", detail: "submitted" });
	expect(r.out).not.toContain(PW);
	expect(r.out).not.toContain(ID);
});

test("JXA: the lock screen password goes into its single field and confirm is pressed; a bad request is an error", () => {
	const lock: Spec = { role: "AXWindow", title: "KakaoTalk", kids: [{ role: "AXStaticText", value: "잠금 모드" }, { role: "AXTextField" }, { role: "AXButton", title: "계정 변경" }, { role: "AXButton", title: "확인" }] };
	const r = runJxa([lock], { action: "login", id: ID, password: PW });
	const [, field, other, ok] = r.wins[0].kids;
	expect(field._v).toBe(PW);
	expect(ok.pressed).toBe(1);
	expect(other.pressed).toBe(0);
	expect(r.json).toEqual({ state: "locked", detail: "submitted" });
	expect(runJxa([lock], "not json").json).toEqual({ state: "error", detail: "bad_input" });
});

test("JXA: a login action on a logged-in app changes nothing", () => {
	const main: Spec = { role: "AXWindow", title: "Chats", kids: [{ role: "AXScrollArea" }, { role: "AXTextField", title: "search" }] };
	const r = runJxa([main], { action: "login", id: ID, password: PW });
	expect(r.json).toEqual({ state: "main" });
	expect(r.wins[0].kids[1].sets).toEqual([]);
});
