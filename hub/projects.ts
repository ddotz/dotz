// Stored project records (docs/layers.md §4): what the owner edited on a project page, keyed by the web's project key
// (`ch:<id>` or `dir:<path>`). A record overrides the derived title and purpose; no file means today's behaviour.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, now, splitThinking, THINKING_LEVELS, writeAtomic } from "./config.ts";
import * as discord from "./discord.ts";
import { titleProblem } from "./lanegates.ts";
import { availableModels, type ModelInfo } from "./providers.ts";
import { clearChannel, setSetupPurpose, setupChannel } from "./workchannels.ts";

// A record saved before the project page lost its 단계 can still hold goal and milestones: they stay in the file, nothing reads them, and a write that sends them is ignored.
export type ProjectRecord = { title?: string; purpose?: string; paused?: boolean; updated: string };

export const MAX_TITLE = 40;
const KEY = /^(ch:\d+|dir:.+)$/;
const MAX_PURPOSE = 500;
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

// A deleted project loses its record too (hub/projectdelete.ts). Returns whether there was one.
export function removeProject(key: string): boolean {
	const all = loadProjects();
	if (!(key in all)) return false;
	delete all[key];
	writeAtomic(file(), `${JSON.stringify({ projects: all }, null, 2)}\n`);
	return true;
}

// An empty string clears title/purpose (the derived value shows again); fields not given are kept.
export function saveProject(input: Record<string, unknown>): { key: string; record: ProjectRecord } {
	const key = typeof input.key === "string" ? input.key.trim() : "";
	if (!KEY.test(key)) throw new Error("key must be ch:<id> or dir:<path>");
	const all = loadProjects();
	const next: ProjectRecord = { ...all[key], updated: now() };
	for (const [name, max] of [["title", MAX_TITLE], ["purpose", MAX_PURPOSE]] as const) {
		if (input[name] === undefined) continue;
		const t = text(input[name], name, max);
		if (t) next[name] = t;
		else delete next[name];
	}
	if (input.paused !== undefined) {
		if (typeof input.paused !== "boolean") throw new Error("paused must be true or false");
		next.paused = input.paused;
	}
	all[key] = next;
	writeAtomic(file(), `${JSON.stringify({ projects: all }, null, 2)}\n`);
	if (key.startsWith("ch:") && next.purpose) setSetupPurpose(key.slice(3), next.purpose);
	return { key, record: next };
}

export class ProjectCreateError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export type CreateDeps = {
	createChannel: (name: string) => Promise<{ id: string; name: string }>;
	removeChannel: (id: string) => Promise<void>;
	models: () => Promise<ModelInfo[]>;
	resolveModel: (input: string, available: ModelInfo[]) => string;
	applyModel: (key: string, model: string) => Promise<unknown>;
};

export const createDeps = (applyModel: CreateDeps["applyModel"], resolveModel: CreateDeps["resolveModel"]): CreateDeps => ({ createChannel: discord.createWorkChannel, removeChannel: discord.deleteWorkChannel, models: availableModels, resolveModel, applyModel });

const field = (v: unknown, name: string, max: number): string => {
	if (v === undefined) return "";
	if (typeof v !== "string") throw new ProjectCreateError(400, `${name}은 글자로 보내 주세요`);
	const t = v.trim();
	if (t.length > max) throw new ProjectCreateError(400, `${name}은 ${max}자까지 쓸 수 있어요`);
	return t;
};

async function modelProblem(input: string, deps: CreateDeps): Promise<string | undefined> {
	const { model, thinking } = splitThinking(input);
	if (thinking && !(THINKING_LEVELS as readonly string[]).includes(thinking)) return `생각 수준은 ${THINKING_LEVELS.join(", ")} 중 하나여야 해요`;
	try {
		deps.resolveModel(model, await deps.models());
		return undefined;
	} catch (error) {
		return `쓸 수 없는 모델이에요: ${(error as Error).message}`;
	}
}

/**
 * A new project, the way `dotz_channel create` makes one: a work channel (a web-only local one with Discord off), its setup (so the purpose reaches the
 * project's conversation) and its record. Everything is checked before the channel exists; the model, applied last, is undone with the rest if it fails.
 * `byAgent` holds an agent's call to the plain-words title rule (hub/lanegates.ts titleProblem); the owner names a project as they like.
 */
export async function createProject(input: Record<string, unknown>, deps: CreateDeps, byAgent = true): Promise<{ key: string; title: string }> {
	const title = field(input.title, "이름", MAX_TITLE);
	if (!title) throw new ProjectCreateError(400, "프로젝트 이름을 적어 주세요");
	if (byAgent && titleProblem(title)) throw new ProjectCreateError(400, "이름이 코드명 같아요. 하려는 일을 쉬운 말 2~4개로 적어 주세요 (예: 디스코드 설정)");
	const purpose = field(input.purpose, "목적", MAX_PURPOSE);
	const model = field(input.model, "모델", 200);
	if (discord.status.enabled && !discord.channels.workCategory) throw new ProjectCreateError(409, "디스코드 작업 카테고리가 아직 없어요. 설정에서 디스코드 연결을 마치거나, 디스코드를 끄고 다시 만들어 주세요");
	const bad = model ? await modelProblem(model, deps) : undefined;
	if (bad) throw new ProjectCreateError(400, bad);
	const channel = await deps.createChannel(title).catch((e: Error) => {
		throw new ProjectCreateError(/discord not configured/.test(e.message) ? 409 : 502, `채널을 만들지 못했어요: ${e.message}`);
	});
	const key = `ch:${channel.id}`;
	try {
		if (purpose) setupChannel({ channel: key, purpose }, channel.name, "");
		saveProject({ key, title, ...(purpose ? { purpose } : {}) });
		if (model) await deps.applyModel(key, model);
	} catch (error) {
		removeProject(key);
		clearChannel(key);
		await deps.removeChannel(channel.id).catch(e => {
			throw new ProjectCreateError(500, `${(error as Error).message}. 만든 채널도 지우지 못했어요(${(e as Error).message}): ${key}`);
		});
		throw error;
	}
	return { key, title };
}
