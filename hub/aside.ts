// Gateway browser jobs go through `aside repl` only (our own code drives tabs/DOM, no Aside agent quota); `aside exec` is
// never used on an automatic path. No AppleScript window control and no direct CDP. The owner works in Aside themself, so nothing here activates Aside or
// selects one of his tabs: `openTab()` in `aside repl` adds a background tab (the window's active tab and the front app
// stay as they were, measured 2026-10-19) and every tab we open is closed in the same repl run. A stopped Aside is started
// hidden in the background (`open -g -j`), never brought to the front.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asideReason } from "./aside-errors.ts";
import { DATA_DIR } from "./config.ts";

const ASIDE = Bun.which("aside") ?? "aside";
const START_WAIT_MS = 20_000;

// Spawn with a hard kill: a hung `aside repl` must never stall the gateway.
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

// Makes sure the local Aside answers `aside repl`. When the app is not running it is launched in the background and
// hidden (`open -g -j`: no activation, no window shown), then the repl is polled until it answers or 20 s pass. A running
// Aside with no browser window cannot serve `aside repl`, and no CLI path opens one without bringing Aside to the front
// (`open -g -a Aside <url>` activated it, measured 2026-10-19), so that case fails at once instead of waiting.
export async function ensureAside(): Promise<void> {
	const started = Bun.spawnSync(["pgrep", "-x", "Aside"]).exitCode !== 0;
	if (started) {
		const r = Bun.spawnSync(["open", "-g", "-j", "-a", "Aside"]);
		if (r.exitCode !== 0) throw new Error(`could not start Aside: ${r.stderr.toString().trim().slice(0, 200)}`);
	}
	const deadline = Date.now() + START_WAIT_MS;
	let last = "";
	while (Date.now() < deadline) {
		const r = await runCmd([ASIDE, "repl", "console.log('DZ_ASIDE_UP')"], 10_000);
		if (r.out.includes("DZ_ASIDE_UP")) return;
		last = (r.out + r.err).replace(/\x1b\[[0-9;]*m/g, "").trim();
		if (!started && last.includes("No browser window is open"))
			throw new Error("Aside is running with no browser window open; aside repl needs one (not opened here: that would bring Aside to the front)");
		await Bun.sleep(1000);
	}
	throw new Error(`Aside did not answer aside repl within ${START_WAIT_MS / 1000}s: ${asideReason(last)}`);
}

// A secret file under <data dir>/secrets, read at run time. The value is never logged and never placed in argv.
function readSecret(name: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("secret name must be [A-Za-z0-9._-]");
	const file = join(DATA_DIR, "secrets", name);
	if (!existsSync(file)) throw new Error(`secret ${name} not found in ${join(DATA_DIR, "secrets")}`);
	return readFileSync(file, "utf8").trim();
}

// Serves `value` once from a random-token localhost URL so a secret never appears in repl code or argv. stop() when done.
function oneShotSecret(value: string): { url: string; stop: () => void } {
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

type ReplOpts = { timeoutMs?: number; secret?: string };
// Runs `body` (an async function body; `return` gives the result) in `aside repl`, starting Aside in the background
// first if needed. With `url`, the body sees `pg`: a background tab opened with `openTab()` and closed in the same run
// whatever happens. With `secret` (a file name under <data dir>/secrets), the body sees `const secret`, fetched once from a
// localhost URL and never written into the code.
export async function replInTab(url: string | null, body: string, o: ReplOpts = {}): Promise<unknown> {
	await ensureAside();
	const sec = o.secret ? oneShotSecret(readSecret(o.secret)) : null;
	try {
		const code = `let dzTab = null; try { const dzOut = await (async () => {
${sec ? `const secret = await (await fetch(${JSON.stringify(sec.url)})).text();` : ""}
${url ? `dzTab = await openTab(${JSON.stringify(url)}); const pg = dzTab;` : ""}
${body}
})(); console.log("RESULT " + JSON.stringify({ data: dzOut ?? null })); } catch (e) { console.log("RESULT " + JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) })); } finally { if (dzTab) await closeTab(dzTab).catch(() => {}); }`;
		const r = await runCmd([ASIDE, "repl", code], o.timeoutMs ?? 118_000);
		const m = [...r.out.matchAll(/^.*?RESULT (\{.*\})\s*$/gm)].at(-1);
		if (!m) throw new Error(`aside repl${r.timedOut ? " timed out" : " failed"}: ${asideReason(r.out + r.err)}`);
		const j = JSON.parse(m[1]);
		if (j.error) throw new Error(j.error);
		return j.data;
	} finally {
		sec?.stop();
	}
}
