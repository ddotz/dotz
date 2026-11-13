// Versioned delivery (docs/releases.md): tag v<YYMMDD.N> scheduled or v<YYMMDD.N.M> forced on main plus VERSION, KST day.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "../firstrun/atomic.ts"; // not hub/config.ts: it needs a data dir at load, and CI has none
import { ownerAddress, releaseTerms, scrub, type Term } from "./public-scrub.ts";
import { clearGate, gateStatus, realGateEnv, runGate, runSuiteIn, saveRedEvidence, startGate, type GateEnv } from "./release-gate.ts";
import { SLOT_SKIPPED_EXIT } from "./release-exit.ts";
import { buildReleaseNote, NOTE_LOG_FORMAT, parseNoteCommits } from "./release-note.ts";
import { keyMissing, pushAuthArgs, RELEASE_IDENTITY, signingKeyPath, signMode, signTag, verifyOwnTag, type SignMode } from "./release-sign.ts";

export type Release = { readonly date: string; readonly n: number; readonly hotfix: number | null; readonly text: string };

export type Plan =
	| { ok: true; version: Release; previous: Release | null }
	| { ok: false; code: "limit" | "future"; reason: string };

export type ForcedPlan =
	| { ok: true; version: Release; previous: Release }
	| { ok: false; code: "no-base"; reason: string };

const MAX_PER_DAY = 3;
const KST = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 24 * 3600_000;
const SLOT_HOURS = [18, 12, 0];
const RELEASE_REPO = "ddotz/dotz";
const RELEASE_OWNER = "ddotz";
const NOTE_LOG_LIMIT = 500;
const GITHUB_REPO = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/;
export const TAG_RE = /^v(\d{2})(\d{2})(\d{2})\.([1-3])(?:\.(\d+))?$/;

function kstParts(now: Date): { y: number; m: number; d: number } {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
	const get = (type: "year" | "month" | "day") => Number(parts.find(p => p.type === type)?.value ?? NaN);
	return { y: get("year"), m: get("month"), d: get("day") };
}

export function todayKst(now: Date = new Date()): string {
	const { y, m, d } = kstParts(now);
	if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) throw new Error("KST 날짜를 계산하지 못했어요.");
	return `${String(y % 100).padStart(2, "0")}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

// The start of the release slot `now` is in: the latest 00:00, 12:00 or 18:00 KST (the 24:00 cut is the next day's 00:00).
export function slotStart(now: Date): Date {
	const kst = now.getTime() + KST_OFFSET_MS;
	const day = Math.floor(kst / DAY_MS) * DAY_MS;
	const hour = SLOT_HOURS.find(h => kst >= day + h * 3600_000)!;
	return new Date(day + hour * 3600_000 - KST_OFFSET_MS);
}

export function shiftDay(date: string, delta: number): string {
	const y = 2000 + Number(date.slice(0, 2));
	const m = Number(date.slice(2, 4));
	const d = Number(date.slice(4, 6));
	const t = new Date(Date.UTC(y, m - 1, d + delta));
	return `${String(t.getUTCFullYear() % 100).padStart(2, "0")}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function parseVersion(text: string): Release | null {
	const trimmed = text.trim();
	const m = TAG_RE.exec(trimmed.startsWith("v") ? trimmed : `v${trimmed}`);
	if (!m) return null;
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const date = `${m[1]}${m[2]}${m[3]}`;
	const n = Number(m[4]);
	const hotfix = m[5] === undefined ? null : Number(m[5]);
	if (hotfix !== null && hotfix < 1) return null;
	return { date, n, hotfix, text: `${date}.${n}${hotfix === null ? "" : `.${hotfix}`}` };
}

export function compareVersions(a: Release, b: Release): number {
	const date = Number(a.date) - Number(b.date);
	if (date !== 0) return date;
	if (a.n !== b.n) return a.n - b.n;
	return (a.hotfix ?? 0) - (b.hotfix ?? 0);
}

export function newestVersion(tags: readonly string[]): Release | null {
	let newest: Release | null = null;
	for (const tag of tags) {
		const v = parseVersion(tag);
		if (v && (!newest || compareVersions(v, newest) > 0)) newest = v;
	}
	return newest;
}

export function planNext(tags: readonly string[], today: string): Plan {
	const versions = tags.map(parseVersion).filter((v): v is Release => v !== null);
	const newest = newestVersion(tags);
	if (newest && newest.date > today) {
		return { ok: false, code: "future", reason: `${newest.text} 태그가 오늘(${today})보다 뒤 날짜예요. 태그나 기기 시계를 확인해 주세요.` };
	}
	const todayNs = new Set(versions.filter(v => v.date === today && v.hotfix === null).map(v => v.n));
	if (todayNs.size >= MAX_PER_DAY || Math.max(0, ...todayNs) >= MAX_PER_DAY) {
		return {
			ok: false,
			code: "limit",
			reason: `오늘(${today})은 세 번을 이미 냈어요 (${[...todayNs].sort((a, b) => a - b).map(n => `${today}.${n}`).join(", ")}). 하루에 세 번까지만 내요. 다음 버전은 내일 ${shiftDay(today, 1)}.1이에요.`,
		};
	}
	let n = todayNs.size + 1;
	if (todayNs.has(n)) n = [1, 2, 3].find(candidate => !todayNs.has(candidate))!;
	return { ok: true, version: { date: today, n, hotfix: null, text: `${today}.${n}` }, previous: newest };
}

export function planForcedNext(tags: readonly string[]): ForcedPlan {
	const newest = newestVersion(tags);
	if (!newest) {
		return { ok: false, code: "no-base", reason: "강제 릴리스는 마지막 정기 버전에 .M으로 붙어요. 먼저 정기 버전을 하나 내주세요." };
	}
	const hotfix = (newest.hotfix ?? 0) + 1;
	return {
		ok: true,
		version: { date: newest.date, n: newest.n, hotfix, text: `${newest.date}.${newest.n}.${hotfix}` },
		previous: newest,
	};
}

export function summarizeChanges(oneline: readonly string[], previous: Release | null): string {
	const subjects = oneline
		.map(line => line.replace(/^[0-9a-f]{7,40}\s+/, "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const head = previous
		? `바뀐 것 ${subjects.length}건`
		: `버전 배포를 시작해요 (이전 태그 없음). 바뀐 것 ${subjects.length}건`;
	const shown = subjects.slice(0, 3).map(s => (s.length > 48 ? `${s.slice(0, 47)}…` : s));
	const more = subjects.length > shown.length ? ` 외 ${subjects.length - shown.length}건` : "";
	return shown.length ? `${head}: ${shown.join(" · ")}${more}` : head;
}

export async function gitOutput(args: readonly string[], cwd: string): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["git", "--no-pager", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, out: `${out}${err}`.trim() };
}

export async function localTags(root: string): Promise<string[]> {
	const r = await gitOutput(["tag", "--list", "v*"], root);
	if (r.code !== 0) throw new Error(`태그를 읽지 못했어요: ${r.out}`);
	return r.out.split("\n").map(s => s.trim()).filter(t => TAG_RE.test(t));
}

export async function dirtyTracked(root: string): Promise<string[]> {
	const r = await gitOutput(["status", "--porcelain", "--untracked-files=no"], root);
	if (r.code !== 0) throw new Error(`저장소 상태를 읽지 못했어요: ${r.out}`);
	return r.out.split("\n").map(s => s.trim()).filter(Boolean);
}

export async function hasCommitsSince(root: string, since: string | null, ref = "HEAD"): Promise<boolean> {
	if (!since) return true;
	const r = await gitOutput(["rev-list", "--count", `${since}..${ref}`], root);
	if (r.code !== 0) throw new Error(`커밋을 세지 못했어요: ${r.out}`);
	return Number(r.out) > 0;
}

// The one rule for "is there anything to release": a commit on `ref` after the newest release tag (no tag at all counts as yes). --auto and the
// release gate both ask here, so the gate never runs the suite for a slot that --auto would answer with "nothing to release".
export async function newCommitsSinceNewestTag(root: string, ref = "HEAD"): Promise<{ newest: Release | null; any: boolean; tags: string[] }> {
	const tags = await localTags(root);
	const newest = newestVersion(tags);
	return { newest, any: await hasCommitsSince(root, newest ? `v${newest.text}` : null, ref), tags };
}

// The scheduled release already cut in the slot of `now`, if any. A forced .M does not take a slot. The tag's commit time is the
// only state both triggers share, so a GitHub cron run hours late sees what the dispatched run did.
export async function cutInSlot(root: string, tags: readonly string[], now: Date): Promise<Release | null> {
	const newest = newestVersion(tags.filter(t => parseVersion(t)?.hotfix === null));
	if (!newest) return null;
	const r = await gitOutput(["log", "-1", "--format=%ct", `v${newest.text}`], root);
	if (r.code !== 0) throw new Error(`태그 시각을 읽지 못했어요: ${r.out}`);
	return Number(r.out) * 1000 >= slotStart(now).getTime() ? newest : null;
}

export type PublishOptions = {
	auto: boolean;
	force: boolean;
	dryRun: boolean;
	cwd: string;
	sha?: string; // the commit the suite was green on (--sha): the checkout must be at it, and the release is that commit plus VERSION
	now?: Date;
	print?: (line: string) => void;
	exec?: Exec;
	terms?: readonly Term[];
	address?: string; // how the owner is addressed; this install's config when not given
	buildDemo?: Exec; // rebuilds site/demo from web/ before the release commit, then runs the demo's check (cmd says which); `bun site/build-demo.ts` and `bun test ./site/demo-update.test.ts` in the checkout when not given
	signingKey?: string; // the release signing key file; $DOTZ_DIR/secrets/release-signing-key when not given
	ci?: boolean; // running on a GitHub runner (the one unsigned transition release); GITHUB_ACTIONS when not given
};

const SIGN_LINES: Record<SignMode, (key: string) => string> = {
	sign: key => `서명 키: ${key}`,
	transition: key => `서명 키가 없고(${key}) 서명된 릴리스도 아직 없어서, 이번이 서명 없이 내는 마지막 전환 릴리스예요.`,
	"no-key": key => `서명 키가 없어서 버전을 내지 않았어요 (${key}). 키가 있는 기기에서 실행해 주세요.`,
	"ci-refused": key => `서명된 릴리스가 이미 있는데 서명 키가 없어서(${key}) 이 러너에서는 버전을 내지 않아요.`,
};

async function releaseNote(root: string, tag: string, base: string | null, rev: string, terms: readonly Term[], address: string): Promise<string> {
	const log = await gitOutput(["log", "--no-merges", "--name-only", `--max-count=${NOTE_LOG_LIMIT}`, `--format=${NOTE_LOG_FORMAT}`, base ? `${base}..${rev}` : rev], root);
	if (log.code !== 0) throw new Error(`릴리스 노트용 커밋을 읽지 못했어요: ${log.out}`);
	return buildReleaseNote({ tag, commits: parseNoteCommits(log.out), terms, address });
}

// A GitHub Release per tag, with the note as its body. The tag is already out, so a failure here reports and leaves the note in the log.
async function publishNote(root: string, tag: string, note: string, exec: Exec, print: (line: string) => void): Promise<boolean> {
	const repo = GITHUB_REPO.exec((await gitOutput(["remote", "get-url", "origin"], root)).out)?.[1];
	if (!repo) {
		print("origin이 GitHub가 아니라서 릴리스 노트는 올리지 않았어요.");
		return true;
	}
	const dir = mkdtempSync(join(tmpdir(), "dotz-release-note-"));
	try {
		const file = join(dir, "note.md");
		writeAtomic(file, note);
		const made = await exec(["gh", "release", "create", tag, "--repo", repo, "--title", tag, "--verify-tag", "--notes-file", file]).catch((e: unknown) => ({ code: 1, out: String(e) }));
		if (made.code === 0) {
			print(`릴리스 노트: ${made.out}`);
			return true;
		}
		print(`태그는 나갔지만 릴리스 노트를 올리지 못했어요: ${made.out}`);
		print(note);
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// A pinned release is the tested commit plus VERSION, tagged before this push. When main moved on while the suite ran, main is merged in
// after the tag: the tag stays an ancestor of main (the updater moves forward only) and no untested commit is in it.
async function pushPinned(root: string, auth: readonly string[]): Promise<{ code: number; out: string }> {
	const pushed = await gitOutput([...auth, "push", "origin", "HEAD:main"], root);
	if (pushed.code === 0) return pushed;
	const fetched = await gitOutput(["fetch", "--quiet", "origin", "main"], root);
	if (fetched.code !== 0) return fetched;
	const merged = await gitOutput([...RELEASE_IDENTITY, "merge", "--no-edit", "origin/main"], root);
	if (merged.code !== 0) {
		await gitOutput(["merge", "--abort"], root);
		return merged;
	}
	return gitOutput([...auth, "push", "origin", "HEAD:main"], root);
}

// The public demo is a build of web/, so the release commit carries a fresh one. A build that fails is logged and the release goes out with the
// demo as it was: whatever the failed build left in site/ is put back. Returns whether the site/ changes should join the release commit.
// The release gate ran the suite before this build, so the built demo is checked here: one that does not load (its own headless test) counts as failed.
async function rebuildDemo(root: string, build: Exec | undefined, print: (line: string) => void): Promise<boolean> {
	if (!build && !existsSync(join(root, "site", "build-demo.ts"))) return false;
	const untracked = async () => new Set((await gitOutput(["ls-files", "--others", "--exclude-standard", "--", "site"], root)).out.split("\n").filter(Boolean));
	const before = await untracked();
	const exec = build ?? ((cmd: readonly string[]) => run(cmd, root));
	const step = (cmd: readonly string[]) => exec(cmd).catch((e: unknown) => ({ code: 1, out: String(e) }));
	let made = await step(["bun", "site/build-demo.ts"]);
	if (made.code === 0) made = await step(["bun", "test", "./site/demo-update.test.ts"]);
	if (made.code === 0) {
		print("데모: web/로 site/demo를 다시 만들었어요");
		return true;
	}
	print(`데모를 다시 만들지 못해서 이번 릴리스는 데모 갱신 없이 내요: ${made.out.slice(-500)}`);
	await gitOutput(["checkout", "--", "site"], root);
	for (const file of await untracked()) if (!before.has(file)) rmSync(join(root, file), { force: true });
	return false;
}

export async function publishVersion(opts: PublishOptions): Promise<number> {
	const print = opts.print ?? ((line: string) => console.log(line));
	const now = opts.now ?? new Date();

	const rootRes = await gitOutput(["rev-parse", "--show-toplevel"], opts.cwd);
	if (rootRes.code !== 0) {
		print("여기는 git 저장소가 아니에요. dotz 저장소 안에서 실행해 주세요.");
		return 1;
	}
	const root = rootRes.out;

	const fetched = await gitOutput(["fetch", "--tags", "--quiet", "origin"], root);
	if (fetched.code !== 0) print(`원격 태그를 못 가져왔어요 (${fetched.out}). 로컬 태그로 계산할게요.`);

	if (opts.sha) {
		const head = await gitOutput(["rev-parse", "HEAD"], root);
		if (head.out !== opts.sha) {
			print(`체크아웃이 테스트를 통과한 커밋(${opts.sha.slice(0, 8)})이 아니라서 버전을 내지 않았어요 (${head.out.slice(0, 8)}).`);
			return 1;
		}
	}

	if (opts.auto) {
		const { newest, any, tags: newTags } = await newCommitsSinceNewestTag(root);
		if (!any) {
			print(`새 커밋이 없어서 버전을 내지 않았어요 (최신 ${newest ? `v${newest.text}` : "태그 없음"}).`);
			return 0;
		}
		const cut = await cutInSlot(root, newTags, now);
		if (cut) {
			print(`이 시간대는 이미 v${cut.text}로 냈어요. 다음 시간대를 기다려요.`);
			return 0;
		}
	}

	const dirty = await dirtyTracked(root);
	const today = todayKst(now);
	const tags = await localTags(root);
	const plan = opts.force ? planForcedNext(tags) : planNext(tags, today);
	if (!plan.ok) {
		print(opts.force ? "강제 릴리스를 낼 수 없어요." : "다음 버전을 낼 수 없어요.");
		print(plan.reason);
		const last = planForcedNext(tags);
		if (opts.dryRun && last.ok) print(await releaseNote(root, "다음 버전", last.previous ? `v${last.previous.text}` : null, "HEAD", opts.terms ?? releaseTerms(), opts.address ?? ownerAddress()));
		return 1;
	}
	const { version, previous } = plan;
	const tag = `v${version.text}`;

	const base = previous ? `v${previous.text}` : null;
	const log = await gitOutput(["log", "--oneline", "--max-count=20", ...(base ? [`${base}..HEAD`] : ["HEAD"])], root);
	const terms = opts.terms ?? releaseTerms();
	const address = opts.address ?? ownerAddress();
	const summary = scrub(summarizeChanges(log.out.split("\n").filter(Boolean), previous), terms).text;

	print(`다음 ${opts.force ? "강제 " : ""}버전: ${tag}${previous ? ` (이전 ${base})` : " (첫 버전)"}`);
	print(`변경 요약: ${summary}`);

	const key = opts.signingKey ?? signingKeyPath(process.env);
	const ci = opts.ci ?? process.env.GITHUB_ACTIONS === "true";
	const mode = await signMode(root, key, ci);
	print(SIGN_LINES[mode](key));
	const refused = mode === "no-key" || mode === "ci-refused";

	if (opts.dryRun) {
		print(await releaseNote(root, tag, base, "HEAD", terms, address));
		print(`[--dry-run] 아무것도 쓰지 않았어요. 실제로 내보내면 VERSION을 ${version.text}로 쓰고, 커밋하고, 서명한 태그 ${tag}까지 origin/main과 함께 푸시한 뒤 위 노트로 GitHub Release를 만들어요.`);
		return refused ? 1 : 0;
	}
	if (refused) return 1;

	if (dirty.length) {
		print("커밋되지 않은 변경이 있어서 버전을 내지 않았어요.");
		for (const line of dirty.slice(0, 10)) print(`  ${line}`);
		if (dirty.length > 10) print(`  … 외 ${dirty.length - 10}개`);
		print("릴리스는 VERSION 하나만 커밋해야 해서, 추적 중인 파일이 바뀐 채로는 내보내지 않아요. 먼저 커밋하거나 되돌려 주세요.");
		return 1;
	}

	const exists = await gitOutput(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], root);
	if (exists.code === 0) {
		print(`태그 ${tag}가 이미 있어요. 다시 실행해서 다음 번호를 계산해 주세요.`);
		return 1;
	}

	const demo = await rebuildDemo(root, opts.buildDemo, print);
	writeFileSync(join(root, "VERSION"), `${version.text}\n`);
	print(`VERSION: ${version.text}`);

	const added = await gitOutput(["add", "VERSION"], root);
	if (added.code !== 0) {
		print(`VERSION을 스테이징하지 못했어요: ${added.out}`);
		return 1;
	}
	const addedDemo = demo ? await gitOutput(["add", "-u", "--", "site"], root) : { code: 0, out: "" };
	if (addedDemo.code !== 0) {
		print(`다시 만든 데모를 스테이징하지 못했어요: ${addedDemo.out}`);
		return 1;
	}
	const committed = await gitOutput([...RELEASE_IDENTITY, "commit", "-m", `release: ${tag}\n\n${summary}`], root);
	if (committed.code !== 0) {
		print(`커밋하지 못했어요: ${committed.out}`);
		print("VERSION 파일만 바뀐 상태로 남아 있어요.");
		return 1;
	}
	const sha = await gitOutput(["rev-parse", "--short", "HEAD"], root);
	print(`커밋: ${sha.out} release: ${tag}`);

	if (!opts.sha && (await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], root)).out === "HEAD") {
		const branch = await gitOutput(["switch", "-C", "main"], root);
		if (branch.code !== 0) {
			print(`main 브랜치로 옮기지 못했어요: ${branch.out}`);
			return 1;
		}
	}
	const pulled = opts.sha ? { code: 0, out: "" } : await gitOutput([...RELEASE_IDENTITY, "pull", "--rebase", "--quiet", "origin", "main"], root);
	if (pulled.code !== 0) {
		await gitOutput(["rebase", "--abort"], root);
		print(`origin/main과 동기화하지 못했어요: ${pulled.out}`);
		print("커밋은 로컬에만 있어요. rebase를 마친 뒤 다시 실행해 주세요.");
		return 1;
	}

	const tagged = mode === "sign" ? await signTag(root, tag, key) : await gitOutput(["tag", tag], root);
	if (tagged.code !== 0) {
		print(`태그 ${tag}를 달지 못했어요: ${tagged.out}`);
		return 1;
	}
	if (mode === "sign") {
		const verified = await verifyOwnTag(root, tag);
		if (verified.code !== 0) {
			await gitOutput(["tag", "-d", tag], root);
			print(`태그 ${tag}의 서명이 저장소의 release-signers로 확인되지 않아서 푸시하지 않았어요: ${verified.out}`);
			print("이 키는 release-signers에 없는 것 같아요. 커밋은 로컬에만 있어요.");
			return 1;
		}
	}
	print(`태그: ${tag}${mode === "sign" ? " (서명 확인됨)" : ""}`);

	const auth = await pushAuthArgs(root, ci);
	const pushedMain = opts.sha ? await pushPinned(root, auth) : await gitOutput([...auth, "push", "origin", "main"], root);
	if (pushedMain.code !== 0) {
		print(`main을 푸시하지 못했어요: ${pushedMain.out}`);
		print("커밋과 태그는 로컬에 남아 있어요. 원격 상태를 확인한 뒤 다시 푸시해 주세요.");
		return 1;
	}
	print("푸시: origin main");

	const pushedTag = await gitOutput([...auth, "push", "origin", tag], root);
	if (pushedTag.code !== 0) {
		print(`태그를 푸시하지 못했어요: ${pushedTag.out}`);
		print("태그는 로컬에 남아 있어요. 원격 상태를 확인한 뒤 다시 푸시해 주세요.");
		return 1;
	}
	print(`푸시: origin ${tag}`);
	print(`내보냈어요: ${tag} (${sha.out})`);
	// After the rebase above: the note covers what the tag really holds, commits that landed during the run included.
	return (await publishNote(root, tag, await releaseNote(root, tag, base, tag, terms, address), opts.exec ?? run, print)) ? 0 : 1;
}

// What the gate runner does when the suite is green: the release of exactly that commit, from the worktree the suite ran in.
async function releaseGreen(dir: string, sha: string): Promise<{ code: number; out: string }> {
	const lines: string[] = [];
	const code = await publishVersion({ auto: true, force: false, dryRun: false, cwd: dir, sha, print: line => lines.push(line) });
	return { code, out: lines.join("\n") };
}

type Exec = (cmd: readonly string[]) => Promise<{ code: number; out: string }>;

async function run(cmd: readonly string[], cwd?: string): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out: `${out}${err}`.trim() };
}

export type DispatchOptions = {
	stateDir: string;
	dryRun?: boolean;
	now?: Date;
	exec?: Exec;
	print?: (line: string) => void;
	gate?: GateEnv; // where the gate clones from and how it runs its detached runner; GitHub and real processes when not given
	signingKey?: string; // the release signing key file; $DOTZ_DIR/secrets/release-signing-key when not given
	hubLog?: (line: string) => void; // appends to hub.log of this install (DOTZ_DIR or ~/.dotz, as hub/config.ts reads it; not imported here) when not given
};

const FLAKY_SHOWN = 5;

function appendHubLog(line: string): void {
	appendFileSync(join(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "hub.log"), `${new Date().toISOString()} ${line}\n`);
}

// What the watch knows of a release that failed: "failed" (with the line to show) for the rest of the slot, so the watch keeps failing and its own
// failure alert reaches the owner. A release that went out is forgotten. "running" is what the GitHub-runner flow wrote; nothing writes it now.
type RunState = { slot: string; startedAt: string; state: "running" | "failed"; message?: string };

// A later tick of the slot reads the failure an earlier tick left. Returns the failure line, if any.
function settleRun(opts: DispatchOptions, slot: string): string | null {
	const file = join(opts.stateDir, "release-run.json");
	if (!existsSync(file)) return null;
	let run_: RunState;
	try {
		run_ = JSON.parse(readFileSync(file, "utf8")) as RunState;
	} catch {
		rmSync(file, { force: true }); // unreadable: nothing to report, the next dispatch writes a fresh one
		return null;
	}
	if (run_.state === "failed") {
		if (run_.slot === slot) return run_.message ?? "릴리스 실행이 실패했어요.";
		rmSync(file, { force: true }); // a new slot: the owner has had the alert, the watch recovers and dispatches again
		return null;
	}
	rmSync(file, { force: true }); // the old flow's "running": no run to wait for any more
	return null;
}

// One tick of the owner's release-slot watch (docs/releases.md): once per slot, the full suite runs on the head of origin/main in a detached
// runner (hub/release-gate.ts; a tick only starts it or reads its state, so it ends in seconds) and, when it is green, the same runner releases that
// commit (signed tag, push, GitHub Release). A red suite skips the slot, and so does a release that failed.
// Runs only for the repo owner's GitHub login, and only where the signing key is, so a copy of the watch on another install releases nothing.
// A failed slot fails the tick (exit 1) until the next slot, which is how the owner hears of it.
export async function dispatchSlot(opts: DispatchOptions): Promise<number> {
	const print = opts.print ?? ((line: string) => console.log(line));
	const exec = opts.exec ?? run;
	const now = opts.now ?? new Date();
	const slot = slotStart(now).toISOString();
	const stateFile = join(opts.stateDir, "release-slot");
	const failure = settleRun(opts, slot);
	if (failure) {
		print(failure);
		return SLOT_SKIPPED_EXIT;
	}
	if (existsSync(stateFile) && readFileSync(stateFile, "utf8").trim() === slot) return 0;

	const login = await exec(["gh", "api", "user", "--jq", ".login"]);
	if (login.code !== 0) {
		print(`GitHub 계정을 확인하지 못했어요: ${login.out}`);
		return 1;
	}
	if (login.out !== RELEASE_OWNER) {
		print(`${RELEASE_OWNER} 계정이 아니라서 릴리스를 시작하지 않아요 (${login.out}).`);
		return 0;
	}
	if (opts.dryRun) {
		print(`[--dry-run] ${slot} 시간대의 테스트와 릴리스를 시작할 차례예요.`);
		return 0;
	}
	const env = opts.gate ?? realGateEnv(`https://github.com/${RELEASE_REPO}.git`);
	const ctx = { ...env, stateDir: opts.stateDir, slot, now };
	const gate = gateStatus(ctx);
	if (gate.kind === "idle") {
		const key = opts.signingKey ?? signingKeyPath(process.env);
		if (keyMissing(key)) {
			print(`서명 키가 없어서 테스트와 릴리스를 시작하지 않아요 (${key}). 키가 있는 기기에서만 내요.`);
			return 1;
		}
		startGate(ctx, [process.execPath, fileURLToPath(import.meta.url), "--gate-run", opts.stateDir, slot, env.origin]);
		print(`전체 테스트를 따로 돌리기 시작했어요 (${slot}). 다음 틱부터 결과를 읽어요.`);
		return 0;
	}
	if (gate.kind === "running") {
		print("전체 테스트가 아직 돌고 있어요.");
		return 0;
	}
	if (gate.kind === "nothing") {
		writeAtomic(stateFile, `${slot}\n`); // not a failure: the slot is used, no alert, the next slot looks again
		clearGate(opts.stateDir);
		print(`릴리스할 새 커밋이 없어서 테스트 없이 이 시간대를 건너뛰었어요 (${gate.sha.slice(0, 8)}).`);
		return 0;
	}
	if (gate.kind === "unrunnable") {
		print(`릴리스 전 테스트를 돌리지 못했어요: ${gate.reason} · 이 시간대는 그대로 두고 다음 틱에 다시 시도해요.`);
		return 1;
	}
	if (gate.kind === "green" && gate.release?.code === 0) {
		writeAtomic(stateFile, `${slot}\n`);
		clearGate(opts.stateDir);
		print(`테스트가 green이고 릴리스를 냈어요 (${gate.sha.slice(0, 8)}).`);
		for (const line of gate.release.out.split("\n").slice(-3)) print(line);
		if (gate.flaky.length) {
			const names = gate.flaky.slice(0, FLAKY_SHOWN).join(", ") + (gate.flaky.length > FLAKY_SHOWN ? ` 외 ${gate.flaky.length - FLAKY_SHOWN}개` : "");
			print(`한 번 다시 돌려서 통과한 테스트 ${gate.flaky.length}개: ${names}`);
			try {
				(opts.hubLog ?? appendHubLog)(`release gate: ${gate.flaky.length} flaky test file(s) passed on retry (${gate.sha.slice(0, 8)}): ${gate.flaky.join(", ")}`);
			} catch {
				// the note in hub.log is not worth failing a release that went out
			}
		}
		return 0;
	}
	const message =
		gate.kind === "red"
			? `전체 테스트가 red라서 이 시간대의 릴리스를 건너뛰었어요 (${gate.sha.slice(0, 8)}): ${failedList(gate.failures.length ? gate.failures.map(f => f.name) : gate.failed) || "실패한 테스트를 읽지 못했어요"} · 다음 시간대에 새 main으로 다시 테스트해요.`
			: `테스트는 green이지만 릴리스를 내지 못했어요 (${gate.sha.slice(0, 8)}, 코드 ${gate.release?.code ?? "없음"}): ${(gate.release?.out ?? "릴리스 결과가 없어요").split("\n").slice(-3).join(" / ")} · 다음 시간대에 다시 시도해요.`;
	if (gate.kind === "red") saveRedEvidence(opts.stateDir, slot, gate.sha, gate, now); // clearGate below removes the result: this is what stays
	writeAtomic(stateFile, `${slot}\n`);
	writeAtomic(join(opts.stateDir, "release-run.json"), `${JSON.stringify({ slot, startedAt: now.toISOString(), state: "failed", message } satisfies RunState)}\n`);
	clearGate(opts.stateDir);
	print(message);
	return SLOT_SKIPPED_EXIT;
}

function failedList(failed: readonly string[]): string {
	return failed.slice(0, 5).join(", ") + (failed.length > 5 ? ` 외 ${failed.length - 5}개` : "");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const shaAt = args.indexOf("--sha");
	const sha = shaAt >= 0 ? args[shaAt + 1] : undefined;
	const unknown = args.filter((a, i) => a !== "--auto" && a !== "--force" && a !== "--dry-run" && a !== "--dispatch" && i !== shaAt && !(shaAt >= 0 && i === shaAt + 1));
	const stateDir = process.env.DOTZ_WATCH_STATE_DIR;
	const dispatch = args.includes("--dispatch");
	const gateRun = args.indexOf("--gate-run"); // the gate's detached runner (release-gate.ts), started by a dispatch tick: --gate-run <stateDir> <slot> <origin>
	if (gateRun >= 0) {
		const [dir, slot, origin] = args.slice(gateRun + 1);
		if (!dir || !slot || !origin) process.exit(2);
		await runGate({ stateDir: dir, slot, origin, git: gitOutput, runSuite: runSuiteIn, hasNewCommits: async (repo, sha) => (await newCommitsSinceNewestTag(repo, sha)).any, release: releaseGreen });
		process.exit(0);
	}
	if (unknown.length || (shaAt >= 0 && (!/^[0-9a-f]{40}$/.test(sha ?? "") || !args.includes("--auto"))) || (args.includes("--auto") && args.includes("--force")) || (dispatch && (args.includes("--auto") || args.includes("--force") || !stateDir))) {
		console.log("usage: bun hub/release.ts [--auto [--sha <40-hex commit>]] [--force] [--dry-run]\n       DOTZ_WATCH_STATE_DIR=<dir> bun hub/release.ts --dispatch [--dry-run]");
		process.exit(2);
	}
	if (dispatch) process.exit(await dispatchSlot({ stateDir: stateDir!, dryRun: args.includes("--dry-run") }));
	process.exit(await publishVersion({ auto: args.includes("--auto"), force: args.includes("--force"), dryRun: args.includes("--dry-run"), cwd: process.cwd(), sha }));
}
