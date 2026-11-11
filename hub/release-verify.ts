// Release tag signature check (docs/releases.md, S2-S5 of the release-signing design). The core takes the body (payload) and the SSH signature of
// an annotated tag and answers verified / unsigned / bad / mismatch / unverifiable with `ssh-keygen -Y`; it needs no git. Two readers feed it:
// a git checkout (`git cat-file`) and the GitHub API (`verification.payload` / `.signature`, never GitHub's own `verified` flag: whoever holds
// the account holds that too). The trusted keys are always the release-signers file of the version installed NOW, never the incoming tree.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./selfupdate.ts";

export type SigStatus = "verified" | "unsigned" | "bad" | "mismatch" | "unverifiable";
export type Verdict = { status: SigStatus; signer?: string; reason: string };
export type SigMode = "warn" | "enforce";
export type Signature = Verdict & { tag: string; mode: SigMode };
export type Want = { tag: string; commit: string; signersFile: string; sshKeygen?: string };

export const SIGNERS_FILE = "release-signers";
const SIG_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const SIG_END = "-----END SSH SIGNATURE-----";
const KEYGEN_MS = 20_000;
const FULL_SHA = /^[0-9a-f]{40}$/;

// The signature block (BEGIN..END) and the bytes before it, which are what was signed.
export function splitTag(raw: string): { payload: string; signature: string | null } {
	const at = raw.indexOf(SIG_BEGIN);
	if (at < 0) return { payload: raw, signature: null };
	const end = raw.indexOf(SIG_END, at);
	return { payload: raw.slice(0, at), signature: raw.slice(at, end < 0 ? undefined : end + SIG_END.length) };
}

type Ran = { out: string; err: string; code: number };
async function keygen(bin: string, args: string[], stdin?: string): Promise<Ran | undefined> {
	try {
		const p = Bun.spawn([bin, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: KEYGEN_MS });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return p.signalCode ? undefined : { out, err, code };
	} catch {
		return undefined; // a missing or killed ssh-keygen is "unverifiable", which the caller reports
	}
}
const tail = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean).pop()?.slice(0, 200) ?? "";
const unverifiable = (reason: string): Verdict => ({ status: "unverifiable", reason });

// Header lines of a tag object: object <sha>, type commit, tag <name>, up to the first blank line.
function header(payload: string): Record<string, string> {
	const h: Record<string, string> = {};
	for (const l of payload.split("\n\n")[0]?.split("\n") ?? []) {
		const i = l.indexOf(" ");
		if (i > 0 && !(l.slice(0, i) in h)) h[l.slice(0, i)] = l.slice(i + 1).trim();
	}
	return h;
}

export async function verifyTag(a: { payload: string; signature: string | null } & Want): Promise<Verdict> {
	if (!a.signature) return { status: "unsigned", reason: "태그에 서명이 없어요" };
	if (!existsSync(a.signersFile)) return unverifiable("허용 서명자 파일(release-signers)이 없어요");
	const bin = a.sshKeygen ?? "ssh-keygen";
	const dir = mkdtempSync(join(tmpdir(), "dotz-sigcheck-"));
	try {
		const tmpSig = join(dir, "tag.sig");
		writeFileSync(tmpSig, `${a.signature.trimEnd()}\n`);
		const found = await keygen(bin, ["-Y", "find-principals", "-s", tmpSig, "-f", a.signersFile]);
		if (!found) return unverifiable("ssh-keygen을 실행하지 못했어요");
		if (!found.out.trim() && /unknown option|illegal option|invalid option|usage:/i.test(found.err)) return unverifiable("ssh-keygen이 너무 오래돼서 서명을 확인할 수 없어요 (OpenSSH 8.2 이상 필요)");
		const signer = found.out.split("\n").map(l => l.trim()).find(Boolean);
		if (found.code !== 0 || !signer) return { status: "bad", reason: "허용된 키로 서명되지 않았어요" };
		const ok = await keygen(bin, ["-Y", "verify", "-f", a.signersFile, "-I", signer, "-n", "git", "-s", tmpSig], a.payload);
		if (!ok) return unverifiable("ssh-keygen을 실행하지 못했어요");
		if (ok.code !== 0) return { status: "bad", signer, reason: `서명이 맞지 않아요 (${tail(ok.err || ok.out)})` };
		const h = header(a.payload);
		if (h.type !== "commit") return { status: "mismatch", signer, reason: `서명된 태그가 커밋을 가리키지 않아요 (type ${h.type ?? "?"})` };
		if (h.tag !== a.tag) return { status: "mismatch", signer, reason: `서명된 태그 이름이 달라요 (${h.tag ?? "?"} ≠ ${a.tag})` };
		if (!FULL_SHA.test(h.object ?? "") || h.object !== a.commit.toLowerCase() || !FULL_SHA.test(a.commit.toLowerCase())) return { status: "mismatch", signer, reason: `서명된 커밋이 받으려는 커밋과 달라요 (${(h.object ?? "?").slice(0, 12)} ≠ ${a.commit.slice(0, 12)})` };
		return { status: "verified", signer, reason: "서명 확인" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// git checkout: the tag object at `ref` (a fetched refs/dotz/tags/<tag>). A lightweight tag points straight at a commit: unsigned.
export async function verifyGitTag(exec: Exec, dir: string, ref: string, w: Want): Promise<Verdict> {
	const kind = await exec(["git", "cat-file", "-t", ref], dir, 15_000);
	if (kind.code !== 0) return unverifiable(`태그 객체를 읽지 못했어요 (${tail(kind.out)})`);
	if (kind.out.trim() !== "tag") return { status: "unsigned", reason: "서명 없는 가벼운 태그예요" };
	const raw = await exec(["git", "cat-file", "tag", ref], dir, 15_000);
	if (raw.code !== 0) return unverifiable(`태그 객체를 읽지 못했어요 (${tail(raw.out)})`);
	return verifyTag({ ...splitTag(raw.out), ...w });
}

type Reply<T> = { ok: true; value: T } | { ok: false; error: { reason: string } };
export type FetchJson = <T>(path: string) => Promise<Reply<T>>;
type RefReply = { object?: { type?: string; sha?: string } };
type TagReply = { verification?: { payload?: string | null; signature?: string | null } };

// GitHub API: the ref says whether the tag is annotated, the tag object carries the signed bytes and the signature.
export async function verifyGithubTag(fetchJson: FetchJson, repo: string, w: Want): Promise<Verdict> {
	const ref = await fetchJson<RefReply>(`/repos/${repo}/git/ref/tags/${w.tag}`);
	if (!ref.ok) return unverifiable(`GitHub에서 태그를 읽지 못했어요 (${ref.error.reason})`);
	if (ref.value.object?.type !== "tag" || !ref.value.object.sha) return { status: "unsigned", reason: "서명 없는 가벼운 태그예요" };
	const tag = await fetchJson<TagReply>(`/repos/${repo}/git/tags/${ref.value.object.sha}`);
	if (!tag.ok) return unverifiable(`GitHub에서 태그 객체를 읽지 못했어요 (${tag.error.reason})`);
	const { payload, signature } = tag.value.verification ?? {};
	if (!signature) return { status: "unsigned", reason: "태그에 서명이 없어요" };
	if (!payload) return unverifiable("GitHub가 서명된 본문을 주지 않았어요");
	return verifyTag({ payload, signature, ...w });
}

export const wantOf = (dir: string, tag: string, commit: string, sshKeygen?: string): Want => ({ tag, commit, signersFile: join(dir, SIGNERS_FILE), sshKeygen });
export const signatureLine = (s: Signature) => `signature: ${s.tag} signer=${s.signer ?? "-"} result=${s.status} (${s.reason})`;
// The verdict as the check reports it, with its one update-log line written through `log`.
export function signed(tag: string, v: Verdict, mode: SigMode, log: (line: string) => void): Signature {
	const s: Signature = { tag, ...v, mode };
	log(signatureLine(s));
	return s;
}
export const signatureAlert = (s: Signature) => `서명을 확인하지 못했어요 (${s.tag}): ${s.reason}. ${s.mode === "enforce" ? "서명 확인이 필수라서 업데이트하지 않았어요." : "지금은 경고만 하고 업데이트는 계속해요."}`;
