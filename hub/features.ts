// "기능 목록" backend (read-only): everything the owner added to the harness, inventoried at runtime by how it is implemented,
// and placed on the harness map (hub/harness.ts node ids). Switches are changed by the main orchestrator on the owner's
// request, never here. No model calls; every source is a file or in-memory table this
// process already has, and a missing source is skipped.
//   strength "enforced": code, a hook or a deny line stops/does it whether the model agrees or not
//   strength "advisory": text the model is asked to follow (RULES, LESSONS, identity, skills)
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg, DATA_DIR, HOME, IDENTITY_FILE, log, paths } from "./config.ts";
import { loadFeatureDirs, TRIGGERS } from "./featuredirs.ts";
import { harnessGraph, type HarnessNode } from "./harness.ts";
import { lang } from "./i18n.ts";
import { listSchedules } from "./schedule.ts";
import { summarize } from "./summaries.ts";
import { addWatch, allWatches, removeWatch } from "./watch.ts";
import { listSetups } from "./workchannels.ts";

export const FORMS = ["글 지시", "차단 명령", "기능 폴더", "스킬", "omp 확장", "예약", "감시", "작업 채널 설정", "게이트웨이 기능", "외부 연동"] as const;
export { TRIGGERS };
export type Form = (typeof FORMS)[number];
export type Trigger = (typeof TRIGGERS)[number];
export type Strength = "enforced" | "advisory";
export type Feature = {
	id: string;
	form: Form;
	name: string;
	what: string;
	summary?: string; // two-line summary of what (and of name, when titled) in the user's main language, from hub/summaries.ts
	titled?: boolean; // the summary's first line is the name (the original name is not in the user's language)
	trigger: Trigger;
	stage: string; // harness node id
	strength: Strength;
	source: { label: string; file?: string; line?: number }; // file = a name the 구성 file editor can open
	extra?: string; // monospace detail (a deny regex)
	added?: string; // the "[10-17]" tag on a rule line
	lastRun?: string;
	enabled: boolean;
	toggleable: boolean;
	dup?: { id: string; name: string }[];
	origin?: "shipped" | "personal"; // shipped: comes with dotz for every user; personal: this owner's own files and settings
};
// Owner files (RULES/LESSONS/identity, RULES deny lines, schedules, watches, channel setups) and anything under the home
// directory (skills, omp extensions) are personal, unless it is dotz's own checkout (its extension is linked from there);
// dotz's own code, built-in denies and repo files ship with dotz.
const originOf = (f: Feature): "shipped" | "personal" =>
	f.form === "글 지시" || f.form === "예약" || f.form === "감시" || f.form === "작업 채널 설정" || f.id.startsWith("deny-") || (f.source.label.startsWith("~") && !inRepo(f.source.label)) ? "personal" : "shipped";

const REPO = join(import.meta.dir, "..");
const short = (p: string) => (p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p.startsWith(`${REPO}/`) ? p.slice(REPO.length + 1) : p);
// A "~/..." source label that points into a dotz checkout (the omp extension link resolves to <checkout>/extension/).
function inRepo(label: string): boolean {
	try {
		const real = realpathSync(`${HOME}${label.replace(/:\d+$/, "").slice(1)}`);
		return existsSync(join(dirname(real), "..", "hub", "features.ts"));
	} catch {
		return false;
	}
}
const read = (p: string): string | undefined => {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const firstSentence = (s: string, n = 120) => clip(s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0], n);
const clean = (s: string) => s.replace(/\*\*|`/g, "").trim();

// ---- 글 지시: RULES.md / LESSONS.md / identity ---------------------------------------------------------------------
const DENY = /^- deny:\s*(.+)\s+\|\s+(.+?)\s*$/;
const TAG = /^\[([^\]]+)\]\s*/;

type Bullet = { text: string; line: number; section: string };
function bullets(text: string, skipSection?: RegExp): Bullet[] {
	const out: Bullet[] = [];
	let section = "";
	text.split("\n").forEach((raw, i) => {
		if (/^#{1,6}\s/.test(raw)) section = raw.replace(/^#+\s*/, "").trim();
		else if (/^- /.test(raw) && !(skipSection && skipSection.test(section))) out.push({ text: raw.slice(2).trim(), line: i + 1, section });
	});
	return out;
}

function textFeatures(fileName: string, file: string, stage: string, label: string, skipSection?: RegExp): Feature[] {
	const text = read(file);
	if (text === undefined) return [];
	const key = fileName.replace(/\.md$/i, "").replace(/^.*\//, "").toLowerCase();
	return bullets(text, skipSection).map(b => {
		let body = b.text;
		let added: string | undefined;
		const tag = TAG.exec(body);
		if (tag) {
			added = tag[1];
			body = body.slice(tag[0].length);
		}
		body = clean(body);
		const kv = /^([A-Za-z][\w ]{0,19}):\s+(.+)$/.exec(body); // identity "Name: ..." lines
		// A short first sentence is the name and the rest is the description; a long one is cut for the name and kept whole below.
		const first = firstSentence(body, 400);
		const fits = !kv && first.length <= 40;
		const name = kv ? kv[1] : fits ? first : clip(first, 36);
		return {
			id: `${key}-${b.line}`,
			form: "글 지시" as const,
			name,
			what: kv ? clip(kv[2], 150) : fits ? clip(body.slice(first.length).trim(), 150) : clip(body, 150),
			trigger: "항상(프롬프트)" as const,
			stage,
			strength: "advisory" as const,
			source: { label: `${label}:${b.line}`, file: fileName, line: b.line },
			...(added ? { added } : {}),
			enabled: true,
			toggleable: false,
		};
	});
}

function identityFeatures(): Feature[] {
	if (existsSync(IDENTITY_FILE)) return textFeatures("identity/IDENTITY.md", IDENTITY_FILE, "identity", "identity/IDENTITY.md");
	const id = cfg.identity ?? { name: "" };
	return (["character", "tone"] as const).filter(k => id[k]).map(k => ({
		id: `identity-${k}`, form: "글 지시" as const, name: k === "character" ? "성격" : "말투", what: clip(clean(String(id[k])), 150), trigger: "항상(프롬프트)" as const, stage: "identity",
		strength: "advisory" as const, source: { label: `config.json:identity.${k}` }, enabled: true, toggleable: false,
	}));
}

// ---- 차단 명령 -----------------------------------------------------------------------------------------------------
function denyFeatures(): Feature[] {
	const out: Feature[] = [];
	const rules = read(paths.rules);
	if (rules !== undefined) {
		let inSection = false;
		rules.split("\n").forEach((raw, i) => {
			if (/^#{1,6}\s/.test(raw)) inSection = /^##\s+Blocked commands\s*$/.test(raw);
			const m = inSection ? DENY.exec(raw) : null;
			if (!m) return;
			let bad = false;
			try {
				new RegExp(m[1], "i");
			} catch {
				bad = true;
			}
			out.push({
				id: `deny-${i + 1}`, form: "차단 명령", name: clip(m[2], 40), what: bad ? `정규식이 잘못돼서 무시돼요 · ${clip(m[2], 100)}` : `실행 전에 막아요 (오케스트레이터·레인·작업자) · ${clip(m[2], 110)}`,
				trigger: "도구 실행 직전", stage: "guard", strength: "enforced", source: { label: `RULES.md:${i + 1}`, file: "RULES.md", line: i + 1 }, extra: m[1], enabled: !bad, toggleable: false,
			});
		});
	}
	// dotz's own built-in denies live in hub/systemdeny.ts (SYSTEM_DENY), shared by every runtime's guard
	const ext = join(REPO, "hub", "systemdeny.ts");
	const src = read(ext)?.split("\n") ?? [];
	let on = false;
	src.forEach((raw, i) => {
		if (/const SYSTEM_DENY\b/.test(raw)) on = true;
		else if (on && /^\];/.test(raw)) on = false;
		const m = on ? /^\s*\[\/(.+)\/[a-z]*,\s*"([^"]+)"\],?\s*$/.exec(raw) : null;
		if (m) out.push({ id: `sysdeny-${i + 1}`, form: "차단 명령", name: clip(m[2], 40), what: `dotz 기본 차단 · ${clip(m[2], 110)}`, trigger: "도구 실행 직전", stage: "guard", strength: "enforced", source: { label: `hub/systemdeny.ts:${i + 1}` }, extra: m[1], enabled: true, toggleable: false });
	});
	return out;
}

// ---- 스킬 ----------------------------------------------------------------------------------------------------------
// Roots omp scans (omp://skills.md): one level, <root>/<name>/SKILL.md. Same real path or same name counts once.
function skillRoots(): string[] {
	const roots = [join(HOME, ".omp", "agent", "skills"), join(HOME, ".omp", "agent", "managed-skills"), join(HOME, ".agents", "skills"), join(HOME, ".claude", "skills")];
	for (let d = process.cwd(); d !== dirname(d) && d !== HOME; d = dirname(d)) roots.unshift(join(d, ".omp", "skills"));
	return roots;
}

function frontmatter(text: string): Record<string, string> {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const out: Record<string, string> = {};
	if (!m) return out;
	const lines = m[1].split("\n");
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
		if (!kv) continue;
		let v = kv[2].trim();
		if (/^[>|][+-]?$/.test(v)) {
			const parts: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
			v = parts.join(" ");
		}
		out[kv[1]] = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
	}
	return out;
}

function skillFeatures(): Feature[] {
	const out: Feature[] = [];
	const seenPath = new Set<string>(), seenName = new Set<string>();
	for (const root of skillRoots()) {
		let dirs: string[];
		try {
			dirs = readdirSync(root).filter(d => !d.startsWith(".")).sort();
		} catch {
			continue;
		}
		for (const d of dirs) {
			const file = join(root, d, "SKILL.md");
			let real: string;
			try {
				real = realpathSync(file);
			} catch {
				continue;
			}
			const text = read(real);
			if (text === undefined || seenPath.has(real)) continue;
			const fm = frontmatter(text);
			const name = fm.name || d;
			if (seenName.has(name)) continue;
			seenPath.add(real); seenName.add(name);
			out.push({
				id: `skill-${name}`, form: "스킬", name, what: firstSentence(fm.description || "설명이 없어요", 130), trigger: "항상(프롬프트)", stage: "orchestrator", strength: "advisory",
				source: { label: short(file), line: 1 }, enabled: true, toggleable: false,
			});
		}
	}
	return out;
}

// ---- omp 확장 ------------------------------------------------------------------------------------------------------
const headerOf = (src: string): string => {
	const lines: string[] = [];
	for (const l of src.split("\n")) {
		if (l.startsWith("#!")) continue;
		const m = /^\/\/\s?(.*)$/.exec(l);
		if (!m) break;
		lines.push(m[1]);
	}
	return lines.join(" ").replace(/\s+/g, " ").trim();
};

// An extension can list its own features with comment lines anywhere in the file, one per feature:
//   // @feature <name> | <what it does> | <trigger, one of TRIGGERS> | <harness node id>
// trigger and node are optional. The line number points at the annotation, so it sits next to the code it describes.
// Without annotations the extension is one card built from its header comment.
const FEATURE_LINE = /^\s*\/\/\s*@feature\s+(.+)$/;
function annotated(lines: string[]): { name: string; what: string; trigger?: Trigger; stage?: string; line: number }[] {
	const out: { name: string; what: string; trigger?: Trigger; stage?: string; line: number }[] = [];
	lines.forEach((l, i) => {
		const m = FEATURE_LINE.exec(l);
		if (!m) return;
		const [name, what = "", trigger = "", stage = ""] = m[1].split("|").map(s => s.trim());
		if (!name) return;
		out.push({ name, what, line: i + 1, ...((TRIGGERS as readonly string[]).includes(trigger) ? { trigger: trigger as Trigger } : {}), ...(stage ? { stage } : {}) });
	});
	return out;
}

const hookTrigger = (src: string): Trigger =>
	/pi\.on\("input"|registerCommand\(|registerTool\(/.test(src) ? "메시지 도착" : /before_subagent_spawn/.test(src) ? "워커 생성 시" : /pi\.on\("tool_call"/.test(src) ? "도구 실행 직전" : "항상(프롬프트)";

function extensionFeatures(): Feature[] {
	const dir = join(HOME, ".omp", "agent", "extensions");
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return [];
	}
	const out: Feature[] = [];
	const card = (id: string, file: string, name: string): void => {
		const src = read(file);
		if (src === undefined) return;
		const lines = src.split("\n");
		// an extension linked to this repo (dotz's own) is labelled by its repo path, which also marks it as shipped
		const real = (() => { try { return realpathSync(file); } catch { return file; } })();
		const label = short(real.startsWith(`${realpathSync(REPO)}/`) ? join(REPO, real.slice(realpathSync(REPO).length + 1)) : file);
		const marked = annotated(lines);
		if (marked.length) {
			for (const f of marked) out.push({ id: `${id}-${f.line}`, form: "omp 확장", name: clip(f.name, 40), what: clip(f.what, 150), trigger: f.trigger ?? hookTrigger(src), stage: f.stage ?? "orchestrator", strength: "enforced", source: { label: `${label}:${f.line}`, line: f.line }, enabled: true, toggleable: false });
			return;
		}
		const header = headerOf(src);
		out.push({ id, form: "omp 확장", name, what: clip(header ? firstSentence(header, 140) : "설명 주석이 없어요", 150), trigger: hookTrigger(src), stage: "orchestrator", strength: "enforced", source: { label: `${label}:1`, line: 1 }, enabled: true, toggleable: false });
	};
	for (const n of names) {
		const p = join(dir, n);
		if (/\.ts$/.test(n)) card(`ext-${n.replace(/\.ts$/, "")}`, p, n.replace(/\.ts$/, ""));
		else {
			// a package directory: package.json#omp.extensions lists its entry files
			let entries: string[] = [];
			try {
				if (statSync(p).isDirectory()) {
					const pkg: unknown = JSON.parse(read(join(p, "package.json")) ?? "{}");
					const list = pkg && typeof pkg === "object" && "omp" in pkg && pkg.omp && typeof pkg.omp === "object" && "extensions" in pkg.omp ? pkg.omp.extensions : [];
					entries = Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
				}
			} catch {}
			for (const e of entries) card(`ext-${n}`, join(p, e), n);
		}
	}
	return out;
}

// ---- 예약 · 감시 · 작업 채널 설정 -----------------------------------------------------------------------------------
const WHEN_FMT: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" };
const hostOf = (u: string) => {
	try {
		return new URL(u).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
};

function scheduleFeatures(): Feature[] {
	return listSchedules().map(s => ({
		id: `sched-${s.id}`, form: "예약" as const, name: clip(s.text.replace(/\s+/g, " "), 34), what: `${s.every_minutes ? `${s.every_minutes}분마다 반복 · 다음 ` : "한 번 · "}${Number.isFinite(Date.parse(s.at)) ? new Date(s.at).toLocaleString("ko-KR", WHEN_FMT) : s.at} 에 이 문장을 오케스트레이터에게 보내요`,
		trigger: "정해진 시각" as const, stage: "schedule", strength: "enforced" as const, source: { label: `${short(paths.schedules)} · ${s.id}` }, enabled: true, toggleable: false,
	}));
}

function watchFeatures(): Feature[] {
	return allWatches().map(w => {
		const login = w.session ? `${hostOf(w.session.url)} 로그인 유지 (${w.session.refresh_hours}시간마다 탭으로 갱신)` : null;
		const on = { change: "값이 바뀌었을 때", match: "조건에 맞을 때", fail: "실패했을 때" }[w.on] ?? w.on;
		const fails = w.state.fails;
		return {
			id: `watch-${w.id}`, form: "감시" as const, name: w.name, what: `${w.every_minutes}분마다 ${login ?? `명령을 실행해서 ${on} 알려요`}${fails >= 2 ? ` · 연속 실패 ${fails}번` : ""}`,
			trigger: "변화 감지" as const, stage: "watch", strength: "enforced" as const, source: { label: `${short(paths.watches)} · ${w.id}` }, ...(w.state.lastRun ? { lastRun: w.state.lastRun } : {}), enabled: true, toggleable: false,
		};
	});
}

function setupFeatures(): Feature[] {
	return listSetups().map(s => ({
		id: `setup-${s.channel}`, form: "작업 채널 설정" as const, name: s.name, what: `${clip(s.purpose, 90)} · 로그인 ${s.logins.length}개 · 감시 ${s.monitors.length}개${s.standing ? " · 상시 작업 있음" : ""}`,
		trigger: "변화 감지" as const, stage: "watch", strength: "enforced" as const, source: { label: `${short(paths.setups)} · ${s.channel}` }, lastRun: s.updated, enabled: true, toggleable: false,
	}));
}

// ---- 게이트웨이 기능 · 외부 연동: the harness nodes themselves (no second copy of their text) ----------------------
type NodeSpec = { form: Form; trigger: Trigger; file: string; toggle?: { path: string } };
const NODE_SPECS: Record<string, NodeSpec> = {
	gateway: { form: "게이트웨이 기능", trigger: "메시지 도착", file: "hub/main.ts" },
	outlang: { form: "게이트웨이 기능", trigger: "답장 전송 전", file: "hub/outlang.ts", toggle: { path: "output_language.mode" } },
	update: { form: "게이트웨이 기능", trigger: "정해진 시각", file: "hub/update.ts", toggle: { path: "omp_update.mode" } },
	audit: { form: "게이트웨이 기능", trigger: "정해진 시각", file: "hub/token-audit.ts", toggle: { path: "token_audit_at" } },
	reflect: { form: "게이트웨이 기능", trigger: "정해진 시각", file: "hub/reflect.ts", toggle: { path: "reflect_at" } },
	backup: { form: "게이트웨이 기능", trigger: "정해진 시각", file: "hub/backup.ts" },
	providers: { form: "게이트웨이 기능", trigger: "워커 생성 시", file: "hub/providers.ts" },
	hygiene: { form: "게이트웨이 기능", trigger: "정해진 시각", file: "hub/hygiene.ts", toggle: { path: "lanes.nightly_at" } },
	memguard: { form: "게이트웨이 기능", trigger: "변화 감지", file: "hub/memguard.ts" },
	discord: { form: "외부 연동", trigger: "메시지 도착", file: "hub/discord.ts" },
	mail: { form: "외부 연동", trigger: "변화 감지", file: "hub/zele.ts", toggle: { path: "zele.enabled" } },
};

const featureIdOf = (nodeId: string) => `${NODE_SPECS[nodeId].form === "외부 연동" ? "int" : "gw"}-${nodeId}`;

function nodeFeatures(nodes: HarnessNode[]): Feature[] {
	const out: Feature[] = [];
	for (const [nodeId, spec] of Object.entries(NODE_SPECS)) {
		const n = nodes.find(x => x.id === nodeId);
		if (!n || !existsSync(join(REPO, spec.file))) continue;
		out.push({
			id: featureIdOf(nodeId), form: spec.form, name: n.label.replace(/\s*\(.*\)$/, ""), what: firstSentence(n.desc), trigger: spec.trigger, stage: nodeId, strength: "enforced",
			source: { label: `${spec.file}${spec.toggle ? ` · config.json:${spec.toggle.path}` : ""}` }, enabled: n.status !== "off", toggleable: !!spec.toggle,
		});
	}
	if (Bun.which("aside") || existsSync(join(REPO, "hub", "aside.ts")))
		out.push({
			id: "int-aside", form: "외부 연동", name: "Aside 브라우저", what: "브라우저가 필요한 일과 로그인 유지를 Aside CLI 로만, 백그라운드 탭으로 해요 (창·앱을 앞으로 가져오지 않아요)", trigger: "변화 감지", stage: "watch", strength: "enforced",
			source: { label: "hub/aside.ts" }, enabled: !!Bun.which("aside"), toggleable: false,
		});
	return out;
}

// ---- advisory <-> enforced duplicates -----------------------------------------------------------------------------
// Normalised keyword overlap: Korean particles are trimmed and a few concept words collapse to one token, so "한도" and
// "예산 게이트" or "브라우저" and "Aside" count as the same thing. A pair is marked at two shared concepts, or one concept plus several shared words.
// Words that appear in nearly every harness sentence say nothing about whether two items cover the same thing.
const STOP = new Set(["형이", "형에게", "해요", "있어요", "않아요", "그리고", "때만", "모든", "대한", "이에요", "에서", "위해", "해서", "하면", "라고", "하는", "같은", "다시", "먼저", "그냥", "항상", "바로", "또는", "레인", "채널", "오케스트레이터", "게이트웨이", "메시지", "작업", "알림", "보고", "결과", "규칙", "상태", "결정", "요청", "시스템", "프로젝트", "대화", "계약", "모델", "작업자", "the", "and", "for", "with", "not", "only", "any", "all", "are", "from", "that", "this", "when", "into"]);
const CONCEPTS: [RegExp, string][] = [
	[/예산|한도|budget|게이트/, "c:예산"],
	[/fable|xhigh|비싼 ?모델|expensive/i, "c:비싼모델"],
	[/한국어|언어|language|출력/, "c:언어"],
	[/aside|브라우저|browser|playwright|chrome/i, "c:브라우저"],
	[/zele|메일|캘린더|mail|calendar/i, "c:메일"],
	[/워커|작업자|worker|subagent|서브에이전트/i, "c:작업자"],
	[/패치|patch/i, "c:패치"],
	[/push|배포|deploy|ssh|외부 ?(명령|전송|영향)/i, "c:외부"],
	[/discord|디스코드/i, "c:discord"],
	[/압축|compact|handover|핸드오버|컨텍스트|context/i, "c:컨텍스트"],
	[/메모리|memory|rss/i, "c:메모리"],
	[/로그인|session|세션 확인/i, "c:로그인"],
	[/예약|schedule|스케줄/i, "c:예약"],
	[/감시|watch|모니터/i, "c:감시"],
	[/백업|backup|스냅샷/i, "c:백업"],
	[/회고|reflect|교훈|lesson/i, "c:회고"],
	[/다시 ?(쓰|써)|번역|rewrite/i, "c:다시쓰기"],
];
function keywords(text: string): Set<string> {
	const t = text.toLowerCase().replace(/\[[^\]]*\]/g, " ");
	const out = new Set<string>();
	for (const [re, c] of CONCEPTS) if (re.test(t)) out.add(c);
	for (const w of t.match(/[a-z][a-z0-9_-]{2,}|[가-힣]{2,}/g) ?? []) {
		const base = /^[가-힣]+$/.test(w) ? w.replace(/(으로는|에서는|이에요|입니다|으로|에서|에게|해요|예요|하고|에는|이고|은|는|이|가|을|를|의|에|도|로|와|과|만)$/, "") : w;
		if (base.length >= 2 && !STOP.has(base) && !STOP.has(w)) out.add(base);
	}
	return out;
}
function markDuplicates(all: Feature[]): void {
	const kw = new Map(all.map(f => [f.id, keywords(`${f.name} ${f.what}`)]));
	const enforced = all.filter(f => f.strength === "enforced");
	for (const a of all.filter(f => f.strength === "advisory" && f.form === "글 지시")) {
		for (const e of enforced) {
			const A = kw.get(a.id)!, E = kw.get(e.id)!;
			let concepts = 0, words = 0;
			for (const k of A) if (E.has(k)) k.startsWith("c:") ? concepts++ : words++;
			if ((concepts >= 1 && concepts * 2 + words >= 5) || concepts >= 2) {
				(a.dup ??= []).push({ id: e.id, name: e.name });
				(e.dup ??= []).push({ id: a.id, name: a.name });
			}
		}
	}
}

// ---- 기능 폴더 -----------------------------------------------------------------------------------------------------
// <DATA_DIR>/features/<id>/feature.md (hub/featuredirs.ts). Text body = advisory; deny lines and a valid watch.json = enforced.
// schedule.json is read but not run yet (addSchedule has no stable id, so a restart would duplicate it).
const dirId = (id: string) => `dir-${id}`;

function dirFeatures(nodeIds: Set<string>): Feature[] {
	const out: Feature[] = [];
	for (const f of loadFeatureDirs(DATA_DIR, log).features) {
		const parts = [f.body ? "글 지시" : "", f.deny.length ? `차단 ${f.deny.length}줄` : "", f.watch ? "감시" : "", f.schedule ? "예약 파일은 아직 실행되지 않아요" : ""].filter(Boolean);
		const stage = nodeIds.has(f.stage) ? f.stage : "rules";
		const src = { label: short(f.file) };
		const enforced = f.deny.length > 0 || Boolean(f.watch);
		out.push({ id: dirId(f.id), form: "기능 폴더", name: f.name, what: `${clip(f.what, 110)}${parts.length ? ` · ${parts.join(" + ")}` : ""}${f.enabled ? "" : " (꺼짐)"}`, trigger: f.trigger as Trigger, stage, strength: enforced ? "enforced" : "advisory", source: src, enabled: f.enabled, toggleable: f.origin === "personal", origin: f.origin });
		f.deny.forEach((d, i) => out.push({ id: `${dirId(f.id)}-deny-${i + 1}`, form: "기능 폴더", name: clip(d.reason, 40), what: `${f.enabled ? "실행 전에 막아요" : "꺼져 있어서 막지 않아요"} (${f.name}) · ${clip(d.reason, 100)}`, trigger: "도구 실행 직전", stage: "guard", strength: "enforced", source: { label: `${short(f.file)}:${d.line}` }, extra: d.pattern, enabled: f.enabled, toggleable: false, origin: f.origin }));
	}
	return out;
}

// A feature folder's watch.json goes through addWatch (the same path as POST /api/watches): added when enabled and not yet
// there (by name), removed when the folder is disabled. Runs at gateway start (a folder the orchestrator flips later takes effect here at the next start).
export function syncFeatureWatches(): void {
	const rules = existsSync(paths.rules) ? readFileSync(paths.rules, "utf8") : "";
	for (const f of loadFeatureDirs(DATA_DIR, log).features) {
		if (!f.watch) continue;
		const name = String(f.watch.name ?? "");
		try {
			const there = allWatches().some(w => w.name === name);
			if (f.enabled && !there) addWatch({ ...f.watch }, rules);
			else if (!f.enabled && there) removeWatch(name);
		} catch (e) {
			log(`feature ${f.id}: watch.json not applied: ${e instanceof Error ? e.message : e}`);
		}
	}
}

// Every card is rewritten in the user's language and the main agent's voice. A card with a name is sent with it
// ("name\nwhat"), and the summary's first line then serves as the name. Summaries come from the cache; missing ones are
// filled in the background and show on the next refresh.
function attachSummaries(features: Feature[]): void {
	const titled = new Set(features.filter(f => f.name.trim() && f.name.trim() !== f.what.trim()).map(f => f.id));
	const known = summarize(features.map(f => ({ key: f.id, text: titled.has(f.id) ? `${f.name}\n${f.what}`.trim() : f.what || f.name })), lang());
	for (const f of features) {
		if (!known[f.id]) continue;
		f.summary = known[f.id];
		if (titled.has(f.id)) f.titled = true;
	}
}

// ---- catalog -------------------------------------------------------------------------------------------------------
export async function featureCatalog() {
	const graph = await harnessGraph({ light: true });
	const nodeIds = new Set(graph.nodes.map(n => n.id));
	const features: Feature[] = [
		...textFeatures("RULES.md", paths.rules, "rules", "RULES.md", /^Blocked commands$/),
		...textFeatures("LESSONS.md", paths.lessons, "lessons", "LESSONS.md"),
		...identityFeatures(),
		...denyFeatures(),
		...dirFeatures(nodeIds),
		...skillFeatures(),
		...extensionFeatures(),
		...scheduleFeatures(),
		...watchFeatures(),
		...setupFeatures(),
		...nodeFeatures(graph.nodes),
	];
	markDuplicates(features);
	for (const f of features) f.origin ??= originOf(f);
	attachSummaries(features);
	return { generated: new Date().toISOString(), forms: FORMS, triggers: TRIGGERS, features, stages: graph.nodes.map(n => n.id), data_dir: short(DATA_DIR), skipped_dirs: loadFeatureDirs(DATA_DIR, log).skipped };
}
