// Computer steps the bot does itself before it hands anything to the owner: open the exact System Settings privacy pane, turn the
// app's switch on through System Events (accessibility actions, no mouse, no focus change), press Allow on a permission prompt,
// restart an app, then re-check. Only what macOS refuses to automate (a protected prompt that ignores synthetic clicks, a Mac
// password or Touch ID sheet) comes back as ONE exact step for the owner. Every side effect goes through the injected exec, so
// tests run with fakes and never touch the real UI. Linux / WSL have no TCC: permission steps are skipped there.
// Never types a secret: the only keystrokes are the app path in a file chooser that System Settings itself opened.

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;
export type Host = { exec: Exec; sleep: (ms: number) => Promise<void>; platform?: NodeJS.Platform };

export type PermKey = "fda" | "files" | "accessibility" | "automation" | "screen";
const PANE = "x-apple.systempreferences:com.apple.preference.security?";
export const PANES: Record<PermKey, string> = {
	fda: `${PANE}Privacy_AllFiles`,
	files: `${PANE}Privacy_FilesAndFolders`,
	accessibility: `${PANE}Privacy_Accessibility`,
	automation: `${PANE}Privacy_Automation`,
	screen: `${PANE}Privacy_ScreenCapture`,
};
export const PERM_LABEL: Record<PermKey, string> = { fda: "전체 디스크 접근", files: "파일 및 폴더", accessibility: "손쉬운 사용", automation: "자동화", screen: "화면 기록" };

// The switch result printed by TOGGLE_JXA: on = already on, toggled = pressed it, added = added the app with + and pressed it,
// absent = no row for the app, refused = System Events may not drive the UI (bun lacks Accessibility itself), error = anything else.
export type ToggleResult = "on" | "toggled" | "added" | "absent" | "refused" | "error";

// argv: <row name> <app path or ""> . Finds the row whose text is the app name in the open System Settings window and presses its switch.
export const TOGGLE_JXA = `function run(argv) {
	const name = argv[0], path = argv[1] || "";
	const se = Application("System Events");
	let p;
	try {
		for (let i = 0; i < 40; i++) { if (se.processes.byName("System Settings").exists()) break; delay(0.25); }
		p = se.processes.byName("System Settings");
		for (let i = 0; i < 40 && p.windows.length === 0; i++) delay(0.25);
		delay(1);
	} catch (e) { return /-1719|-25211|assistive|접근/.test(String(e)) ? "refused" : "error"; }
	const text = (e) => { try { return [e.name(), e.description(), e.value()].map(v => (v === null || v === undefined ? "" : String(v))).join(" "); } catch (_) { return ""; } };
	const find = () => {
		let all;
		try { all = p.windows[0].entireContents(); } catch (e) { return { err: /-1719|-25211|assistive/.test(String(e)) ? "refused" : "error" }; }
		for (const e of all) {
			let role = "";
			try { role = e.role(); } catch (_) { continue; }
			if (role !== "AXCheckBox" && role !== "AXSwitch") continue;
			let label = text(e);
			try { label += " " + e.attributes.byName("AXParent").value().uiElements().map(text).join(" "); } catch (_) {}
			if (label.split(/\\s+/).includes(name)) return { el: e };
		}
		return {};
	};
	let r = find();
	if (r.err) return r.err;
	let added = false;
	if (!r.el && path) {
		let plus;
		for (const e of p.windows[0].entireContents()) {
			try { if (e.role() === "AXButton" && /^(\\+|Add|추가)$/.test(String(e.description() || e.name() || ""))) { plus = e; break; } } catch (_) {}
		}
		if (!plus) return "absent";
		plus.click();
		delay(1.5);
		// Keystrokes only into the file chooser System Settings just opened: never a secret, never another window.
		if (!se.processes.byName("System Settings").frontmost() || p.windows[0].sheets.length === 0) return "absent";
		se.keystroke("g", { using: ["command down", "shift down"] });
		delay(0.8);
		se.keystroke(path);
		delay(0.5);
		se.keyCode(36);
		delay(0.8);
		se.keyCode(36);
		delay(1.5);
		added = true;
		r = find();
	}
	if (!r.el) return "absent";
	try { if (Number(r.el.value()) === 1) return added ? "added" : "on"; r.el.click(); } catch (e) { return "error"; }
	return added ? "added" : "toggled";
}`;

// Presses Allow on a permission prompt (UserNotificationCenter / CoreServicesUIAgent / universalAccessAuthWarn). Never touches a
// password sheet (SecurityAgent). Prints clicked or none.
export const ALLOW_JXA = `function run() {
	const se = Application("System Events");
	for (const proc of ["UserNotificationCenter", "CoreServicesUIAgent", "universalAccessAuthWarn"]) {
		try {
			const p = se.processes.byName(proc);
			if (!p.exists()) continue;
			for (const w of p.windows()) for (const b of w.buttons()) {
				const n = String(b.name() || "");
				if (/^(Allow|허용|OK|확인|Open System Settings|시스템 설정 열기)$/.test(n)) { b.click(); return "clicked"; }
			}
		} catch (_) {}
	}
	return "none";
}`;

const mac = (h: Host) => (h.platform ?? process.platform) === "darwin";
const jxa = (h: Host, src: string, args: string[] = [], timeoutMs = 45_000) => h.exec(["osascript", "-l", "JavaScript", "-e", src, ...args], { timeoutMs });

export async function openPane(h: Host, key: PermKey): Promise<boolean> {
	if (!mac(h)) return false;
	return (await h.exec(["open", "-g", PANES[key]])).code === 0;
}

export async function toggleApp(h: Host, row: string, path = ""): Promise<ToggleResult> {
	const r = await jxa(h, TOGGLE_JXA, [row, path]);
	const out = r.stdout.trim();
	if (["on", "toggled", "added", "absent", "refused", "error"].includes(out)) return out as ToggleResult;
	return /-1719|-25211|assistive/i.test(r.stderr) ? "refused" : "error";
}

export async function clickAllow(h: Host): Promise<boolean> {
	if (!mac(h)) return false;
	return (await jxa(h, ALLOW_JXA, [], 15_000)).stdout.trim() === "clicked";
}

export type Grant = { status: "granted" | "skipped" | "needs-owner"; tried: string[]; step?: string };

/** The one step the owner still has to do after the bot tried, in words. */
export function ownerStep(key: PermKey, row: string, path: string, toggled: ToggleResult | undefined): string {
	const pane = `시스템 설정 > 개인정보 보호 및 보안 > ${PERM_LABEL[key]}`;
	if (toggled === "toggled" || toggled === "added") return `${pane} 창을 열고 ${row} 스위치까지 눌러 두었어요. 화면에 뜬 Mac 암호(또는 Touch ID) 확인만 해 주세요`;
	return `${pane} 창을 열어 두었어요. macOS가 자동 클릭을 막아서 ${row} 스위치만 직접 켜 주세요${path ? ` (목록에 없으면 + 로 ${path} 추가)` : ""}`;
}

/**
 * Gets one permission without the owner when macOS lets it: check -> open the pane -> press the app's switch (adding it with +
 * when the path is given) -> press Allow on a prompt -> re-check a few times. `check` must report the real state of the process
 * that needs the permission.
 */
export async function grantPermission(
	h: Host,
	o: { key: PermKey; row: string; path?: string; check: () => Promise<boolean>; tries?: number; waitMs?: number },
): Promise<Grant> {
	if (!mac(h)) return { status: "skipped", tried: [] };
	if (await o.check()) return { status: "granted", tried: [] };
	const tried: string[] = [];
	if (await openPane(h, o.key)) tried.push("pane");
	let toggled: ToggleResult | undefined;
	// The Automation and Files and Folders panes nest switches under each app; a row match there could flip another app's switch.
	if (o.key !== "automation" && o.key !== "files") {
		toggled = await toggleApp(h, o.row, o.path ?? "");
		tried.push(`toggle:${toggled}`);
	}
	const tries = o.tries ?? 8;
	for (let i = 0; i < tries; i++) {
		if (await clickAllow(h)) tried.push("allow");
		if (await o.check()) return { status: "granted", tried };
		if (i < tries - 1) await h.sleep(o.waitMs ?? 1500);
	}
	return { status: "needs-owner", tried, step: ownerStep(o.key, o.row, o.path ?? "", toggled) };
}

/** Presses Allow on whatever permission prompt appears until `done` resolves (a prompt raised by a probe the caller runs). */
export async function allowWhile<T>(h: Host, done: Promise<T>, everyMs = 1000): Promise<T> {
	if (!mac(h)) return done;
	let over = false;
	const loop = (async () => {
		while (!over) {
			await clickAllow(h);
			if (!over) await h.sleep(everyMs);
		}
	})();
	try {
		return await done;
	} finally {
		over = true;
		await loop;
	}
}

/** Quits an app and opens it again in the background (`open -g -j -a`). True when it is running afterwards. */
export async function restartApp(h: Host, app: string, o: { tries?: number; waitMs?: number } = {}): Promise<boolean> {
	const running = async () => (await h.exec(["pgrep", "-x", app])).code === 0;
	const tries = o.tries ?? 20;
	if (mac(h)) await h.exec(["osascript", "-e", `quit app "${app.replace(/["\\]/g, "")}"`], { timeoutMs: 20_000 });
	for (let i = 0; i < tries && (await running()); i++) await h.sleep(o.waitMs ?? 500);
	if (await running()) await h.exec(["pkill", "-x", app]);
	if (mac(h)) await h.exec(["open", "-g", "-j", "-a", app]);
	else return false;
	for (let i = 0; i < tries; i++) {
		if (await running()) return true;
		await h.sleep(o.waitMs ?? 500);
	}
	return false;
}

// Programs that drive the real UI or system state (System Settings, TCC, launchd, app quits). Under `bun test` (NODE_ENV=test, or
// DOTZ_NO_REAL_UI=1 from the test preload, which spawned scripts inherit or get passed) the real runners refuse them, so a test
// that forgets to inject a fake fails loudly instead of clicking on the machine running it.
const UI_PROGRAMS = new Set(["open", "osascript", "tccutil", "killall", "pkill", "launchctl", "screencapture"]);
export const realUiBlocked = () => process.env.NODE_ENV === "test" || process.env.DOTZ_NO_REAL_UI === "1";
export function refuseRealUi(argv: string[]): void {
	const prog = (argv[0] ?? "").split("/").pop() ?? "";
	if (UI_PROGRAMS.has(prog) && realUiBlocked()) throw new Error(`refused under test: ${prog} would touch the real UI or system; inject a fake runner`);
}

export const realHost: Host = {
	exec: async (argv, opts = {}) => {
		refuseRealUi(argv);
		const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const kill = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		clearTimeout(kill);
		return { code, stdout, stderr };
	},
	sleep: ms => Bun.sleep(ms),
};
