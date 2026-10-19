// One dedicated, minimized Aside window for every gateway browser job (as 오모냥's aside-window.ts). The owner works in
// Aside themself, so nothing here activates Aside, raises or unminimizes a window, sends OS keystrokes or touches any other
// window. The AppleScript window id equals the `windowId` that `listBrowserTabs()` reports in `aside repl`, so repl code
// picks tabs from this window only. The window keeps an about:blank anchor tab: closing the last work tab would close the
// window itself. State (window id + name) lives in <data dir>/aside-window.json; a window whose id was lost is found again by
// its given name.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, NAME } from "./config.ts";

const STORE = join(DATA_DIR, "aside-window.json");
const ANCHOR = "about:blank";
const OSA_MS = 15_000;
export const ASIDE = Bun.which("aside") ?? "aside";

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Spawn with a hard kill: a hung `aside repl`/osascript must never stall the gateway.
export async function runCmd(argv: string[], timeoutMs: number): Promise<{ out: string; err: string; timedOut: boolean }> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill(9);
	}, timeoutMs);
	let out = "";
	let err = "";
	const reading = Promise.all([new Response(proc.stdout).text().then(t => (out = t)), new Response(proc.stderr).text().then(t => (err = t))]);
	await proc.exited;
	clearTimeout(timer);
	await Promise.race([reading, Bun.sleep(2000)]);
	return { out, err, timedOut };
}

async function osa(script: string, ms = OSA_MS): Promise<string> {
	const r = await runCmd(["osascript", "-e", script], ms);
	if (r.timedOut) throw new Error(`osascript timed out after ${ms}ms`);
	if (r.err.trim()) throw new Error(`osascript: ${r.err.trim().slice(0, 300)}`);
	return r.out.trim();
}

async function stored(): Promise<{ id: string | null; name: string }> {
	const j = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8") || "{}") : {};
	return { id: String(j.id ?? "") || null, name: String(j.name ?? "") || `${NAME}-automation` };
}

// `tell application "Aside"` launches a stopped app (and Aside then takes the foreground), so every AppleScript call is
// preceded by this check: Aside not running is a failure, never something we start.
async function requireAsideRunning(): Promise<void> {
	const r = await osa('tell application "System Events" to exists process "Aside"');
	if (r !== "true") throw new Error("Aside is not running (not started on purpose: launching it would take the foreground)");
}

// One-shot CDP call sequence on Aside's browser endpoint (<Aside data dir>/DevToolsActivePort). `make new window` in
// AppleScript activates the app; Target.createTarget{newWindow, background} does not.
type CdpSend = <R>(method: string, params?: object) => Promise<R>;
async function cdp<T>(steps: (send: CdpSend) => Promise<T>): Promise<T> {
	const f = join(process.env.HOME ?? "", "Library", "Application Support", "Aside", "DevToolsActivePort");
	if (!existsSync(f)) throw new Error("Aside DevToolsActivePort not found");
	const [port, path] = readFileSync(f, "utf8").trim().split("\n");
	const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
	let n = 0;
	const pending: Record<number, { ok: (v: unknown) => void; ko: (e: Error) => void }> = {};
	ws.onmessage = ev => {
		const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
		const p = m.id === undefined ? undefined : pending[m.id];
		if (!p || m.id === undefined) return;
		delete pending[m.id];
		if (m.error) p.ko(new Error(`CDP ${m.error.message}`));
		else p.ok(m.result);
	};
	const send: CdpSend = <R>(method: string, params: object = {}) =>
		new Promise<R>((ok, ko) => {
			const id = ++n;
			pending[id] = { ok: v => ok(v as R), ko };
			ws.send(JSON.stringify({ id, method, params }));
		});
	const timer = setTimeout(() => ws.close(), OSA_MS);
	try {
		await new Promise<void>((ok, ko) => {
			ws.onopen = () => ok();
			ws.onerror = () => ko(new Error("Aside CDP endpoint unreachable"));
		});
		ws.onerror = null;
		ws.onclose = () => { for (const p of Object.values(pending)) p.ko(new Error("CDP closed")); };
		return await steps(send);
	} finally {
		clearTimeout(timer);
		ws.close();
	}
}

// Returns the AppleScript id of the automation window, creating it (minimized, never activated) when it is gone.
export async function ensureAutomationWindow(): Promise<string> {
	await requireAsideRunning();
	const ids = (await osa('tell application "Aside" to get id of every window')).split(/,\s*/).filter(Boolean);
	let { id, name } = await stored();
	if (!id || !ids.includes(id)) {
		const named = await osa(`tell application "Aside" to get id of every window whose given name is ${q(name)}`).catch(() => "");
		id = named.split(/,\s*/).filter(Boolean)[0] ?? null;
	}
	if (!id) {
		// The CDP windowId is the browser window's session id, which is also the AppleScript window id.
		const created = await cdp(async send => {
			const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: ANCHOR, newWindow: true, background: true });
			const { windowId } = await send<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
			await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
			return String(windowId);
		});
		if (!/^\d+$/.test(created)) throw new Error(`could not create automation window: ${created}`);
		id = created;
		await osa(`tell application "Aside" to set given name of window id ${q(id)} to ${q(name)}`);
	}
	await Bun.write(STORE, JSON.stringify({ id, name, updated: new Date().toISOString() }));
	// Anchor tab and minimized state are re-checked on every use (both are cheap and both protect the owner's view).
	await osa(`tell application "Aside"
  set w to window id ${q(id)}
  if (URL of every tab of w) does not contain ${q(ANCHOR)} then
    tell w to make new tab with properties {URL:${q(ANCHOR)}}
  end if
  if minimized of w is false then set minimized of w to true
end tell`);
	return id;
}

// CDP target ids of the tabs currently in the automation window (read-only).
async function targetIds(windowId: string): Promise<string[]> {
	const r = await runCmd([ASIDE, "repl", `console.log('IDS ' + JSON.stringify((await listBrowserTabs()).filter(x => String(x.windowId) === ${q(windowId)}).map(x => x.targetId ?? x.id)))`], 30_000);
	const line = r.out.split("\n").find(l => l.startsWith("IDS "));
	if (!line) throw new Error(`aside repl failed${r.timedOut ? " (timeout)" : ""}: ${(r.out + r.err).slice(-300)}`);
	return JSON.parse(line.slice(4));
}

// tabId = AppleScript id of the tab we opened; close() closes exactly that tab (several jobs can share the window).
export type AutomationTab = { windowId: string; tabId: string; url: string; before: string[]; close: () => Promise<void> };

// Opens url in a new tab of the automation window and keeps the window minimized. AppleScript-opened tabs outlive the repl
// run (unlike repl openTab() tabs), so callers close them when done.
export async function openInAutomationWindow(url: string): Promise<AutomationTab> {
	const windowId = await ensureAutomationWindow();
	const before = await targetIds(windowId);
	const tabId = await osa(`tell application "Aside"
  set t to make new tab at end of tabs of window id ${q(windowId)} with properties {URL:${q(url)}}
  if minimized of window id ${q(windowId)} is false then set minimized of window id ${q(windowId)} to true
  return id of t
end tell`);
	return { windowId, tabId, url, before, close: () => closeTab(windowId, tabId) };
}

// Repl code that declares `const <v>` bound to the new tab (the one not in the window before) once it has loaded.
function attachCode(t: AutomationTab, v: string): string {
	const host = new URL(t.url).hostname.replace(/^www\./, "");
	return `let ${v}_t;
for (let i = 0; i < 60 && !${v}_t; i++) { const ${v}_n = (await listBrowserTabs()).filter(x => String(x.windowId) === ${q(t.windowId)} && !${JSON.stringify(t.before)}.includes(x.targetId ?? x.id) && /^https?:/.test(x.url)); ${v}_t = ${v}_n.find(x => x.url.includes(${q(host)})) ?? (i >= 10 ? ${v}_n[0] : undefined); if (!${v}_t) await sleep(500); }
if (!${v}_t) throw new Error('automation tab did not appear in window ${t.windowId}');
const ${v} = await attachBrowserTab(${v}_t.targetId ?? ${v}_t.id);
await ${v}.waitForLoadState('domcontentloaded').catch(() => {});`;
}

// Closes one tab (AppleScript id) of the automation window; no-op when it is already gone. Never the anchor tab.
export async function closeTab(windowId: string, tabId: string): Promise<void> {
	if ((await osa('tell application "System Events" to exists process "Aside"')) !== "true") return; // never relaunch Aside just to close a tab
	await osa(`tell application "Aside"
  if not (exists window id ${q(windowId)}) then return
  set w to window id ${q(windowId)}
  repeat with i from (count of tabs of w) to 1 by -1
    if (id of tab i of w as text) is ${q(tabId)} and URL of tab i of w is not ${q(ANCHOR)} then close tab i of w
  end repeat
  if (count of tabs of w) is 0 then return
  if minimized of w is false then set minimized of w to true
end tell`);
}

// A secret file under <data dir>/secrets, read at run time. The value is never logged and never placed in argv.
export function readSecret(name: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("secret name must be [A-Za-z0-9._-]");
	const file = join(DATA_DIR, "secrets", name);
	if (!existsSync(file)) throw new Error(`secret ${name} not found in ${join(DATA_DIR, "secrets")}`);
	return readFileSync(file, "utf8").trim();
}

// Serves `value` once from a random-token localhost URL so a secret never appears in repl code or argv. stop() when done.
export function oneShotSecret(value: string): { url: string; stop: () => void } {
	const token = crypto.randomUUID();
	let served = false;
	const srv = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: req => {
			if (served || new URL(req.url).pathname !== `/${token}`) return new Response("", { status: 404 });
			served = true;
			return new Response(value);
		},
	});
	return { url: `http://127.0.0.1:${srv.port}/${token}`, stop: () => void srv.stop(true) };
}

export type ReplOpts = { timeoutMs?: number; secret?: string };
// Runs `body` (an async function body; `return` gives the result) in `aside repl`. With `url`, a tab is opened in the
// automation window first, bound to `pg`, and closed afterwards whatever happens. With `secret` (a file name under
// <data dir>/secrets), the body sees `const secret`, fetched once from a localhost URL and never written into the code.
export async function replInTab(url: string | null, body: string, o: ReplOpts = {}): Promise<unknown> {
	const tab = url ? await openInAutomationWindow(url) : null;
	const sec = o.secret ? oneShotSecret(readSecret(o.secret)) : null;
	try {
		const code = `try { const dzOut = await (async () => {
${sec ? `const secret = await (await fetch(${JSON.stringify(sec.url)})).text();` : ""}
${tab ? attachCode(tab, "pg") : ""}
${body}
})(); console.log("RESULT " + JSON.stringify({ data: dzOut ?? null })); } catch (e) { console.log("RESULT " + JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) })); }`;
		const r = await runCmd([ASIDE, "repl", code], o.timeoutMs ?? 118_000);
		const m = [...r.out.matchAll(/^.*?RESULT (\{.*\})\s*$/gm)].at(-1);
		if (!m) throw new Error(`aside repl${r.timedOut ? " timed out" : " failed"}: ${(r.out + r.err).replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").slice(-200)}`);
		const j = JSON.parse(m[1]);
		if (j.error) throw new Error(j.error);
		return j.data;
	} finally {
		sec?.stop();
		if (tab) await tab.close().catch(() => {});
	}
}
