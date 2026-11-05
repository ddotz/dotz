// `analyze`: reads exactly what scope.json lists, measures every text, and stores per-document measurements, hashes and (for the owner's own
// writing only) the text. Another person's text is measured and hashed in memory and dropped.
import { createHash } from "node:crypto";
import { encodeHashes, gramHashes, loadSalt } from "./copycheck.ts";
import type { Deps } from "./deps.ts";
import { readNeeds, readDocs, readMeta, writeMeta, writeDocs, writeHashes, readHashes, writeText, dropText, refreshProfile, type VoiceMeta } from "./voices.ts";
import { blocked, failed, FAILED, OK, type Out } from "./out.ts";
import { type Collected, readFolder } from "./readers.ts";
import { type DocRec, makeDoc } from "./profile.ts";
import { loadJson, rootPaths, saveJson, voiceNames } from "./store.ts";
import { readMessages, readSentMail } from "./mailbox.ts";
import { OutOfScopeError, readScope, type Scope, type Target } from "./targets.ts";
import { readBlog, readPage } from "./web.ts";
import { nonSpaceLength } from "./text.ts";
import { STATUS_LABEL } from "./labels.ts";

const MIN_CHARS = 20;

async function collect(scope: Scope, target: Target, deps: Deps): Promise<Collected> {
	switch (target.type) {
		case "folder":
		case "file": return readFolder(scope, target, deps.run);
		case "url": return readPage(scope, target.url ?? "", deps.fetchText);
		case "blog": return readBlog(scope, target, deps.fetchText);
		case "mail": return readSentMail(target, deps.run);
		case "messages": return readMessages(deps.data, target);
		default: return assertNever(target.type);
	}
}

function assertNever(x: never): never {
	throw new Error(`알 수 없는 대상 유형: ${String(x)}`);
}

const idOf = (voice: string, source: string, key: string) => createHash("sha1").update(`${voice}|${source}|${key}`).digest("hex").slice(0, 12);

// A voice with no target left in the scope loses what its targets once gave; the texts the user fixed (origin learn) stay.
function purgeVoice(root: string, meta: VoiceMeta): number {
	const docs = readDocs(root, meta.name);
	const hashes = readHashes(root, meta.name);
	const gone = docs.filter(d => d.origin === "scope");
	for (const d of gone) {
		delete hashes[d.id];
		dropText(root, meta.name, d.id);
	}
	writeDocs(root, meta.name, docs.filter(d => d.origin === "learn"));
	writeHashes(root, meta.name, hashes);
	refreshProfile(root, meta);
	return gone.length;
}

export async function analyze(root: string, only: string | undefined, deps: Deps): Promise<Out> {
	const needs = readNeeds(root);
	if (needs.length === 0) return blocked("먼저 어떤 글을 쓰려는지(니즈)를 정해야 해요: `voice.ts needs add --request \"<요청 말>\"` 또는 `--cell <칸>`");
	const scope = readScope(root);
	const targets = scope.targets.filter(t => !only || t.voice === only);
	const orphans = voiceNames(root).flatMap(v => ((!only || v === only) && !scope.targets.some(t => t.voice === v) ? readMeta(root, v) ?? [] : []));
	if (targets.length === 0 && orphans.length === 0) return failed("읽을 범위가 비어 있어요. 먼저 `voice.ts scope add ...`로 어디를 읽을지 정하세요");
	const salt = loadSalt(rootPaths(root).salt);
	const lines = ["읽은 건수(출처별):"];
	const failedBy = loadJson<Record<string, number>>(rootPaths(root).lastRun, {});
	let failures = 0;

	for (const voice of [...new Set(targets.map(t => t.voice))]) {
		const mine = targets.filter(t => t.voice === voice);
		if (new Set(mine.map(t => t.kind)).size > 1) {
			// An old scope.json may mix kinds: nothing of this voice is read or stored, because the kind decides whether text is kept.
			failures++;
			failedBy[voice] = 1;
			lines.push(`${voice} 목소리: 내 글과 다른 사람 글 대상이 섞여 있어서 읽지 않았어요. scope remove로 한쪽을 빼고 다시 analyze하세요`);
			continue;
		}
		const meta = { name: voice, kind: mine[0]?.kind ?? "self" } as const;
		const fresh = new Map<string, { doc: DocRec; text: string; hashes: string }>();
		const failuresBefore = failures;
		const failedIds = new Set<string>();
		for (const target of mine) {
			let got: Collected;
			try {
				got = await collect(scope, target, deps);
			} catch (e) {
				if (e instanceof OutOfScopeError) throw e;
				failures++;
				failedIds.add(target.id);
				lines.push(`- ${target.sentence}: 읽지 못했어요(${e instanceof Error ? e.message : String(e)})`);
				continue;
			}
			let kept = 0;
			for (const raw of got.docs) {
				if (nonSpaceLength(raw.text) < MIN_CHARS) {
					got.skipped["너무 짧음"] = (got.skipped["너무 짧음"] ?? 0) + 1;
					continue;
				}
				const id = idOf(voice, raw.source, raw.key);
				fresh.set(id, { doc: { ...makeDoc({ id, origin: "scope", source: raw.source, text: raw.text, hint: raw.hint }), target: target.id }, text: raw.text, hashes: encodeHashes(gramHashes(raw.text, salt)) });
				kept++;
			}
			const skipped = Object.entries(got.skipped).map(([why, n]) => `${why} ${n}`).join(", ");
			lines.push(`- ${target.sentence}: ${kept}건 읽음${skipped ? `, 건너뜀(${skipped})` : ""}`);
		}

		const before = readDocs(root, voice);
		const hashes = readHashes(root, voice);
		// A target that failed to read must not wipe what an earlier run read from it, so its older scope documents stay; a removed target's do not.
		const kept = before.filter(d => d.origin === "scope" && !fresh.has(d.id) && d.target !== undefined && failedIds.has(d.target));
		for (const old of before.filter(d => d.origin === "scope" && !kept.includes(d))) {
			delete hashes[old.id];
			dropText(root, voice, old.id);
		}
		for (const [id, f] of fresh) {
			hashes[id] = f.hashes;
			if (meta.kind === "self") writeText(root, voice, id, f.text);
		}
		writeMeta(root, meta);
		writeDocs(root, voice, [...before.filter(d => d.origin === "learn"), ...kept, ...[...fresh.values()].map(f => f.doc)]);
		writeHashes(root, voice, hashes);
		const profile = refreshProfile(root, meta);
		failedBy[voice] = failures - failuresBefore;
		lines.push(`${voice} 목소리(${meta.kind === "self" ? "내 글" : "다른 사람 글"}) 칸 상태:`);
		for (const c of profile.cells) lines.push(`  ${c.id}: ${STATUS_LABEL[c.status]} (글 ${c.docs}편, 한글 ${c.hangul}자, 측정 단위 ${c.units}개)`);
	}
	for (const meta of orphans) {
		const gone = purgeVoice(root, meta);
		delete failedBy[meta.name];
		lines.push(`${meta.name} 목소리: 읽기 범위에 남은 곳이 없어서 저장된 글 ${gone}편과 해시를 지웠어요(사용자가 고친 글은 그대로예요)`);
	}
	saveJson(rootPaths(root).lastRun, failedBy);
	return { lines, code: failures > 0 ? FAILED : OK };
}
