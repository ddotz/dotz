// The writing commands: route (is this ours, which cell), brief (what the writing agent reads), check (facts and copying), learn (what the user fixed).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Args } from "./args.ts";
import { buildBrief, pickExamples } from "./brief.ts";
import { type CellId, ALL_CELLS, cellOfText } from "./cells.ts";
import { reportLines, runChecks } from "./check.ts";
import { encodeHashes, gramHashes, loadSalt } from "./copycheck.ts";
import { type Correction, correctionsFrom, latestPerCell, rulesFrom } from "./learn.ts";
import { blocked, done, failed, type Out } from "./out.ts";
import { makeDoc, type Profile } from "./profile.ts";
import { cellFor, routeRequest } from "./route.ts";
import { rootPaths, validVoice, voiceNames, voicePaths, writeAtomic } from "./store.ts";
import { copySources, readAudience, readDocs, readHashes, readMeta, readNeeds, readProfile, readText, refreshProfile, writeDocs, writeHashes, writeMeta, writeText } from "./voices.ts";

const EXAMPLE_POOL = 200;

function voiceOf(root: string, args: Args): string {
	const named = args.flags.get("--voice");
	if (named) return named;
	return voiceNames(root).find(v => readMeta(root, v)?.kind === "self") ?? "me";
}

const fileText = (args: Args, name: string): string | undefined => {
	const file = args.flags.get(name);
	return file ? readFileSync(file, "utf8") : undefined;
};

const parseCellFlag = (v: string | undefined): CellId | undefined => ALL_CELLS.find(id => id === v);

const badCell = (args: Args): Out | undefined => {
	const given = args.flags.get("--cell");
	return given !== undefined && !parseCellFlag(given) ? failed(`--cell "${given}"은(는) 없는 칸이에요. 칸: ${ALL_CELLS.join(", ")}`) : undefined;
};

const missingVoice = (root: string, args: Args, voice: string): Out | undefined =>
	args.flags.has("--voice") && !readMeta(root, voice) ? failed(`"${voice}" 목소리가 없어요. 있는 목소리: ${voiceNames(root).join(", ") || "없음"}`) : undefined;

const savedCell = (root: string, voice: string): CellId | undefined => {
	const file = voicePaths(root, voice).lastCell;
	return existsSync(file) ? parseCellFlag(readFileSync(file, "utf8").trim()) : undefined;
};

export function routeCommand(root: string, args: Args): Out {
	const request = args.flags.get("--request");
	if (!request) return failed("usage: route --request \"<요청 원문>\" [--draft <파일>] [--voice <이름>]");
	const voice = voiceOf(root, args);
	if (!validVoice(voice)) return failed("--voice 이름이 올바르지 않아요");
	const unknown = missingVoice(root, args, voice);
	if (unknown) return unknown;
	const profile = readProfile(root, voice);
	const route = routeRequest(request, fileText(args, "--draft"), profile?.counts ?? {});
	return done(JSON.stringify({ ...route, ...(route.cell ? { inNeeds: readNeeds(root).includes(route.cell) } : {}) }));
}

function readCorrections(root: string, voice: string): Correction[] {
	const file = voicePaths(root, voice).corrections;
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").flatMap((line, i) => {
		if (!line) return [];
		try {
			return [JSON.parse(line) as Correction];
		} catch {
			throw new Error(`${file}의 ${i + 1}번째 줄을 읽을 수 없어요. 그 줄을 고치거나 지워 주세요`);
		}
	});
}

export function briefCommand(root: string, args: Args): Out {
	const request = args.flags.get("--request");
	if (!request) return failed("usage: brief --request \"<요청 원문>\" [--draft <파일>] [--material <파일>] [--voice <이름>] [--cell <칸>]");
	const voice = voiceOf(root, args);
	if (!validVoice(voice)) return failed("--voice 이름이 올바르지 않아요");
	const unknown = missingVoice(root, args, voice) ?? badCell(args);
	if (unknown) return unknown;
	const meta = readMeta(root, voice);
	const profile: Profile | undefined = readProfile(root, voice);
	const draft = fileText(args, "--draft");
	const material = fileText(args, "--material");
	const forced = parseCellFlag(args.flags.get("--cell"));
	const picked = cellFor(request, draft, profile?.counts ?? {});
	const cell = forced ?? picked.cell;
	if (!cell) return blocked(picked.ask ?? picked.basis);
	writeAtomic(voicePaths(root, voice).lastCell, cell);
	const mine = profile?.cells.find(c => c.id === cell);
	const kind = meta?.kind ?? "self";
	const examples = kind === "self" && mine && mine.status !== "empty"
		? pickExamples(readDocs(root, voice).filter(d => d.cell === cell).slice(-EXAMPLE_POOL).map(d => readText(root, voice, d.id)).filter(Boolean), `${request} ${(draft ?? "").slice(0, 500)}`)
		: [];
	const learned = rulesFrom(readCorrections(root, voice), cell);
	const audience = readAudience(root);
	return done(buildBrief({
		cell,
		basis: forced ? "--cell로 정했어요" : picked.basis,
		voice,
		kind,
		profile: mine,
		profileMissing: !profile,
		...(audience ? { audience } : {}),
		examples,
		rules: learned.rules,
		recent: kind === "self" ? learned.recent : [],
		...(draft !== undefined ? { draft } : {}),
		...(material !== undefined ? { material } : {}),
	}));
}

export function checkCommand(root: string, args: Args): Out {
	const result = fileText(args, "--result");
	if (result === undefined) return failed("usage: check --result <파일> [--draft <파일>] [--material <파일>] [--voice <이름>] [--json]");
	const voice = voiceOf(root, args);
	if (!validVoice(voice)) return failed("--voice 이름이 올바르지 않아요");
	const unknown = missingVoice(root, args, voice);
	if (unknown) return unknown;
	const draft = fileText(args, "--draft");
	const material = fileText(args, "--material");
	const report = runChecks({
		result,
		...(draft !== undefined ? { draft } : {}),
		...(material !== undefined ? { material } : {}),
		sources: copySources(root),
		salt: loadSalt(rootPaths(root).salt),
	});
	// Only a result that passed is the base for learn: a blocked one may hold another person's sentences, which are never stored, and an older one is a different piece.
	if (readMeta(root, voice)?.kind !== "other") {
		if (report.blocked) rmSync(voicePaths(root, voice).lastResult, { force: true });
		else writeAtomic(voicePaths(root, voice).lastResult, result);
	}
	const lines = args.flags.has("--json") ? [JSON.stringify(report)] : reportLines(report);
	return { lines, code: report.blocked ? 3 : 0 };
}

export function learnCommand(root: string, args: Args, now = new Date()): Out {
	const bad = badCell(args);
	if (bad) return bad;
	const after = fileText(args, "--after");
	if (after === undefined) return failed("usage: learn --after <사용자가 고친 글 파일> [--before <봇 결과 파일>] [--cell <칸>] [--voice <이름>]");
	const voice = voiceOf(root, args);
	if (!validVoice(voice)) return failed("--voice 이름이 올바르지 않아요");
	const unknown = missingVoice(root, args, voice);
	if (unknown) return unknown;
	const meta = readMeta(root, voice) ?? { name: voice, kind: "self" as const };
	const saved = voicePaths(root, voice).lastResult;
	const before = fileText(args, "--before") ?? (meta.kind === "self" && existsSync(saved) ? readFileSync(saved, "utf8") : undefined);
	if (before === undefined) return failed(meta.kind === "self" ? "비교할 봇 결과가 없어요. --before <봇 결과 파일>을 주거나, 먼저 check로 결과를 검사해 주세요" : "다른 사람 목소리는 봇 결과를 저장하지 않아요. --before <봇 결과 파일>을 꼭 주세요");
	const cell = parseCellFlag(args.flags.get("--cell")) ?? savedCell(root, voice) ?? cellOfText(after);
	// Another person's voice keeps no sentence of the texts, only the short signatures of what was changed.
	const found = correctionsFrom({ before, after, cell, run: randomUUID().slice(0, 8), ts: now.toISOString() }).map(c => (meta.kind === "self" ? c : { ...c, from: "", to: "" }));
	if (found.length === 0) return done("바뀐 곳이 없어서 기록하지 않았어요");
	const all = latestPerCell([...readCorrections(root, voice), ...found]);
	writeAtomic(voicePaths(root, voice).corrections, `${all.map(c => JSON.stringify(c)).join("\n")}\n`);
	writeMeta(root, meta);
	if (meta.kind === "self") {
		const id = createHash("sha1").update(`${voice}|learn|${after}`).digest("hex").slice(0, 12);
		const docs = readDocs(root, voice).filter(d => d.id !== id);
		writeDocs(root, voice, [...docs, makeDoc({ id, origin: "learn", source: "learn", text: after })]);
		writeText(root, voice, id, after);
		writeHashes(root, voice, { ...readHashes(root, voice), [id]: encodeHashes(gramHashes(after, loadSalt(rootPaths(root).salt))) });
	}
	refreshProfile(root, meta, now);
	const facts = found.filter(c => c.kind === "fact").length;
	const promoted = rulesFrom(all, cell).rules;
	return done(
		`고침 ${found.length}건을 ${cell} 칸에 기록했어요(문체 ${found.length - facts}건, 사실 수정 ${facts}건. 사실 수정은 문체 규칙으로 올리지 않아요).`,
		meta.kind === "self" ? "고친 글을 이 칸의 내 글로 더했어요." : "다른 사람 목소리에는 고친 글을 글감으로 더하지 않아요.",
		promoted.length ? `규칙으로 올라간 고침: ${promoted.join(" / ")}` : "아직 규칙으로 올라간 고침은 없어요(같은 고침이 두 번 나오면 올라가요).",
	);
}
