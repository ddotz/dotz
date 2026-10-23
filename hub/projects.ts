// Stored project records (docs/layers.md §4): what the owner edited on a project page, keyed by the web's project key
// (`ch:<id>` or `dir:<path>`). A record overrides the derived title and purpose; no file means today's behaviour.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, now, writeAtomic } from "./config.ts";
import { setSetupPurpose } from "./workchannels.ts";

type Milestone = { text: string; done: boolean };
export type ProjectRecord = { title?: string; purpose?: string; goal?: string; milestones?: Milestone[]; paused?: boolean; updated: string };

export const MAX_TITLE = 40;
export const MAX_MILESTONES = 30;
const KEY = /^(ch:\d+|dir:.+)$/;
const FIELD_MAX = { purpose: 500, goal: 500, milestone: 200 };
const file = () => join(DATA_DIR, "projects.json");

export function loadProjects(): Record<string, ProjectRecord> {
	if (!existsSync(file())) return {};
	try {
		const j = JSON.parse(readFileSync(file(), "utf8"));
		return j && typeof j.projects === "object" && j.projects ? j.projects : {};
	} catch {
		return {};
	}
}

const text = (v: unknown, name: string, max: number): string => {
	if (typeof v !== "string") throw new Error(`${name} must be a string`);
	const t = v.trim();
	if (t.length > max) throw new Error(`${name} must be at most ${max} characters`);
	return t;
};

function milestones(v: unknown): Milestone[] {
	if (!Array.isArray(v)) throw new Error("milestones must be a list of {text, done}");
	if (v.length > MAX_MILESTONES) throw new Error(`at most ${MAX_MILESTONES} milestones`);
	return v.map((m, i) => {
		if (!m || typeof m !== "object") throw new Error(`milestones[${i}] must be {text, done}`);
		const t = text((m as any).text, `milestones[${i}].text`, FIELD_MAX.milestone);
		if (!t) throw new Error(`milestones[${i}].text is empty`);
		return { text: t, done: (m as any).done === true };
	});
}

// A deleted project loses its record too (hub/projectdelete.ts). Returns whether there was one.
export function removeProject(key: string): boolean {
	const all = loadProjects();
	if (!(key in all)) return false;
	delete all[key];
	writeAtomic(file(), `${JSON.stringify({ projects: all }, null, 2)}\n`);
	return true;
}

// An empty string clears title/purpose/goal (the derived value shows again); fields not given are kept.
export function saveProject(input: Record<string, unknown>): { key: string; record: ProjectRecord } {
	const key = typeof input.key === "string" ? input.key.trim() : "";
	if (!KEY.test(key)) throw new Error("key must be ch:<id> or dir:<path>");
	const all = loadProjects();
	const next: ProjectRecord = { ...all[key], updated: now() };
	for (const [name, max] of [["title", MAX_TITLE], ["purpose", FIELD_MAX.purpose], ["goal", FIELD_MAX.goal]] as const) {
		if (input[name] === undefined) continue;
		const t = text(input[name], name, max);
		if (t) next[name] = t;
		else delete next[name];
	}
	if (input.milestones !== undefined) next.milestones = milestones(input.milestones);
	if (input.paused !== undefined) {
		if (typeof input.paused !== "boolean") throw new Error("paused must be true or false");
		next.paused = input.paused;
	}
	all[key] = next;
	writeAtomic(file(), `${JSON.stringify({ projects: all }, null, 2)}\n`);
	if (key.startsWith("ch:") && next.purpose) setSetupPurpose(key.slice(3), next.purpose);
	return { key, record: next };
}
