// Stateless readers of the self-updater (hub/selfupdate.ts): release version parsing and ordering, the update gate command read from the
// folder under test, and the digest of a failing test run's output. No config, no job state, no I/O beyond reading VERSION / update-gate.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---- the nightly install slot: checks run every 10 minutes, but a found release is installed by itself only once a night ----
// The first check inside [at, at + NIGHT_WINDOW_MIN) on the local clock may install; the night it belongs to (the local date the slot
// opened on, so a slot near midnight is one night) is returned so the caller installs once per night. Outside the window, or with
// "off" or an unreadable time, undefined: the release waits (the owner's update button still installs at once).
export const NIGHT_WINDOW_MIN = 60;
export function nightSlot(at: string, now: Date): string | undefined {
	const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
	if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
	const since = (now.getHours() * 60 + now.getMinutes() - Number(m[1]) * 60 - Number(m[2]) + 1440) % 1440;
	if (since >= NIGHT_WINDOW_MIN) return undefined;
	const d = new Date(now.getTime() - since * 60_000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- released versions (docs/releases.md, hub/release.ts): tag v<YYMMDD.N>[.<M>] on main plus VERSION, KST, at most three a day ----
// A new commit on main is not an update any more; only a new release tag is. Ordering is numeric on (date, N, M), so
// 261103.1 < 261103.1.1 < 261103.1.2 < 261103.2 (a third part is the forced/emergency track).
export type Release = { date: string; parts: number[]; text: string };
const RELEASE_TAG = /^v(\d{6})\.([1-3])(?:\.(\d+))?$/;
// "261103.2" (VERSION / stamp), "261103.1.1" (forced) and "v261103.2" (tag / refs/tags/...); anything else is not a release.
export function parseRelease(text: string): Release | undefined {
	const t = text.trim().replace(/^refs\/tags\//, "");
	const m = RELEASE_TAG.exec(t.startsWith("v") ? t : `v${t}`);
	if (!m) return undefined;
	const parts = [Number(m[2]), ...(m[3] === undefined ? [] : [Number(m[3])])];
	return { date: m[1]!, parts, text: `${m[1]}.${parts.join(".")}` };
}
// Numeric: the date first, then N, then the forced part (missing = 0). Unreadable versions sort below everything (a
// never-released install is older than any tag).
export function compareReleases(a: string | undefined, b: string | undefined): number {
	const x = a ? parseRelease(a) : undefined;
	const y = b ? parseRelease(b) : undefined;
	if (!x || !y) return x ? 1 : y ? -1 : 0;
	const date = Number(x.date) - Number(y.date);
	if (date) return date;
	for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
		const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

// The release tags of `git ls-remote --tags` output, newest first. Annotated tags carry a peeled "^{}" line, whose sha is the commit.
export function releaseTags(lsRemote: string): { tag: string; version: string; sha: string }[] {
	const byTag = new Map<string, { tag: string; version: string; sha: string; peeled?: string }>();
	for (const line of lsRemote.split("\n")) {
		const m = /^(\S+)\s+refs\/tags\/(\S+)$/.exec(line.trim());
		if (!m) continue;
		const sha = m[1]!, ref = m[2]!;
		const peeled = ref.endsWith("^{}");
		const tag = peeled ? ref.slice(0, -3) : ref;
		const version = parseRelease(tag);
		if (!version) continue;
		const entry = byTag.get(tag) ?? { tag, version: version.text, sha };
		if (peeled) entry.peeled = sha;
		byTag.set(tag, entry);
	}
	return [...byTag.values()]
		.map(e => ({ tag: e.tag, version: e.version, sha: e.peeled ?? e.sha }))
		.sort((a, b) => compareReleases(b.version, a.version));
}

// The release version on disk: VERSION at the install root, or an old tarball stamp's `version` (absent before versioned releases).
export function diskRelease(dir: string): string | undefined {
	try {
		return parseRelease(readFileSync(join(dir, "VERSION"), "utf8"))?.text;
	} catch {
		return undefined;
	}
}

// The update gate runs every test file in a fresh global (--isolate). In one shared global, what earlier files leave behind
// (WebViews, servers, timers) piles up until the later Bun.WebView tests time out one after another, and the whole run passes the
// 20-minute limit below (exit 143) on a slower or busy Mac, so the update never lands. Each file alone passes either way.
export const TEST_CMD = ["bun", "test", "--isolate"];
export const GATE_MINUTES = 20;

// The gate is read from the version being installed (hub/update-gate.json in the folder under test), not from this running file.
// The updater that runs is always the OLD one, so a gate fix shipped as a code constant would only take effect one update later,
// and never if the old gate keeps failing (that is how the --isolate fix got stuck behind exit 143). Missing or bad file: the
// constants above (the running version's own gate, never "no gate"). An explicit testCmd (tests, --test-cmd) still wins; the time limit comes from the new folder either way.
export const GATE_FILE = join("hub", "update-gate.json");
export function gateIn(cwd: string, testCmd?: string[]): { cmd: string[]; ms: number } {
	let g: { cmd?: unknown; timeoutMinutes?: unknown } = {};
	try {
		g = JSON.parse(readFileSync(join(cwd, GATE_FILE), "utf8"));
	} catch {
		// no gate file (an older version, or a test tree): fall back below
	}
	// The file may only choose the arguments of `bun test` and a limit of at most 60 minutes: a gate that is `true` or never ends is no gate.
	const fileCmd = Array.isArray(g?.cmd) && g.cmd.length >= 2 && g.cmd.every(x => typeof x === "string" && x) && g.cmd[0] === "bun" && g.cmd[1] === "test" ? (g.cmd as string[]) : undefined;
	const min = typeof g?.timeoutMinutes === "number" && g.timeoutMinutes > 0 && g.timeoutMinutes <= 60 ? g.timeoutMinutes : GATE_MINUTES;
	return { cmd: testCmd ?? fileCmd ?? TEST_CMD, ms: min * 60_000 };
}

// bun prints a failing test's error block (source excerpt, `error:`/expect lines, stack) right before its `(fail) name` line, after the
// previous `(pass)`/`(fail)` line or the file header. Keeps each block, capped per block, per run and in count, so the assertion survives the tail cut.
const FAIL_BLOCK_LINES = 40, FAIL_BLOCK_CHARS = 3000, FAIL_BLOCKS = 15, FAIL_TOTAL_CHARS = 20_000;
export function failureBlocks(out: string): string {
	const lines = out.split("\n");
	const blocks: string[] = [];
	let start = 0, total = 0, failed = 0;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		if (/^\((pass|skip|todo)\) /.test(l) || /^\S+\.test\.[cm]?[jt]sx?:\s*$/.test(l)) { start = i + 1; continue; }
		if (!/^\(fail\) /.test(l)) continue;
		failed++;
		const body = lines.slice(start, i).join("\n").trim().split("\n");
		start = i + 1;
		if (blocks.length >= FAIL_BLOCKS || total >= FAIL_TOTAL_CHARS) continue;
		let text = body.slice(-FAIL_BLOCK_LINES).join("\n");
		if (text.length > FAIL_BLOCK_CHARS) text = text.slice(-FAIL_BLOCK_CHARS);
		text = `${text}\n${l}`.trim();
		total += text.length;
		blocks.push(text);
	}
	if (!blocks.length) return "";
	return `${blocks.join("\n--\n")}${failed > blocks.length ? `\n… ${failed - blocks.length} more failure(s) not kept` : ""}`;
}

// bun's closing counts ("12 pass", "0 fail"): the update log keeps them; owner-facing text never carries them (owner 2026-11-01:
// "1pass 이거 뜨는거 불필요"). A failure names the failing tests, or the exit code when bun named none.
export const testSummary = (out: string): string =>
	out.split("\n").filter(l => /^\s*\d+ (pass|fail)\b/.test(l)).map(l => l.trim()).join(", ");
export const testFailure = (code: number, names: string[]): string => `테스트 실패${names.length ? `: ${names.join(" / ")}` : ` (exit ${code})`}`;

// The names of the failing tests (at most `max`, once each: bun prints every `(fail)` line again in its closing summary), for the
// owner-facing message; the counts alone do not say what broke.
export function failedTestNames(out: string, max = 3): string[] {
	const names: string[] = [];
	for (const l of out.split("\n")) {
		const m = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(l);
		const name = m?.[1]?.trim();
		if (name && !names.includes(name)) names.push(name.length > 90 ? `${name.slice(0, 89)}…` : name);
		if (names.length >= max) break;
	}
	return names;
}
