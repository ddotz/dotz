// Versioned delivery (docs/releases.md): tag v<YYMMDD.N> on main plus VERSION, KST day, at most three a day.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type Release = { readonly date: string; readonly n: number; readonly text: string };

export type Plan =
	| { ok: true; version: Release; previous: Release | null }
	| { ok: false; code: "limit" | "future"; reason: string };

const MAX_PER_DAY = 3;
const KST = "Asia/Seoul";
const VERSION_RE = /^v?(\d{2})(\d{2})(\d{2})\.(\d{1,2})$/;

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

export function shiftDay(date: string, delta: number): string {
	const y = 2000 + Number(date.slice(0, 2));
	const m = Number(date.slice(2, 4));
	const d = Number(date.slice(4, 6));
	const t = new Date(Date.UTC(y, m - 1, d + delta));
	return `${String(t.getUTCFullYear() % 100).padStart(2, "0")}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function parseVersion(text: string): Release | null {
	const m = VERSION_RE.exec(text.trim());
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const n = Number(m[4]);
	if (month < 1 || month > 12 || day < 1 || day > 31 || n < 1) return null;
	const date = `${m[1]}${m[2]}${m[3]}`;
	return { date, n, text: `${date}.${n}` };
}

export function compareVersions(a: Release, b: Release): number {
	const date = Number(a.date) - Number(b.date);
	return date !== 0 ? date : a.n - b.n;
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
	if (!newest) return { ok: true, version: parseVersion(`${today}.1`)!, previous: null };
	if (newest.date > today) {
		return { ok: false, code: "future", reason: `${newest.text} 태그가 오늘(${today})보다 뒤 날짜예요. 태그나 기기 시계를 확인해 주세요.` };
	}
	if (newest.date < today) return { ok: true, version: parseVersion(`${today}.1`)!, previous: newest };

	const todayNs = new Set(versions.filter(v => v.date === today).map(v => v.n));
	if (todayNs.size >= MAX_PER_DAY || Math.max(...todayNs) >= MAX_PER_DAY) {
		return {
			ok: false,
			code: "limit",
			reason: `오늘(${today})은 세 번을 이미 냈어요 (${[...todayNs].sort((a, b) => a - b).map(n => `${today}.${n}`).join(", ")}). 하루에 세 번까지만 내요. 다음 버전은 내일 ${shiftDay(today, 1)}.1이에요.`,
		};
	}
	let n = todayNs.size + 1;
	if (todayNs.has(n)) n = [1, 2, 3].find(candidate => !todayNs.has(candidate))!;
	return { ok: true, version: parseVersion(`${today}.${n}`)!, previous: newest };
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
	const proc = Bun.spawn(["git", "--no-pager", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, out: `${out}${err}`.trim() };
}

export async function localTags(root: string): Promise<string[]> {
	const r = await gitOutput(["tag", "--list", "v*"], root);
	if (r.code !== 0) throw new Error(`태그를 읽지 못했어요: ${r.out}`);
	return r.out.split("\n").map(s => s.trim()).filter(Boolean);
}

export async function dirtyTracked(root: string): Promise<string[]> {
	const r = await gitOutput(["status", "--porcelain", "--untracked-files=no"], root);
	if (r.code !== 0) throw new Error(`저장소 상태를 읽지 못했어요: ${r.out}`);
	return r.out.split("\n").map(s => s.trim()).filter(Boolean);
}

export async function hasCommitsSince(root: string, since: string | null): Promise<boolean> {
	if (!since) return true;
	const r = await gitOutput(["rev-list", "--count", `${since}..HEAD`], root);
	if (r.code !== 0) throw new Error(`커밋을 세지 못했어요: ${r.out}`);
	return Number(r.out) > 0;
}

export type PublishOptions = {
	auto: boolean;
	dryRun: boolean;
	cwd: string;
	now?: Date;
	print?: (line: string) => void;
};

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

	if (opts.auto) {
		const newTags = await localTags(root);
		const newest = newestVersion(newTags);
		if (!(await hasCommitsSince(root, newest ? `v${newest.text}` : null))) {
			print(`새 커밋이 없어서 버전을 내지 않았어요 (최신 ${newest ? `v${newest.text}` : "태그 없음"}).`);
			return 0;
		}
	}

	const dirty = await dirtyTracked(root);
	const today = todayKst(now);
	const plan = planNext(await localTags(root), today);
	if (!plan.ok) {
		print("다음 버전을 낼 수 없어요.");
		print(plan.reason);
		return 1;
	}
	const { version, previous } = plan;
	const tag = `v${version.text}`;

	const base = previous ? `v${previous.text}` : null;
	const log = await gitOutput(["log", "--oneline", "--max-count=20", ...(base ? [`${base}..HEAD`] : ["HEAD"])], root);
	const summary = summarizeChanges(log.out.split("\n").filter(Boolean), previous);

	print(`다음 버전: ${tag}${previous ? ` (이전 ${base})` : " (첫 버전)"}`);
	print(`변경 요약: ${summary}`);

	if (opts.dryRun) {
		print(`[--dry-run] 아무것도 쓰지 않았어요. 실제로 내보내면 VERSION을 ${version.text}로 쓰고, 커밋하고, 태그 ${tag}까지 origin/main과 함께 푸시해요.`);
		return 0;
	}

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

	writeFileSync(join(root, "VERSION"), `${version.text}\n`);
	print(`VERSION: ${version.text}`);

	const added = await gitOutput(["add", "VERSION"], root);
	if (added.code !== 0) {
		print(`VERSION을 스테이징하지 못했어요: ${added.out}`);
		return 1;
	}
	const identity = (await gitOutput(["config", "user.email"], root)).code === 0
		? []
		: ["-c", "user.name=dotz-release", "-c", "user.email=dotz-release@users.noreply.github.com"];
	const committed = await gitOutput(["commit", ...identity, "-m", `release: ${tag}\n\n${summary}`], root);
	if (committed.code !== 0) {
		print(`커밋하지 못했어요: ${committed.out}`);
		print("VERSION 파일만 바뀐 상태로 남아 있어요.");
		return 1;
	}
	const sha = await gitOutput(["rev-parse", "--short", "HEAD"], root);
	print(`커밋: ${sha.out} release: ${tag}`);

	if ((await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], root)).out === "HEAD") {
		const branch = await gitOutput(["switch", "-C", "main"], root);
		if (branch.code !== 0) {
			print(`main 브랜치로 옮기지 못했어요: ${branch.out}`);
			return 1;
		}
	}
	const pulled = await gitOutput(["pull", "--rebase", "--quiet", "origin", "main"], root);
	if (pulled.code !== 0) {
		await gitOutput(["rebase", "--abort"], root);
		print(`origin/main과 동기화하지 못했어요: ${pulled.out}`);
		print("커밋은 로컬에만 있어요. rebase를 마친 뒤 다시 실행해 주세요.");
		return 1;
	}

	const tagged = await gitOutput(["tag", tag], root);
	if (tagged.code !== 0) {
		print(`태그 ${tag}를 달지 못했어요: ${tagged.out}`);
		return 1;
	}
	print(`태그: ${tag}`);

	const pushedMain = await gitOutput(["push", "origin", "main"], root);
	if (pushedMain.code !== 0) {
		print(`main을 푸시하지 못했어요: ${pushedMain.out}`);
		print("커밋과 태그는 로컬에 남아 있어요. 원격 상태를 확인한 뒤 다시 푸시해 주세요.");
		return 1;
	}
	print("푸시: origin main");

	const pushedTag = await gitOutput(["push", "origin", tag], root);
	if (pushedTag.code !== 0) {
		print(`태그를 푸시하지 못했어요: ${pushedTag.out}`);
		print("태그는 로컬에 남아 있어요. 원격 상태를 확인한 뒤 다시 푸시해 주세요.");
		return 1;
	}
	print(`푸시: origin ${tag}`);
	print(`내보냈어요: ${tag} (${sha.out})`);
	return 0;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const unknown = args.filter(a => a !== "--auto" && a !== "--dry-run");
	if (unknown.length) {
		console.log("usage: bun hub/release.ts [--auto] [--dry-run]");
		process.exit(2);
	}
	process.exit(await publishVersion({ auto: args.includes("--auto"), dryRun: args.includes("--dry-run"), cwd: process.cwd() }));
}
