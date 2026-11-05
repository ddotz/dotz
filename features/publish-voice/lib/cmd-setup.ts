// The setup commands: status, discover (what could be read, nothing opened), needs (which cells to compute), scope (what may be read).
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { Args } from "./args.ts";
import { ALL_CELLS, type CellId, requestAxes, resolveCell } from "./cells.ts";
import type { Deps } from "./deps.ts";
import { walkFolder } from "./folders.ts";
import { STATUS_LABEL } from "./labels.ts";
import { blocked, done, failed, type Out } from "./out.ts";
import type { Profile } from "./profile.ts";
import { loadJson, rootPaths, voiceNames } from "./store.ts";
import { addTarget, PERSONAL_MAIL, readScope, removeTarget, type Scope, type TargetType } from "./targets.ts";
import { readAudience, readDocs, readMeta, readNeeds, readProfile, refreshProfile, writeNeeds } from "./voices.ts";

const HOME_CANDIDATES = ["Documents", "Desktop", "Notes", "notes", "Obsidian", "Writing", "글", "원고", "블로그", "Blog"];
const TYPES: readonly TargetType[] = ["folder", "file", "url", "blog", "mail", "messages"];

const profileLines = (p: Profile): string[] => [
	`${p.voice} 목소리(${p.kind === "self" ? "내 글" : "다른 사람 글"}, 글 ${p.docs}편):`,
	...p.cells.map(c => `  ${c.id}: ${STATUS_LABEL[c.status]} (글 ${c.docs}편, 한글 ${c.hangul}자, 측정 단위 ${c.units}개)`),
];

const profiles = (root: string): Profile[] => voiceNames(root).flatMap(v => readProfile(root, v) ?? []);

const audienceLines = (root: string): string[] => {
	const audience = readAudience(root);
	return audience ? [`독자: ${audience}`] : [];
};

// The first missing step, in the order the setup runs. A voice is stale when it has no profile or scope.json was written after the profile was built.
function nextStep(root: string, needs: readonly CellId[], scope: Scope): string {
	if (needs.length === 0) return "다음: needs add로 쓸 칸을 정해요(--request \"<요청 말>\" 또는 --cell <칸>)";
	// A voice whose targets are all gone still holds what they gave until analyze purges it.
	const orphaned = voiceNames(root).some(v => !scope.targets.some(t => t.voice === v) && readDocs(root, v).some(x => x.origin === "scope"));
	if (orphaned) return "다음: analyze로 읽기 범위에서 빠진 글을 지워요";
	if (scope.targets.length === 0) return "다음: discover로 읽을 수 있는 곳을 보고, scope add로 읽을 곳을 정해요";
	const scopeTime = statSync(rootPaths(root).scope).mtimeMs;
	const stale = [...new Set(scope.targets.map(t => t.voice))].some(v => {
		const built = readProfile(root, v)?.builtAt;
		return built === undefined || scopeTime > Date.parse(built);
	});
	if (stale) return "다음: analyze로 읽기 범위의 글을 재어 칸별 값을 계산해요";
	const failedVoices = Object.entries(loadJson<Record<string, number>>(rootPaths(root).lastRun, {})).filter(([, n]) => n > 0).map(([v]) => v);
	return failedVoices.length
		? `다음: 마지막 analyze에서 ${failedVoices.join(", ")} 목소리의 읽지 못한 곳이 있어요. 실패 이유를 사용자에게 말하고, 고친 뒤 analyze를 다시 돌리거나 scope remove로 빼요`
		: "다음: 준비됐어요, brief로 쓰면 돼요";
}

export function statusCommand(root: string): Out {
	const needs = readNeeds(root);
	const scope = readScope(root);
	return done(
		`니즈(계산하는 칸): ${needs.join(", ") || "아직 없음"}`,
		...audienceLines(root),
		scope.targets.length ? "읽기 범위:" : "읽기 범위: 아직 없음",
		...scope.targets.map(t => `  [${t.id}] ${t.sentence}`),
		...profiles(root).flatMap(profileLines),
		nextStep(root, needs, scope),
	);
}

export async function discoverCommand(args: Args, deps: Deps): Promise<Out> {
	const home = args.flags.get("--home") || homedir();
	const lines = ["읽을 수 있는 곳(파일 이름만 세었고 내용은 열지 않았어요):"];
	for (const name of HOME_CANDIDATES) {
		const dir = join(home, name);
		if (!existsSync(dir)) continue;
		const walk = walkFolder(dir, false);
		const exts = [...new Set(walk.files.map(f => extname(f).slice(1).toLowerCase()))].join("·");
		lines.push(walk.files.length ? `- ${dir}: ${exts} 파일 ${walk.tooMany ? "5000개 넘음(더 좁은 폴더를 고르세요)" : `${walk.files.length}개`}` : `- ${dir}: 읽을 수 있는 글 파일 없음`);
	}
	if (lines.length === 1) lines.push("- 흔한 글 폴더가 보이지 않아요. 사용자에게 폴더 위치를 물어보세요");
	const tools = ["textutil", "pandoc", "kordoc", "zele"].map(t => `${t} ${Bun.which(t) ? "있음" : "없음"}`);
	lines.push(`변환·메일 도구: ${tools.join(", ")} (docx는 textutil이나 pandoc, hwp는 kordoc이 있어야 읽어요)`);
	if (Bun.which("zele")) {
		const who = await deps.run(["zele", "whoami"]);
		const accounts = [...new Set(who.out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])];
		lines.push(...accounts.map(a => `- 메일 ${a}: ${PERSONAL_MAIL.includes(a.split("@")[1]?.toLowerCase() ?? "") ? "개인 메일(보낸 메일을 읽을 수 있어요)" : "회사 메일로 보여요(읽기 전에 사용자에게 먼저 물어야 해요)"}`));
	}
	if (existsSync(join(deps.data, "inbox.jsonl"))) lines.push("- dotz에 보낸 내 메시지를 읽을 수 있어요(짧은 글 칸만 채워요)");
	lines.push("다음: 어디서 어디까지 읽을지 사용자에게 먼저 말하고, 허락을 기다리지 않고 바로 `scope add`를 실행하세요.");
	return done(...lines);
}

function selfCounts(root: string): Partial<Record<CellId, number>> {
	const sum: Partial<Record<CellId, number>> = {};
	for (const p of profiles(root).filter(x => x.kind === "self")) for (const id of ALL_CELLS) sum[id] = (sum[id] ?? 0) + (p.counts[id] ?? 0);
	return sum;
}

export function needsCommand(root: string, args: Args): Out {
	const sub = args.pos[1] ?? "show";
	if (sub !== "show" && sub !== "add" && sub !== "remove") return failed("usage: needs [show | add | remove] [--cell <칸>,<칸>] [--request \"<요청 말>\"] [--audience \"<독자>\"]");
	if (sub !== "show") {
		const asked = (args.flags.get("--cell") ?? "").split(",").map(s => s.trim()).filter(Boolean);
		const bad = asked.filter(c => !ALL_CELLS.some(id => id === c));
		if (bad.length) return failed(`알 수 없는 칸: ${bad.join(", ")}. 칸은 ${ALL_CELLS.join(", ")} 중에서 골라요`);
		const cells = ALL_CELLS.filter(id => asked.includes(id));
		const request = args.flags.get("--request");
		if (request) {
			const resolved = resolveCell(requestAxes(request), selfCounts(root));
			if (!resolved.cell) return blocked(resolved.ask ?? "칸을 정할 수 없어요");
			cells.push(resolved.cell);
		}
		const now = readNeeds(root);
		const audience = sub === "add" ? args.flags.get("--audience")?.trim() || undefined : undefined;
		if (cells.length === 0 && !(audience && now.length > 0)) return failed("--cell 또는 --request가 필요해요(--audience만 쓰려면 칸이 먼저 정해져 있어야 해요)");
		writeNeeds(root, ALL_CELLS.filter(id => (sub === "add" ? [...now, ...cells] : now.filter(c => !cells.includes(c))).includes(id)), audience);
		for (const name of voiceNames(root)) {
			const meta = readMeta(root, name);
			if (meta) refreshProfile(root, meta);
		}
	}
	return done(`니즈(계산하는 칸): ${readNeeds(root).join(", ") || "아직 없음"}`, ...audienceLines(root), ...profiles(root).flatMap(profileLines));
}

export function scopeCommand(root: string, args: Args): Out {
	const sub = args.pos[1] ?? "list";
	if (sub === "list") {
		const targets = readScope(root).targets;
		return done(...(targets.length ? targets.map(t => `[${t.id}] ${t.sentence}`) : ["읽기 범위: 아직 없음"]));
	}
	if (sub === "remove") return removeTarget(root, args.pos[2] ?? "");
	if (sub !== "add") return failed("usage: scope [list | add --type folder|file|url|blog|mail|messages ... | remove <id>]");
	const type = TYPES.find(t => t === args.flags.get("--type"));
	if (!type) return failed(`--type은 ${TYPES.join(" | ")} 중 하나예요`);
	const kind = args.flags.get("--kind") ?? "self";
	if (kind !== "self" && kind !== "other") return failed("--kind는 self(내 글) 또는 other(다른 사람 글)예요");
	return addTarget(root, {
		type,
		kind,
		asked: args.flags.has("--asked"),
		...(args.flags.has("--voice") ? { voice: args.flags.get("--voice") } : {}),
		...(args.flags.has("--path") ? { path: args.flags.get("--path") } : {}),
		...(args.flags.has("--url") ? { url: args.flags.get("--url") } : {}),
		...(args.flags.has("--account") ? { account: args.flags.get("--account") } : {}),
		...(args.flags.has("--limit") ? { limit: args.flags.get("--limit") } : {}),
	});
}
