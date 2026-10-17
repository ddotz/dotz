// Monitoring without waking the model (as 오모냥's watchers and session-keeper): the gateway runs a check command on an
// interval and only reports when something happened. Failure policy from session-keeper: 2 consecutive failures -> one
// alert per watch per 12h, and one recovery note when it passes again.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { blockedBy } from "../extension/index.ts";
import { log, now, paths } from "./config.ts";

export type Watch = {
	id: string;
	name: string;
	command: string;
	cwd?: string;
	every_minutes: number;
	on: "change" | "match" | "fail";
	pattern?: string;
	session?: { url: string; expect?: string; refresh_hours: number; host?: string; profile?: string };
	channels?: string[];
	to: string;
	created: string;
	state: { hash?: string; fails: number; failAlertAt?: number; lastRun?: string; lastOk?: string; refreshedAt?: number };
};

const RUN_TIMEOUT_MS = 120_000;
const FAIL_ALERT_EVERY_MS = 12 * 3600_000;
const items: Watch[] = existsSync(paths.watches) ? JSON.parse(readFileSync(paths.watches, "utf8")) : [];
const timers = new Map<string, ReturnType<typeof setInterval>>();
const running = new Set<string>();
const save = () => writeFileSync(paths.watches, `${JSON.stringify(items, null, 2)}\n`);
let notify: (w: Watch, reason: string, output: string) => void = () => {};

async function exec(argv: string[], cwd?: string): Promise<{ code: number; output: string }> {
	const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	const kill = setTimeout(() => proc.kill("SIGKILL"), RUN_TIMEOUT_MS);
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(kill);
	return { code, output: `${stdout}${stderr ? `\n${stderr}` : ""}`.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-1500) };
}

// Login keeping in the owner's Aside browser, no model calls. A REPL fetch sends the stored cookies (enough to check
// the login and to extend server-side sliding sessions) but does not store Set-Cookie (measured 2026-10-16), so every
// refresh_hours a real tab load renews rotating cookies, only while Aside is not the front app (the owner is not
// looking at it); the tab is closed again and focus stays where it was (measured).
async function sessionRun(w: Watch): Promise<{ code: number; output: string }> {
	const s = w.session!;
	const check = `const dz = await fetch(${JSON.stringify(s.url)}, { redirect: 'manual' }); const dzBody = dz.status === 200 ? await dz.text() : ''; const dzOk = dz.status === 200 && ${s.expect ? `new RegExp(${JSON.stringify(s.expect)}, 'i').test(dzBody)` : "true"}; console.log(dzOk ? 'DOTZ_SESSION_OK' : 'DOTZ_SESSION_LOST', dz.status, dz.headers.get('location') ?? '');`;
	const where = [...(s.host ? ["--host", s.host] : []), ...(s.profile ? ["--profile", s.profile] : [])];
	const r = await exec(["aside", "repl", ...where, check]);
	if (!r.output.includes("DOTZ_SESSION_OK")) return { code: 1, output: r.output.includes("DOTZ_SESSION_LOST") ? `logged out: ${r.output.match(/DOTZ_SESSION_LOST.*/)?.[0]}` : `check could not run (is Aside running?): ${r.output.slice(-400)}` };
	const due = !w.state.refreshedAt || Date.now() - w.state.refreshedAt > s.refresh_hours * 3600_000;
	if (due) {
		const front = s.host && s.host !== "local" ? { code: 0, output: "remote host" } : await exec(["osascript", "-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
		if (front.code === 0 && front.output !== "Aside") {
			const t = await exec(["aside", "repl", ...where, `const dzTab = await openTab(${JSON.stringify(s.url)}); await closeTab(dzTab); console.log('DOTZ_REFRESHED');`]);
			if (t.output.includes("DOTZ_REFRESHED")) {
				w.state.refreshedAt = Date.now();
				log(`watch ${w.name} refreshed cookies with a tab load`);
			} else log(`watch ${w.name} tab refresh failed: ${t.output.slice(-300)}`);
		} else log(`watch ${w.name} tab refresh postponed (front app: ${front.code === 0 ? front.output : `unknown, ${front.output.slice(-200)}`})`);
	}
	return { code: 0, output: "logged in" };
}

let asideQueue: Promise<unknown> = Promise.resolve();
function serialSessionRun(w: Watch): Promise<{ code: number; output: string }> {
	const next = asideQueue.then(() => sessionRun(w));
	asideQueue = next.catch(() => undefined);
	return next;
}

async function run(w: Watch): Promise<void> {
	if (running.has(w.id)) return;
	running.add(w.id);
	try {
		const { code, output } = w.session ? await serialSessionRun(w) : await exec(["/bin/zsh", "-lc", w.command], w.cwd);
		w.state.lastRun = now();
		if (code !== 0) {
			w.state.fails++;
			log(`watch ${w.name} failed (${code}, ${w.state.fails} in a row)`);
			const due = !w.state.failAlertAt || Date.now() - w.state.failAlertAt > FAIL_ALERT_EVERY_MS;
			if (w.state.fails >= 2 && due) {
				w.state.failAlertAt = Date.now();
				notify(w, `failed ${w.state.fails} times in a row (exit ${code})`, output);
			}
			return;
		}
		if (w.state.failAlertAt) notify(w, "recovered", output);
		w.state.fails = 0;
		w.state.failAlertAt = undefined;
		w.state.lastOk = now();
		const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);
		const changed = w.state.hash !== undefined && hash !== w.state.hash;
		w.state.hash = hash;
		if (w.on === "change" && changed) notify(w, "output changed", output);
		if (w.on === "match" && changed && new RegExp(w.pattern!, "i").test(output)) notify(w, `matched /${w.pattern}/`, output);
	} catch (error) {
		log(`watch ${w.name} could not run: ${error}`);
	} finally {
		running.delete(w.id);
		save();
	}
}

function arm(w: Watch): void {
	clearInterval(timers.get(w.id));
	timers.set(w.id, setInterval(() => void run(w), w.every_minutes * 60_000));
}

export function startWatches(handler: typeof notify): void {
	notify = handler;
	for (const w of items) arm(w);
}

export function addWatch(input: Record<string, any>, rulesText: string): Watch {
	const name = String(input.name ?? "").trim();
	if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("name must be [a-z0-9-], up to 40 chars");
	const url = input.session_url ? String(input.session_url) : "";
	if (url && !/^https:\/\//.test(url)) throw new Error("session_url must be https://");
	if (url && input.expect) new RegExp(String(input.expect));
	const session = url ? { url, ...(input.expect ? { expect: String(input.expect) } : {}), refresh_hours: Math.max(1, Number(input.refresh_hours ?? 6)), ...(input.host ? { host: String(input.host) } : {}), ...(input.profile ? { profile: String(input.profile) } : {}) } : undefined;
	const command = session ? `session check ${url}` : String(input.command ?? "").trim();
	if (!command) throw new Error("command or session_url required");
	if (session) {
		input.on = "fail";
		input.every_minutes ??= 30;
	}
	const blocked = blockedBy(command, rulesText);
	if (blocked) throw new Error(`blocked by the owner's rule: ${blocked}`);
	const every = Number(input.every_minutes ?? 10);
	if (!(every >= 1)) throw new Error("every_minutes must be at least 1");
	const on = input.on === "match" || input.on === "fail" ? input.on : "change";
	if (on === "match") new RegExp(String(input.pattern ?? ""));
	if (on === "match" && !input.pattern) throw new Error("on=match needs pattern");
	const old = items.findIndex(w => w.name === name);
	if (old >= 0) removeWatch(items[old].id);
	const w: Watch = { id: randomBytes(3).toString("hex"), name, command, ...(input.cwd ? { cwd: String(input.cwd) } : {}), every_minutes: every, on, ...(on === "match" ? { pattern: String(input.pattern) } : {}), ...(session ? { session } : {}), ...(Array.isArray(input.channels) && input.channels.length ? { channels: input.channels.map(String) } : {}), to: String(input.to ?? "orchestrator"), created: now(), state: { fails: 0 } };
	items.push(w);
	save();
	arm(w);
	void run(w);
	return w;
}

export function removeWatch(idOrName: string): boolean {
	const i = items.findIndex(w => w.id === idOrName || w.name === idOrName);
	if (i < 0) return false;
	clearInterval(timers.get(items[i].id));
	timers.delete(items[i].id);
	items.splice(i, 1);
	save();
	return true;
}

export const allWatches = () => [...items];

export function setWatchChannels(id: string, channels: string[]): void {
	const w = items.find(x => x.id === id);
	if (!w) return;
	w.channels = channels;
	save();
}

export const listWatches = () => items.map(({ state, ...w }) => ({ ...w, fails: state.fails, lastRun: state.lastRun, lastOk: state.lastOk }));
