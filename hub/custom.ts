// The owner's custom layer ("웹 맞춤"): home cards, sidebar pins and routines kept as plain files in <DATA_DIR>/custom.
// Everything is read fresh on each request (hot reload); a missing folder is an empty layer. A bad file never throws: it
// comes back as an error entry. Data commands run through watch.ts exec with an in-memory cache; routines are kept as
// `[routine:<id>:<hash6>] ` entries of hub/schedule.ts. customRoute() takes its gateway state as deps so tests can call it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DATA_DIR, expand, HOME, log, TZ } from "./config.ts";
import { addSchedule, listSchedules, removeSchedule } from "./schedule.ts";
import { exec } from "./watch.ts";

export const VIEWS = ["text", "stat", "list", "kv"] as const;
export type View = (typeof VIEWS)[number];
export type CardAction = { label: string; command?: string; prompt?: string; confirm?: boolean };
export type CardSpec = { title: string; note?: string; view: View; text?: string; command?: string; cwd?: string; every_minutes: number; timeout_seconds: number; link?: string; order: number; actions: CardAction[] };
export type CardEntry = { id: string; file: string; error: string } | { id: string; file: string; spec: CardSpec; renderFile?: string; rev: string };
export type PinProject = { name: string; path?: string; channel?: string; note?: string };
export type Routine = { id: string; name: string; prompt: string; target: string; schedule?: { every_minutes: number } | { at: string } };
export type Link = { name: string; url: string };
export type Pins = { projects: PinProject[]; hide_projects: string[]; routines: Routine[]; links: Link[] };
export type CustomError = { file: string; error: string };
export type ProjectLane = { name: string; status: string; live: boolean; startedAt?: string; lastText: string; reports: number; channel?: string };
export type Project = { key: string; name: string; path?: string; note?: string; pinned: boolean; channel?: { id: string; name: string }; lanes: ProjectLane[] };
export type ChannelsIn = { work?: Record<string, string>; homes?: Record<string, string>; lanes?: Record<string, string> };
export type CustomDeps = {
	lanes: () => Array<Record<string, unknown>>;
	channels: () => ChannelsIn;
	send: (target: "main" | `lane:${string}`, text: string, login: string) => Promise<void>;
};

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_CARDS = 30;
const MAX_CARD_BYTES = 16 * 1024;
const MAX_ACTIONS = 4;
const MAX_AUTO_PROJECTS = 12;
const ROUTINE_TAG = /^\[routine:([a-z0-9-]+):([0-9a-f]{6})\] /;

const customDir = () => join(DATA_DIR, "custom");
export const customDirLabel = () => (customDir().startsWith(`${HOME}/`) ? `~${customDir().slice(HOME.length)}` : customDir());
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, min: number, max: number): string | undefined => (typeof v === "string" && v.trim().length >= min && v.trim().length <= max ? v.trim() : undefined);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- cards -----------------------------------------------------------------------------------------------------------
function parseCard(raw: string): CardSpec | string {
	let j: unknown;
	try {
		j = JSON.parse(raw);
	} catch (e) {
		return `JSON을 읽을 수 없어요: ${msg(e)}`;
	}
	if (!isObj(j)) return "카드는 JSON 객체여야 해요";
	const title = str(j.title, 1, 40);
	if (!title) return "title 은 1~40자여야 해요";
	const spec: CardSpec = { title, view: "text", every_minutes: 10, timeout_seconds: 10, order: 0, actions: [] };
	if (j.note !== undefined) {
		if (typeof j.note !== "string" || j.note.length > 120) return "note 는 120자 이하 글이어야 해요";
		spec.note = j.note;
	}
	if (j.view !== undefined) {
		if (!(VIEWS as readonly unknown[]).includes(j.view)) return `view 는 ${VIEWS.join(" | ")} 중 하나여야 해요`;
		spec.view = j.view as View;
	}
	for (const k of ["text", "command", "cwd"] as const) {
		if (j[k] === undefined) continue;
		if (typeof j[k] !== "string") return `${k} 는 글이어야 해요`;
		if (k !== "text" && !(j[k] as string).trim()) return `${k} 가 비어 있어요`;
		spec[k] = j[k] as string;
	}
	if (j.every_minutes !== undefined) {
		if (typeof j.every_minutes !== "number" || !(j.every_minutes >= 1)) return "every_minutes 는 1 이상 숫자여야 해요";
		spec.every_minutes = j.every_minutes;
	}
	if (j.timeout_seconds !== undefined) {
		if (typeof j.timeout_seconds !== "number" || !(j.timeout_seconds >= 1 && j.timeout_seconds <= 60)) return "timeout_seconds 는 1~60 사이 숫자여야 해요";
		spec.timeout_seconds = j.timeout_seconds;
	}
	if (j.link !== undefined) {
		if (typeof j.link !== "string" || !/^(https?:\/\/\S+|#\S+)$/.test(j.link)) return "link 는 http(s) 주소나 #화면 이어야 해요";
		spec.link = j.link;
	}
	if (j.order !== undefined) {
		if (typeof j.order !== "number" || !Number.isFinite(j.order)) return "order 는 숫자여야 해요";
		spec.order = j.order;
	}
	if (j.actions !== undefined) {
		if (!Array.isArray(j.actions) || j.actions.length > MAX_ACTIONS) return `actions 는 ${MAX_ACTIONS}개까지 배열이어야 해요`;
		for (const [i, a] of j.actions.entries()) {
			const label = isObj(a) ? str(a.label, 1, 20) : undefined;
			if (!isObj(a) || !label) return `actions[${i}]: label 은 1~20자여야 해요`;
			if ((a.command === undefined) === (a.prompt === undefined)) return `actions[${i}]: command 나 prompt 중 하나만 써요`;
			if (a.command !== undefined && (typeof a.command !== "string" || !a.command.trim())) return `actions[${i}]: command 가 비어 있어요`;
			if (a.prompt !== undefined && (typeof a.prompt !== "string" || !a.prompt.trim() || a.prompt.length > 4000)) return `actions[${i}]: prompt 는 1~4000자여야 해요`;
			if (a.confirm !== undefined && typeof a.confirm !== "boolean") return `actions[${i}]: confirm 은 true/false 여야 해요`;
			spec.actions.push({ label, ...(a.command !== undefined ? { command: a.command as string } : { prompt: a.prompt as string }), ...(a.confirm ? { confirm: true } : {}) });
		}
	}
	return spec;
}

// Cards in id order (cards/<id>.json or cards/<id>/card.json [+ render.js]); more than MAX_CARDS goes to `errors`.
export function readCards(errors: CustomError[] = []): CardEntry[] {
	const dir = join(customDir(), "cards");
	let names: { name: string; dir: boolean }[];
	try {
		names = readdirSync(dir, { withFileTypes: true }).filter(d => !d.name.startsWith(".") && (d.isDirectory() || d.name.endsWith(".json"))).map(d => ({ name: d.name, dir: d.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
	const out: CardEntry[] = [];
	const seen = new Set<string>();
	for (const n of names) {
		const id = n.dir ? n.name : n.name.slice(0, -5);
		const rel = n.dir ? `cards/${n.name}/card.json` : `cards/${n.name}`;
		if (out.length >= MAX_CARDS) {
			errors.push({ file: rel, error: `카드는 ${MAX_CARDS}개까지만 보여요` });
			continue;
		}
		if (!ID.test(id)) {
			out.push({ id, file: rel, error: "id 는 영문 소문자·숫자·하이픈 40자 이하여야 해요" });
			continue;
		}
		if (seen.has(id)) {
			out.push({ id, file: rel, error: `id ${id} 가 겹쳐요 (파일과 폴더 중 하나만 두세요)` });
			continue;
		}
		seen.add(id);
		const file = join(dir, n.dir ? join(n.name, "card.json") : n.name);
		let raw: string;
		try {
			if (statSync(file).size > MAX_CARD_BYTES) {
				out.push({ id, file: rel, error: "카드 파일이 16KB 를 넘어요" });
				continue;
			}
			raw = readFileSync(file, "utf8");
		} catch (e) {
			out.push({ id, file: rel, error: n.dir ? "card.json 을 읽을 수 없어요" : msg(e) });
			continue;
		}
		const spec = parseCard(raw);
		if (typeof spec === "string") {
			out.push({ id, file: rel, error: spec });
			continue;
		}
		const renderFile = n.dir && existsSync(join(dir, n.name, "render.js")) ? join(dir, n.name, "render.js") : undefined;
		out.push({ id, file: rel, spec, ...(renderFile ? { renderFile } : {}), rev: renderFile ? String(Math.floor(statSync(renderFile).mtimeMs)) : "0" });
	}
	return out;
}

// ---- data commands (cache + one refresh per card at a time) ----------------------------------------------------------
type Entry = { hasData: boolean; data?: unknown; updated?: number; error?: string; ranAt: number; running?: Promise<void> };
const cache = new Map<string, Entry>();
const cacheKey = (id: string, s: CardSpec) => `${id}\0${s.command}\0${s.cwd ?? ""}`;
const parseOutput = (out: string): unknown => {
	try {
		return JSON.parse(out);
	} catch {
		return out.slice(0, 4000);
	}
};

async function runAction(command: string, spec: CardSpec): Promise<{ code: number; output: string; timedOut: boolean }> {
	try {
		return await exec(["/bin/sh", "-c", command], spec.cwd ? expand(spec.cwd) : undefined, spec.timeout_seconds * 1000, undefined, 500);
	} catch (err) {
		return { code: -1, output: msg(err).slice(-500), timedOut: false };
	}
}

function refresh(id: string, spec: CardSpec): Promise<void> {
	const key = cacheKey(id, spec);
	let e = cache.get(key);
	if (!e) cache.set(key, (e = { hasData: false, ranAt: 0 }));
	if (e.running) return e.running;
	const entry = e;
	entry.running = (async () => {
		let r: { code: number; output: string; timedOut: boolean };
		try {
			r = await exec(["/bin/sh", "-c", spec.command!], spec.cwd ? expand(spec.cwd) : undefined, spec.timeout_seconds * 1000, undefined, 4000);
		} catch (err) {
			r = { code: -1, output: msg(err), timedOut: false };
		}
		entry.ranAt = Date.now();
		if (r.code === 0 && !r.timedOut) {
			entry.data = parseOutput(r.output);
			entry.hasData = true;
			entry.updated = Date.now();
			entry.error = undefined;
		} else entry.error = r.output.slice(-500) || `종료 코드 ${r.code}`;
	})().finally(() => {
		entry.running = undefined;
	});
	return entry.running;
}

export const settleRefreshes = () => Promise.all([...cache.values()].map(e => e.running));

async function cardView(c: Exclude<CardEntry, { error: string }>, force: boolean): Promise<Record<string, unknown>> {
	const { spec } = c;
	const base: Record<string, unknown> = { id: c.id, title: spec.title, ...(spec.note ? { note: spec.note } : {}), view: spec.view, ...(spec.link ? { link: spec.link } : {}), order: spec.order, render: Boolean(c.renderFile), rev: c.rev, actions: spec.actions.map(a => ({ label: a.label, kind: a.command !== undefined ? "command" : "prompt", ...(a.confirm ? { confirm: true } : {}) })) };
	if (!spec.command) return spec.text !== undefined ? { ...base, data: spec.text } : base;
	const key = cacheKey(c.id, spec);
	const e = cache.get(key);
	if (force) {
		await e?.running;
		await refresh(c.id, spec);
	} else if (!e || !e.ranAt) await refresh(c.id, spec);
	else if (!e.running && Date.now() - e.ranAt >= spec.every_minutes * 60_000) void refresh(c.id, spec);
	const cur = cache.get(key)!;
	return {
		...base,
		...(cur.hasData ? { data: cur.data, updated: new Date(cur.updated!).toISOString() } : {}),
		...(cur.error ? { error: cur.error, ...(cur.hasData ? { stale: true } : {}) } : {}),
	};
}

// ---- pins.json -------------------------------------------------------------------------------------------------------
const nonEmpty = (v: unknown, max: number) => str(v, 1, max);

function parseRoutine(v: unknown): Routine | string {
	if (!isObj(v)) return "루틴은 객체여야 해요";
	if (typeof v.id !== "string" || !ID.test(v.id)) return "id 는 영문 소문자·숫자·하이픈 40자 이하여야 해요";
	const name = nonEmpty(v.name, 40);
	if (!name) return `루틴 ${v.id}: name 은 1~40자여야 해요`;
	if (typeof v.prompt !== "string" || !v.prompt.trim() || v.prompt.length > 4000) return `루틴 ${v.id}: prompt 는 1~4000자여야 해요`;
	const target = v.target === undefined ? "main" : v.target;
	if (typeof target !== "string" || !(target === "main" || /^lane:\S+$/.test(target))) return `루틴 ${v.id}: target 은 main 또는 lane:<이름> 이어야 해요`;
	const r: Routine = { id: v.id, name, prompt: v.prompt, target };
	if (v.schedule !== undefined) {
		const s = v.schedule;
		if (!isObj(s) || (s.every_minutes === undefined) === (s.at === undefined)) return `루틴 ${v.id}: schedule 에는 every_minutes 나 at 중 하나만 써요`;
		if (s.at !== undefined) {
			if (typeof s.at !== "string" || !HHMM.test(s.at)) return `루틴 ${v.id}: at 은 HH:MM 이어야 해요`;
			r.schedule = { at: s.at };
		} else {
			if (typeof s.every_minutes !== "number" || !(s.every_minutes >= 5)) return `루틴 ${v.id}: every_minutes 는 5 이상 숫자여야 해요`;
			r.schedule = { every_minutes: s.every_minutes };
		}
	}
	return r;
}

let syncedKey: string | undefined;
const pinsKey = (file: string) => {
	try {
		const st = statSync(file);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "none";
	}
};

function parsePins(): { pins: Pins; errors: CustomError[] } {
	const pins: Pins = { projects: [], hide_projects: [], routines: [], links: [] };
	const errors: CustomError[] = [];
	const bad = (error: string) => errors.push({ file: "pins.json", error });
	const file = join(customDir(), "pins.json");
	if (!existsSync(file)) return { pins, errors };
	let j: unknown;
	try {
		j = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		bad(`JSON을 읽을 수 없어요: ${msg(e)}`);
		return { pins, errors };
	}
	if (!isObj(j)) {
		bad("pins.json 은 JSON 객체여야 해요");
		return { pins, errors };
	}
	const list = (k: string): unknown[] => {
		if (j[k] === undefined) return [];
		if (Array.isArray(j[k])) return j[k] as unknown[];
		bad(`${k} 는 배열이어야 해요`);
		return [];
	};
	list("projects").forEach((p, i) => {
		const name = isObj(p) ? nonEmpty(p.name, 40) : undefined;
		if (!isObj(p) || !name) return bad(`projects[${i}]: name 은 1~40자여야 해요`);
		const path = p.path === undefined ? undefined : nonEmpty(p.path, 300);
		if (p.path !== undefined && !path) return bad(`projects[${i}]: path 는 글이어야 해요`);
		if (p.channel !== undefined && (typeof p.channel !== "string" || !/^\d+$/.test(p.channel))) return bad(`projects[${i}]: channel 은 디스코드 채널 id 문자열이어야 해요`);
		if (p.note !== undefined && typeof p.note !== "string") return bad(`projects[${i}]: note 는 글이어야 해요`);
		if (!path && p.channel === undefined) return bad(`projects[${i}]: path 나 channel 이 필요해요`);
		pins.projects.push({ name, ...(path ? { path } : {}), ...(p.channel !== undefined ? { channel: p.channel as string } : {}), ...(p.note ? { note: String(p.note) } : {}) });
	});
	list("hide_projects").forEach((h, i) => (typeof h === "string" && h.trim() ? pins.hide_projects.push(h.trim()) : bad(`hide_projects[${i}]: 글이어야 해요`)));
	list("routines").forEach((r, i) => {
		const parsed = parseRoutine(r);
		if (typeof parsed === "string") return bad(`routines[${i}]: ${parsed}`);
		if (pins.routines.some(x => x.id === parsed.id)) return bad(`routines[${i}]: id ${parsed.id} 가 겹쳐요`);
		pins.routines.push(parsed);
	});
	list("links").forEach((l, i) => {
		const name = isObj(l) ? nonEmpty(l.name, 40) : undefined;
		if (!isObj(l) || !name) return bad(`links[${i}]: name 은 1~40자여야 해요`);
		if (typeof l.url !== "string" || !/^https?:\/\/\S+$/.test(l.url)) return bad(`links[${i}]: url 은 http(s) 주소여야 해요`);
		pins.links.push({ name, url: l.url });
	});
	return { pins, errors };
}

// `sync: false` reads without touching the schedules (the feature list only looks).
export function readPins(opts: { sync?: boolean } = {}): { pins: Pins; errors: CustomError[] } {
	const key = pinsKey(join(customDir(), "pins.json"));
	const r = parsePins();
	if (opts.sync !== false && key !== syncedKey) {
		syncedKey = key;
		syncRoutines(r.pins.routines);
	}
	return r;
}

// ---- routine schedules -----------------------------------------------------------------------------------------------
const hashOf = (r: Routine) => createHash("sha1").update(JSON.stringify(r)).digest("hex").slice(0, 6);

function tzOffsetMs(t: number): number {
	const p: Record<string, string> = {};
	for (const x of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t))) p[x.type] = x.value;
	return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

// The next HH:MM on the TZ clock after `now`.
export function nextAt(hhmm: string, now = Date.now()): number {
	const [h, m] = hhmm.split(":").map(Number);
	const local = new Date(now + tzOffsetMs(now));
	for (let k = 0; k < 3; k++) {
		const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k, h, m);
		const utc = wall - tzOffsetMs(wall - tzOffsetMs(now));
		if (utc > now) return utc;
	}
	return now + 86_400_000;
}

function syncRoutines(routines: Routine[]): void {
	try {
		const wanted = new Map(routines.filter(r => r.schedule).map(r => [r.id, r]));
		const kept = new Set<string>();
		for (const s of listSchedules()) {
			if (!s.text.startsWith("[routine:")) continue;
			const m = ROUTINE_TAG.exec(s.text);
			const r = m ? wanted.get(m[1]) : undefined;
			if (m && r && m[2] === hashOf(r) && !kept.has(r.id)) kept.add(r.id);
			else removeSchedule(s.id);
		}
		for (const r of wanted.values()) {
			if (kept.has(r.id)) continue;
			const text = `[routine:${r.id}:${hashOf(r)}] ${r.name}\n${r.prompt}`;
			if ("at" in r.schedule!) addSchedule({ text, at: new Date(nextAt(r.schedule.at)).toISOString(), every_minutes: 1440 });
			else addSchedule({ text, at: new Date(Date.now() + r.schedule!.every_minutes * 60_000).toISOString(), every_minutes: r.schedule!.every_minutes });
		}
	} catch (e) {
		log(`custom: routine schedule sync failed: ${msg(e)}`);
	}
}

// Brings the `[routine:` schedules in line with pins.json now (gateway start, and tests).
export function syncRoutineSchedules(): void {
	const key = pinsKey(join(customDir(), "pins.json"));
	syncedKey = key;
	syncRoutines(parsePins().pins.routines);
}

// ---- projects (pure) -------------------------------------------------------------------------------------------------
type Auto = Project & { newest: number };

export function projectsView(input: { lanes: Array<Record<string, unknown>>; channels: ChannelsIn; pins: Pins; home?: string; tmpDirs?: string[] }): Project[] {
	const home = input.home ?? HOME;
	const tmp = input.tmpDirs ?? ["/tmp", "/private/tmp", "/var/folders", tmpdir()];
	const work = input.channels.work ?? {};
	const homes = input.channels.homes ?? {};
	const laneCh = input.channels.lanes ?? {};
	const norm = (p: string) => {
		const full = p.replace(/^~(?=\/|$)/, home).replace(/(.)\/+$/, "$1");
		return full === home ? "~" : full.startsWith(`${home}/`) ? `~${full.slice(home.length)}` : full;
	};
	const chan = (id: string) => ({ id, name: work[id] ?? id });
	const projects = new Map<string, Auto>();
	const make = (key: string, name: string, path?: string): Auto => {
		const p: Auto = { key, name, ...(path ? { path } : {}), pinned: false, lanes: [], newest: 0 };
		projects.set(key, p);
		return p;
	};
	const lanes = input.lanes.filter(l => typeof l.cwd === "string" && l.cwd && typeof l.name === "string").map(l => ({ l, at: Date.parse(String(l.startedAt ?? "")) || 0 })).sort((a, b) => b.at - a.at);
	for (const { l, at } of lanes) {
		// A worktree lane belongs to the checkout it works for, not to its own ~/.dotz/lanes/<name>/worktree folder (every
		// such lane showed as a project named "worktree").
		const cwd = String(typeof l.repo === "string" && l.repo ? l.repo : l.cwd);
		const expanded = cwd.replace(/^~(?=\/|$)/, home);
		if (tmp.some(t => expanded === t || expanded.startsWith(`${t.replace(/\/+$/, "")}/`))) continue;
		const path = norm(cwd);
		const p = projects.get(`dir:${path}`) ?? make(`dir:${path}`, basename(path), path);
		const name = String(l.name);
		p.lanes.push({ name, status: String(l.status ?? ""), live: Boolean(l.live), ...(l.startedAt ? { startedAt: String(l.startedAt) } : {}), lastText: String(l.lastText ?? "").slice(0, 300), reports: Number(l.reports ?? 0) || 0, ...(laneCh[name] ? { channel: laneCh[name] } : {}) });
		p.newest = Math.max(p.newest, at);
		if (homes[name] && !p.channel) p.channel = chan(homes[name]);
	}
	for (const [id, name] of Object.entries(work)) if (![...projects.values()].some(p => p.channel?.id === id)) make(`ch:${id}`, name).channel = chan(id);

	const pinned: Auto[] = [];
	for (const pin of input.pins.projects) {
		const np = pin.path ? norm(pin.path) : undefined;
		const byPath = np ? projects.get(`dir:${np}`) : undefined;
		const byCh = pin.channel ? [...projects.values()].find(p => p.channel?.id === pin.channel) : undefined;
		let p = byPath ?? byCh;
		if (byPath && byCh && byPath !== byCh && !byCh.lanes.length) {
			projects.delete(byCh.key);
			if (pinned.includes(byCh)) pinned.splice(pinned.indexOf(byCh), 1);
		}
		if (!p) p = np ? make(`dir:${np}`, pin.name, np) : make(`ch:${pin.channel}`, pin.name);
		p.name = pin.name;
		p.pinned = true;
		if (pin.note) p.note = pin.note;
		if (np && !p.path) p.path = np;
		if (pin.channel && !p.channel) p.channel = chan(pin.channel);
		if (!pinned.includes(p)) pinned.push(p);
	}
	const hidden = new Set(input.pins.hide_projects.map(h => (h.startsWith("dir:") ? `dir:${norm(h.slice(4))}` : h)));
	const auto = [...projects.values()].filter(p => !p.pinned && !hidden.has(p.key)).sort((a, b) => b.newest - a.newest).slice(0, MAX_AUTO_PROJECTS);
	return [...pinned, ...auto].map(({ newest, ...p }) => p);
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------
const NO_CACHE = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" };
const jsonOf = (v: unknown, status = 200) => Response.json(v, { status });

async function listAll(deps: CustomDeps) {
	const errors: CustomError[] = [];
	const orderOf = (c: CardEntry) => ("spec" in c ? c.spec.order : Number.POSITIVE_INFINITY);
	const entries = readCards(errors).sort((a, b) => orderOf(a) - orderOf(b) || a.id.localeCompare(b.id));
	const { pins, errors: pinErrors } = readPins();
	errors.push(...pinErrors);
	const cards = await Promise.all(entries.map(c => ("error" in c ? { id: c.id, file: c.file, error: c.error } : cardView(c, false))));
	const sched = listSchedules();
	const routines = pins.routines.map(r => {
		const s = sched.find(x => x.text.startsWith(`[routine:${r.id}:`));
		return { ...r, ...(s ? { next: s.at } : {}) };
	});
	return { dir: customDirLabel(), cards, projects: projectsView({ lanes: deps.lanes(), channels: deps.channels(), pins }), routines, links: pins.links, errors };
}

export async function customRoute(req: Request, url: URL, deps: CustomDeps): Promise<Response | undefined> {
	const p = url.pathname;
	if (!p.startsWith("/api/custom")) return undefined;
	if (req.method === "GET" && p === "/api/custom") return jsonOf(await listAll(deps));
	if (req.method === "GET" && p === "/api/custom/render") {
		const id = url.searchParams.get("id") ?? "";
		const file = ID.test(id) ? join(customDir(), "cards", id, "render.js") : "";
		if (!file || !existsSync(file)) return new Response("not found", { status: 404 });
		return new Response(Bun.file(file), { headers: NO_CACHE });
	}
	if (req.method !== "POST" || (p !== "/api/custom/refresh" && p !== "/api/custom/routine" && p !== "/api/custom/action")) return undefined;
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	const id = String(body.id ?? "");
	if (p === "/api/custom/refresh") {
		const c = readCards().find(x => x.id === id);
		if (!c) return jsonOf({ error: `card ${id} not found` }, 404);
		return jsonOf("error" in c ? { id: c.id, file: c.file, error: c.error } : await cardView(c, true));
	}
	const login = req.headers.get("tailscale-user-login") ?? "local";
	const sent = async (target: "main" | `lane:${string}`, text: string) => {
		try {
			await deps.send(target, text, login);
		} catch (e) {
			return jsonOf({ error: msg(e) }, 409);
		}
		return jsonOf({ ok: true });
	};
	if (p === "/api/custom/action") {
		const c = readCards().find(x => x.id === id);
		const action = c && !("error" in c) && Number.isInteger(body.index) ? c.spec.actions[body.index as number] : undefined;
		if (!c || "error" in c || !action) return jsonOf({ error: `card ${id} action ${String(body.index)} not found` }, 404);
		if (action.prompt !== undefined) return sent("main", `[카드 ${c.spec.title}] ${action.prompt}`);
		const r = await runAction(action.command!, c.spec);
		return jsonOf({ ok: r.code === 0 && !r.timedOut, code: r.code, output: r.output, card: await cardView(c, true) });
	}
	const r = readPins().pins.routines.find(x => x.id === id);
	if (!r) return jsonOf({ error: `routine ${id} not found` }, 404);
	return sent(r.target as "main" | `lane:${string}`, `[루틴 ${r.name}] ${r.prompt}`);
}
