// What a project stands at (docs/layers.md §4): summary, decisions, next steps, blockers, results, key files and the owner's preferences in that
// project, keyed by `ch:<id>`, kept current by the project's own turns. A turn ends its answer with a <project-info> block (MODE.md); the gateway
// takes the block out of the answer (hub/tone.ts) and merges it here, so no extra model call and no tool round trip, on every runtime.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, log, now, writeAtomic } from "./config.ts";
import { PROJECT_INFO_BLOCK } from "./tone.ts";

type Item = { text: string; at: string };
export type ProjectInfo = { summary?: string; decided: Item[]; next: string[]; blocked: string[]; results: Item[]; files: { label: string; path: string; at: string }[]; prefs: Item[]; updated: string };

const MAX = { line: 200, summary: 240, decided: 30, next: 8, blocked: 8, results: 20, files: 12, prefs: 12 };
// What a turn hands the next one, in characters: this goes into every message of the project.
const CONTEXT_MAX = { state: 300, prefs: 400 };
// The page is read by the owner: a line that carries a path, a link or a file name is not an owner's sentence (a file goes in a `file:` line).
const TECH = /https?:\/\/|(?:^|[\s("'])~?\/[\w.-]+\/|\b[\w-]+\/[\w.-]+\.\w{1,5}\b|\b[\w-]+\.(?:md|ts|js|json|toml|ya?ml|sh|py|html|css)\b|`/i;
const file = () => join(DATA_DIR, "project-info.json");

export function loadProjectInfo(): Record<string, ProjectInfo> {
	if (!existsSync(file())) return {};
	try {
		const j = JSON.parse(readFileSync(file(), "utf8"));
		return j && typeof j === "object" ? j : {};
	} catch (e) {
		log(`project-info.json unreadable: ${(e as Error).message}`);
		return {};
	}
}
const save = (all: Record<string, ProjectInfo>) => writeAtomic(file(), `${JSON.stringify(all, null, 2)}\n`);

const EMPTY: Omit<ProjectInfo, "updated"> = { decided: [], next: [], blocked: [], results: [], files: [], prefs: [] };
const added = (list: Item[], text: string, at: string, max: number): Item[] => (list.some(x => x.text === text) ? list : [...list, { text, at }].slice(-max));

// One block merged into a project's info. summary replaces; decided, result, file and pref add; the block's next (or blocked) lines replace that
// list, and a bare `next:` empties it; drop takes back a decision or preference that no longer holds.
export function mergeProjectInfo(cur: ProjectInfo | undefined, body: string, at: string): ProjectInfo {
	const info: ProjectInfo = { ...EMPTY, ...cur, updated: cur?.updated ?? at };
	const replaced = new Set<"next" | "blocked">();
	for (const raw of body.split("\n")) {
		const m = /^\s*(?:[-*]\s+)?(summary|decided|next|blocked|result|file|pref|drop)\s*:\s*(.*)$/i.exec(raw);
		if (!m) continue;
		const field = m[1]!.toLowerCase(), value = m[2]!.trim();
		if (field === "file") {
			const [label, path] = value.includes("|") ? value.split("|").map(s => s.trim()) : [value.split("/").pop(), value];
			if (!label || !path || TECH.test(label) || !/^[~/]/.test(path)) { log(`project info: file line skipped: ${value.slice(0, 80)}`); continue; }
			const full = path.replace(/^~(?=\/)/, homedir());
			info.files = [...info.files.filter(f => f.path !== full), { label: label.slice(0, MAX.line), path: full, at }].slice(-MAX.files);
			continue;
		}
		if (TECH.test(value)) { log(`project info: ${field} line skipped: ${value.slice(0, 80)}`); continue; }
		const text = value.slice(0, field === "summary" ? MAX.summary : MAX.line);
		if (field === "next" || field === "blocked") {
			if (!replaced.has(field)) { info[field] = []; replaced.add(field); }
			if (text) info[field] = [...info[field], text].slice(0, MAX[field]);
		} else if (!text) continue;
		else if (field === "summary") info.summary = text;
		else if (field === "decided") info.decided = added(info.decided, text, at, MAX.decided);
		else if (field === "result") info.results = added(info.results, text, at, MAX.results);
		else if (field === "pref") info.prefs = added(info.prefs, text, at, MAX.prefs);
		else {
			info.decided = info.decided.filter(x => x.text !== text);
			info.prefs = info.prefs.filter(x => x.text !== text);
		}
	}
	return info;
}

// Every <project-info> block of an answer merged into the project's info. True when the info changed (the same block twice changes nothing).
export function recordProjectInfo(key: string, text: string, at = now()): boolean {
	if (!text.includes("<project-info>")) return false;
	const all = loadProjectInfo(), cur = all[key];
	let next = cur;
	for (const m of text.matchAll(PROJECT_INFO_BLOCK)) next = mergeProjectInfo(next, m[1]!, at);
	const facts = (i?: ProjectInfo) => (i ? JSON.stringify({ ...i, updated: 0 }) : JSON.stringify({ ...EMPTY, updated: 0 }));
	if (facts(next) === facts(cur)) return false;
	all[key] = { ...next!, updated: at };
	save(all);
	return true;
}

// The key files the page opens: /api/file lets them out the way it does a file a message listed (the data dir's private folders stay shut).
export const projectFiles = (): string[] => Object.values(loadProjectInfo()).flatMap(i => i.files.map(f => f.path));

// A deleted project loses its info too (hub/projectdelete.ts).
export function removeProjectInfo(key: string): void {
	const all = loadProjectInfo();
	if (!(key in all)) return;
	delete all[key];
	save(all);
}

const fit = (lines: string[], max: number) => {
	let used = 0;
	return lines.filter(l => (used += l.length + 2) <= max);
};

// The lines every message of a project carries (hub/workchannels.ts channelContext): where it stands and what the owner wants, newest preference
// first, then the reminder to keep it current. This is how a preference reaches the next session, a compaction or a restart included.
export function projectInfoContext(key: string): string {
	const info = loadProjectInfo()[key];
	const state = info ? fit([info.summary ? `now: ${info.summary}` : "", ...info.blocked.map(x => `blocked: ${x}`), ...info.next.map(x => `next: ${x}`)].filter(Boolean), CONTEXT_MAX.state) : [];
	const prefs = info ? fit(info.prefs.map(x => x.text).toReversed(), CONTEXT_MAX.prefs) : [];
	return [
		state.length ? `Project info: ${state.join("; ")}.` : "",
		prefs.length ? `Owner preferences here: ${prefs.join("; ")}.` : "",
		"If this turn settled something, end the answer with a <project-info> block.",
	].filter(Boolean).join(" ");
}
