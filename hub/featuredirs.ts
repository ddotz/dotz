// Feature folders: <repo>/features/<id>/ (shipped with dotz) and <DATA_DIR>/features/<id>/ (the owner's own), each with
// feature.md (+ optional watch.json, schedule.json).
//   feature.md  frontmatter: name, what (one line), trigger (one of TRIGGERS), stage (harness node id), enabled (default true),
//               applies_to (orchestrator|lanes|workers|all, default all), deny: list of "- <regex> | <reason>".
//               The body is advisory text that goes into the prompt after RULES.md.
//   watch.json / schedule.json  same shape as one watch / one schedule the gateway already accepts.
// Pure fs + data (no gateway config import) so the omp extension can load it too. Cached per folder by file mtimes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const TRIGGERS = ["메시지 도착", "정해진 시각", "변화 감지", "도구 실행 직전", "워커 생성 시", "턴 끝", "답장 전송 전", "항상(프롬프트)"] as const;
export const APPLIES = ["orchestrator", "lanes", "workers", "all"] as const;
export type Applies = (typeof APPLIES)[number];
export type FeatureDir = {
	id: string;
	name: string;
	what: string;
	trigger: string;
	stage: string;
	enabled: boolean;
	appliesTo: Applies;
	deny: { pattern: string; reason: string; line: number }[];
	body: string;
	file: string; // absolute feature.md
	origin: "shipped" | "personal";
	watch?: Record<string, any>;
	schedule?: Record<string, any>;
};
export type Loaded = { features: FeatureDir[]; skipped: { id: string; reason: string }[] };

// Two roots: `features/` in this repo ships with dotz for every user ("shipped"); <DATA_DIR>/features is this owner's own
// ("personal": machine/person-specific rules such as which machine handles mail). Owner-specific content never goes in the repo root.
export const SHIPPED_ROOT = join(import.meta.dir, "..", "features");
export const featuresRoot = (dataDir: string) => join(dataDir, "features");
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DENY_ITEM = /^(.+)\s+\|\s+(.+?)$/;

function parse(text: string): { meta: Record<string, string>; deny: { pattern: string; reason: string; line: number }[]; body: string; badDeny: number } | string {
	const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) return "frontmatter (--- … ---) 가 없어요";
	const meta: Record<string, string> = {};
	const deny: { pattern: string; reason: string; line: number }[] = [];
	let badDeny = 0;
	const lines = m[1].split("\n");
	let inDeny = false;
	lines.forEach((raw, i) => {
		const line = raw.replace(/\r$/, "");
		if (inDeny) {
			const item = /^\s+-\s+(.*\S)\s*$/.exec(line);
			if (item) {
				const d = DENY_ITEM.exec(item[1]);
				if (d) deny.push({ pattern: d[1].trim(), reason: d[2].trim(), line: i + 2 });
				else badDeny++;
				return;
			}
			if (!line.trim()) return;
			inDeny = false;
		}
		const kv = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!kv) return;
		if (kv[1] === "deny") {
			inDeny = true;
			return;
		}
		meta[kv[1]] = kv[2].trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
	});
	return { meta, deny, body: text.slice(m[0].length).trim(), badDeny };
}

function readJson(file: string, what: string): Record<string, any> | undefined {
	if (!existsSync(file)) return undefined;
	let v: unknown;
	try {
		v = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(`${what} 이(가) 올바른 JSON 이 아니에요`);
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} 은(는) JSON 객체 하나여야 해요`);
	return v as Record<string, any>;
}

function loadOne(dir: string, id: string, origin: FeatureDir["origin"]): FeatureDir | string {
	if (!ID.test(id)) return "폴더 이름은 [a-z0-9-] (최대 40자) 여야 해요";
	const file = join(dir, id, "feature.md");
	if (!existsSync(file)) return "feature.md 가 없어요";
	const p = parse(readFileSync(file, "utf8"));
	if (typeof p === "string") return p;
	const { meta } = p;
	for (const k of ["name", "what", "trigger", "stage"]) if (!meta[k]) return `${k} 가 비어 있어요`;
	if (!(TRIGGERS as readonly string[]).includes(meta.trigger)) return `trigger "${meta.trigger}" 은(는) 목록에 없어요 (${TRIGGERS.join(" | ")})`;
	const applies = (meta.applies_to || "all") as Applies;
	if (!APPLIES.includes(applies)) return `applies_to "${meta.applies_to}" 은(는) ${APPLIES.join(" | ")} 중 하나여야 해요`;
	if (meta.enabled !== undefined && !/^(true|false)$/.test(meta.enabled)) return `enabled 는 true 또는 false 여야 해요 (지금 "${meta.enabled}")`;
	const deny = p.deny.filter(d => {
		try {
			new RegExp(d.pattern, "i");
			return true;
		} catch {
			return false;
		}
	});
	let watch: Record<string, any> | undefined;
	let schedule: Record<string, any> | undefined;
	try {
		watch = readJson(join(dir, id, "watch.json"), "watch.json");
		schedule = readJson(join(dir, id, "schedule.json"), "schedule.json");
	} catch (e) {
		return (e as Error).message;
	}
	return { id, name: meta.name, what: meta.what, trigger: meta.trigger, stage: meta.stage, enabled: meta.enabled !== "false", appliesTo: applies, deny, body: p.body, file, origin, ...(watch ? { watch } : {}), ...(schedule ? { schedule } : {}) };
}

type Entry = { sig: string; feature?: FeatureDir; reason?: string };
const cache = new Map<string, Entry>();
const mt = (p: string) => {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
};

// Every folder under the shipped root and <dataDir>/features. A personal folder with the same id replaces the shipped one
// (copy it and edit, e.g. `enabled: false`). Malformed ones are listed in `skipped` (reported once per change through `warn`).
export function loadFeatureDirs(dataDir: string, warn?: (msg: string) => void): Loaded {
	const byId = new Map<string, FeatureDir>(), skipped = new Map<string, { id: string; reason: string }>();
	for (const [root, origin] of [[SHIPPED_ROOT, "shipped"], [featuresRoot(dataDir), "personal"]] as const) {
		let names: string[] = [];
		try {
			names = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort();
		} catch {
			continue;
		}
		for (const id of names) {
			const key = join(root, id);
			const sig = ["feature.md", "watch.json", "schedule.json"].map(f => mt(join(key, f))).join(":");
			let e = cache.get(key);
			if (!e || e.sig !== sig) {
				let r: FeatureDir | string;
				try {
					r = loadOne(root, id, origin);
				} catch (err) {
					r = `읽지 못했어요: ${err}`;
				}
				e = typeof r === "string" ? { sig, reason: r } : { sig, feature: r };
				cache.set(key, e);
				if (e.reason) warn?.(`${origin} feature folder ${id} skipped: ${e.reason}`);
			}
			if (e.feature) { byId.set(id, e.feature); skipped.delete(id); }
			else skipped.set(id, { id, reason: `${origin === "shipped" ? "배포용" : "개인용"}: ${e.reason!}` });
		}
	}
	return { features: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), skipped: [...skipped.values()] };
}

const CAP = 12_000;
// Enabled bodies for one audience, one heading per feature, cut like the RULES.md block (marker names where to read the rest).
export function featurePrompt(dataDir: string, role: "orchestrator" | "lanes", warn?: (msg: string) => void, max = CAP): string {
	const mine = loadFeatureDirs(dataDir, warn).features.filter(f => f.enabled && f.body && (f.appliesTo === "all" || f.appliesTo === role || (role === "lanes" && f.appliesTo === "workers")));
	if (!mine.length) return "";
	const text = mine.map(f => `### ${f.name} (${f.file}${f.appliesTo === "workers" ? "; pass this to your task workers in their briefs" : ""})\n${f.body}`).join("\n\n");
	const body = text.length > max ? `${text.slice(0, max)}\n[... cut at ${max} characters; read the feature.md named in each heading for the rest]` : text;
	return `## Features (shipped ones from ${SHIPPED_ROOT}, the owner's own from ${featuresRoot(dataDir)}; same weight as the owner rules above)\n\n${body}`;
}

// Same matching as the RULES.md "- deny:" lines (case-insensitive regex on the whole command).
export function blockedByFeatures(dataDir: string, command: string, warn?: (msg: string) => void): { reason: string; id: string } | undefined {
	for (const f of loadFeatureDirs(dataDir, warn).features) {
		if (!f.enabled) continue;
		for (const d of f.deny) if (new RegExp(d.pattern, "i").test(command)) return { reason: d.reason, id: f.id };
	}
	return undefined;
}

