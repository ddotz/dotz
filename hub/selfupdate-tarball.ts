// Tarball installs for selfupdate.ts (install.sh without --git): the check against GitHub's newest release tag (or a DOTZ_TARBALL file's
// digest) and the download -> extract -> bun install -> tests -> dir swap apply. The helpers only these two use live here too: the GitHub
// credential order, the API/download client and readUrl. Module state (job, settings, the stamp and pending-marker writers) stays in
// selfupdate.ts and reaches this file through the Kit argument, so there is no import cycle and no second copy of that state.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { type FetchJson, type SigMode, signed, verifyGithubTag, wantOf } from "./release-verify.ts";
import { compareReleases, failedTestNames, failureBlocks, gateIn, parseRelease, type Release, testFailure, testSummary } from "./selfupdate-parse.ts";
import type { CheckError, CheckResult, Exec, Http, Job, Options, Tarball } from "./selfupdate.ts";
import type { Pending } from "./update-watchdog.ts";

// What selfupdate.ts hands over: its own helpers, bound to its module state.
export type Kit = {
	resolve: (o: Options) => { dir: string; exec: Exec; testCmd?: string[]; logDir: string };
	record: (logDir: string, text: string) => void;
	scrub: (s: string) => string;
	lastLine: (s: string) => string;
	readStamp: (dir: string) => Record<string, string> | undefined;
	stampText: (kv: Record<string, string>) => string;
	sigMode: (o: Options) => SigMode;
	markPending: (o: Options, p: Pick<Pending, "kind" | "dir" | "from" | "to" | "prev" | "deps">, step: (phase: string, text: string) => void) => void;
};

type Cred = { how: "token"; token: string; from: string } | { how: "gh" } | { how: "none" };
const credName = (c: Cred) => (c.how === "token" ? `token(${c.from})` : c.how);
const authLabel = (c: Cred) => (c.how === "none" ? "public" : c.how);

// Who GitHub is asked as, in order: GITHUB_TOKEN, GH_TOKEN, the token file install.sh saved, `gh api` (when gh is signed in), nobody.
// A credential GitHub refuses falls through to the next one, so a stale token never blocks a public repo.
export function authOrder(o: Options): Cred[] {
	const env = o.env ?? process.env;
	const out: Cred[] = [];
	const add = (token: string | undefined, from: string) => {
		const t = token?.trim();
		if (t && !out.some(c => c.how === "token" && c.token === t)) out.push({ how: "token", token: t, from });
	};
	add(env.GITHUB_TOKEN, "env GITHUB_TOKEN");
	add(env.GH_TOKEN, "env GH_TOKEN");
	const file = join(o.dataDir ?? DATA_DIR, "secrets", "github-token");
	if (existsSync(file)) add(readFileSync(file, "utf8"), "secrets/github-token");
	out.push({ how: "gh" }, { how: "none" });
	return out;
}

type GhTag = { name?: string; commit?: { sha?: string } };
const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

type Try<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };
type Hit<T> = { ok: true; value: T; cred: Cred } | { ok: false; error: CheckError };

function github(o: Options, repo: string, k: Kit) {
	const { resolve, lastLine, scrub } = k;
	const { exec } = resolve(o);
	const http: Http = o.http ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(120_000) }));
	const creds = authOrder(o);
	let good: Cred | undefined;
	const headers = (c: Cred, accept: string): Record<string, string> => ({ accept, "user-agent": "dotz-selfupdate", ...(c.how === "token" ? { authorization: `Bearer ${c.token}` } : {}) });
	// The first credential that works wins (and goes first next time); the error names what the refusals mean for the owner.
	const run = async <T>(fn: (c: Cred) => Promise<Try<T>>): Promise<Hit<T>> => {
		const fails: string[] = [];
		let auth = false, rate = false, net = false;
		for (const c of good ? [good, ...creds.filter(x => x !== good)] : creds) {
			const r = await fn(c).catch((e): Try<T> => ({ ok: false, status: 0, detail: String(e) }));
			if (r.ok) {
				good = c;
				return { ok: true, value: r.value, cred: c };
			}
			fails.push(`${credName(c)}: ${r.status || "-"} ${r.detail}`.trim());
			if (/rate limit/i.test(r.detail)) rate = true;
			else if ([401, 403, 404].includes(r.status)) auth = true;
			else if (r.status === 0 && c.how !== "gh") net = true;
		}
		const detail = scrub(fails.join(" | ")).slice(0, 400);
		if (rate) return { ok: false, error: { reason: "GitHub 요청 한도에 걸렸어요.", fix: "잠시 뒤 다시 확인해 주세요. GITHUB_TOKEN이나 `gh auth login`을 쓰면 한도가 커져요.", detail } };
		if (auth) return { ok: false, error: { reason: `GitHub 인증이 없어 ${repo}을(를) 받을 수 없어요 (비공개 저장소이거나 ref가 없어요).`, fix: "이 Mac의 터미널에서 `gh auth login`을 하거나, GITHUB_TOKEN을 준 채 install.sh를 다시 실행해 주세요 (토큰은 데이터 폴더의 secrets/github-token에 0600으로 저장돼요).", detail } };
		if (net) return { ok: false, error: { reason: "GitHub에 연결하지 못했어요 (네트워크).", fix: "인터넷 연결을 확인하고 잠시 뒤 다시 확인해 주세요.", detail } };
		return { ok: false, error: { reason: "GitHub에서 새 버전을 받지 못했어요.", fix: "`gh auth status`로 로그인을 확인하고 다시 확인해 주세요.", detail } };
	};
	return {
		json: <T>(path: string) =>
			run<T>(async c => {
				if (c.how === "gh") {
					const r = await exec(["gh", "api", path.slice(1), "-H", "Accept: application/vnd.github+json"], o.dir, 60_000);
					if (r.code !== 0) return { ok: false, status: Number(/HTTP (\d{3})/.exec(r.out)?.[1] ?? 0), detail: lastLine(r.out) };
					return { ok: true, value: JSON.parse(r.out) as T };
				}
				const res = await http(`https://api.github.com${path}`, { headers: headers(c, "application/vnd.github+json") });
				if (!res.ok) return { ok: false, status: res.status, detail: lastLine(await res.text().catch(() => "")) };
				return { ok: true, value: (await res.json()) as T };
			}),
		download: (sha: string, dest: string) =>
			run<true>(async c => {
				if (c.how === "gh") {
					const r = await exec(["sh", "-c", 'gh api "$1" > "$2"', "sh", `repos/${repo}/tarball/${sha}`, dest], o.dir, 5 * 60_000);
					return r.code === 0 ? { ok: true, value: true } : { ok: false, status: Number(/HTTP (\d{3})/.exec(r.out)?.[1] ?? 0), detail: lastLine(r.out) };
				}
				const url = c.how === "token" ? `https://api.github.com/repos/${repo}/tarball/${sha}` : `https://codeload.github.com/${repo}/tar.gz/${sha}`;
				const res = await http(url, { headers: headers(c, "application/vnd.github+json") });
				if (!res.ok) return { ok: false, status: res.status, detail: lastLine(await res.text().catch(() => "")) };
				await Bun.write(dest, res);
				return { ok: true, value: true };
			}),
	};
}

// A DOTZ_TARBALL install: the same URL or path again. Its identity is the sha256 of the bytes.
async function readUrl(o: Options, url: string): Promise<Uint8Array> {
	if (!/^https?:\/\//.test(url)) return new Uint8Array(await Bun.file(url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : url).arrayBuffer());
	const token = authOrder(o).find(c => c.how === "token");
	const http: Http = o.http ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(120_000) }));
	const res = await http(url, { headers: token?.how === "token" ? { authorization: `Bearer ${token.token}` } : {} });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

export async function checkTarball(o: Options, v: Tarball, base: CheckResult, k: Kit): Promise<CheckResult> {
	const { resolve, record, readStamp, scrub, lastLine, sigMode } = k;
	const { logDir } = resolve(o);
	const fail = (upstream: string, error: CheckError) => {
		record(logDir, `check: tarball ${upstream} failed: ${error.reason} (${error.detail})`);
		return { ...base, upstream, error };
	};
	if (v.origin === "url") {
		const url = readStamp(o.dir)?.tarball ?? "";
		const upstream = scrub(url);
		let digest: string;
		try {
			digest = sha256(await readUrl(o, url));
		} catch (e) {
			return fail(upstream, { reason: "설치할 때 쓴 tarball을 다시 받지 못했어요.", fix: "DOTZ_TARBALL 경로나 주소가 아직 있는지 확인하고, 없으면 install.sh를 다시 실행해 주세요.", detail: lastLine(String(e)) });
		}
		const r: CheckResult = { ...base, ok: true, upstream, remoteHead: digest };
		if (sameSha(digest, v.commit.sha)) {
			r.summary = "업데이트 없음 (tarball)";
			return r;
		}
		r.incoming = [{ sha: digest, short: digest.slice(0, 7), date: new Date().toISOString(), subject: `${upstream}의 tarball이 바뀌었어요` }];
		r.incomingTotal = 1;
		r.summary = "tarball이 바뀌었어요";
		record(logDir, `check: ${v.commit.short} vs tarball ${digest.slice(0, 7)}: changed`);
		return r;
	}
	const gh = github(o, v.repo, k);
	// Only released versions: the newest tag v<YYMMDD.N>[.<M>] of the repo, not the head of its branch. A handful is enough to find it; a
	// repo that interleaves other tags still finds its releases among the newest by date, and anything malformed is ignored.
	const tagsRes = await gh.json<GhTag[]>(`/repos/${v.repo}/tags?per_page=30`);
	if (!tagsRes.ok) return fail(`${v.repo}@${v.ref}`, tagsRes.error);
	const newest = (tagsRes.value ?? [])
		.map(t => ({ tag: t.name ?? "", sha: t.commit?.sha ?? "", release: parseRelease(t.name ?? "") }))
		.filter((t): t is { tag: string; sha: string; release: Release } => !!t.release)
		.sort((a, b) => compareReleases(b.release.text, a.release.text))[0];
	if (!newest) {
		const r: CheckResult = { ...base, ok: true, upstream: v.repo, summary: `업데이트 없음 (릴리스 없음)` };
		record(logDir, `check: ${v.repo} has no release tag; nothing to do`);
		return r;
	}
	const upstream = `${v.repo}@${newest.tag}`;
	const r: CheckResult = { ...base, ok: true, upstream, available: newest.release.text, remoteHead: newest.sha };
	if (v.release && compareReleases(v.release, newest.release.text) >= 0) {
		r.summary = `업데이트 없음 (${v.release})`;
		record(logDir, `check: ${v.release} is at or past ${newest.tag}; no update`);
		return r;
	}
	r.summary = `${v.release ?? "설치본"} → ${newest.release.text}`;
	r.incoming = [{ sha: newest.sha, short: newest.sha.slice(0, 7), date: "", subject: `릴리스 ${newest.tag}` }];
	r.incomingTotal = 1;
	r.signature = signed(newest.tag, await verifyGithubTag(gh.json as FetchJson, v.repo, wantOf(o.dir, newest.tag, newest.sha, o.sshKeygen)), sigMode(o), t => record(logDir, t));
	record(logDir, `check: ${v.release ?? "?"} → ${newest.release.text} (${newest.tag}), ${newest.sha.slice(0, 7)} (${tagsRes.cred.how})`);
	return r;
}

// Download → extract → bun install → tests, all in a staging dir next to the install; only then swap the dirs. Any failure removes the
// staging dir and leaves the running code untouched.
export async function applyTarball(o: Options, c: CheckResult, v: Tarball, j: Job, step: (phase: string, text: string) => void, end: (status: Job["status"], text: string) => Job, k: Kit): Promise<Job> {
	const { resolve, record, readStamp, stampText, scrub, lastLine, markPending } = k;
	const { dir, exec, testCmd, logDir } = resolve(o);
	const stage = `${dir}.update`;
	const prev = `${dir}.prev`;
	const fresh = join(stage, "new");
	const oldStamp = readStamp(dir) ?? {};
	const fail = (why: string) => {
		rmSync(stage, { recursive: true, force: true });
		return end("failed", `${why}. 이전 버전(${v.commit.short})이 그대로 있어요.`);
	};
	let to = c.remoteHead as string;
	let auth = v.auth;
	// The tarball of the released tag itself (never a branch head): its contents are the released version.
	const ref = c.signature?.status === "verified" ? to : c.available ? `v${c.available}` : to; // a verified release is fetched by the commit that was verified
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(join(stage, "x"), { recursive: true });
	const tgz = join(stage, "src.tgz");
	step("내려받기", `${v.origin === "url" ? scrub(oldStamp.tarball ?? "") : `${v.repo}@${ref}`} 새 버전을 내려받아요`);
	if (v.origin === "github") {
		const d = await github(o, v.repo, k).download(ref, tgz);
		if (!d.ok) return fail(`내려받지 못했어요: ${d.error.reason} ${d.error.detail}`);
		auth = authLabel(d.cred);
	} else {
		try {
			const bytes = await readUrl(o, oldStamp.tarball ?? "");
			to = sha256(bytes);
			writeFileSync(tgz, bytes);
		} catch (e) {
			return fail(`내려받지 못했어요: ${lastLine(String(e))}`);
		}
	}
	j.to = to;
	step("풀기", "압축을 풀어요");
	const x = await exec(["tar", "-xzf", tgz, "-C", join(stage, "x")], stage, 2 * 60_000);
	if (x.code !== 0) return fail(`압축을 풀지 못했어요: ${lastLine(x.out)}`);
	// GitHub tarballs (and git archive --prefix) wrap everything in one top folder.
	const tops = readdirSync(join(stage, "x"));
	const top = tops.length === 1 && statSync(join(stage, "x", tops[0])).isDirectory() ? join(stage, "x", tops[0]) : join(stage, "x");
	if (!existsSync(join(top, "setup.ts")) || !existsSync(join(top, "hub", "main.ts"))) return fail("받은 파일이 dotz가 아니에요 (setup.ts, hub/main.ts가 없어요)");
	renameSync(top, fresh);
	writeFileSync(join(fresh, ".dotz-install"), stampText({ ...oldStamp, ...(c.available ? { version: c.available } : {}), sha: to, auth, installed: new Date().toISOString().replace(/\.\d+Z$/, "Z") }));

	step("의존성", "새 폴더에서 bun install을 실행해요");
	const i = await exec(["bun", "install"], fresh, 10 * 60_000);
	if (i.code !== 0) return fail(`bun install 실패: ${lastLine(i.out)}`);

	const gate = gateIn(fresh, testCmd);
	step("테스트", `${gate.cmd.join(" ")} 실행 중 (새 폴더)`);
	const t = await exec(gate.cmd, fresh, gate.ms);
	const summary = testSummary(t.out);
	if (summary) record(logDir, `update #${j.id}: tests: ${summary}`);
	if (t.code !== 0) {
		const blocks = failureBlocks(t.out);
		if (blocks) record(logDir, `update #${j.id}: failed tests\n${blocks}`);
		record(logDir, `update #${j.id}: test output (tail)\n${t.out.split("\n").slice(-40).join("\n")}`);
		const names = failedTestNames(t.out);
		return fail(testFailure(t.code, names));
	}

	step("교체", `${dir} 폴더를 새 버전으로 바꾸고 이전 폴더는 ${prev}에 남겨요`);
	try {
		rmSync(prev, { recursive: true, force: true });
		renameSync(dir, prev);
		try {
			renameSync(fresh, dir);
		} catch (e) {
			renameSync(prev, dir);
			throw e;
		}
	} catch (e) {
		return fail(`폴더를 바꾸지 못했어요: ${lastLine(String(e))}`);
	}
	rmSync(stage, { recursive: true, force: true });
	markPending(o, { kind: "tarball", dir, from: v.commit.sha, to, prev }, step);
	const arrow = c.available && v.release ? `${v.release} → ${c.available}` : `${v.commit.short} → ${to.slice(0, 7)}`;
	return end("updated", `${arrow} 받았어요. 이전 폴더는 ${prev}에 있어요. 재시작하면 적용돼요.`);
}
