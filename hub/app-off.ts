// Switching an app off or removing it on THIS install (모니터링 > 앱 > 설정 > 이 기기에서 쓰기 / 제거). The switch is a setting
// (hub/app-settings.ts `use_here`, file custom/apps.json {"mail":{"off":true}}), so the web's switch, a change card and a peer's
// /api/peer/act all use the one PATCH. Off is read live by the list (hub/integrations.ts), the watch runner (setWatchGate), the notice
// store (setAppBlocker) and POST /api/mail: nothing is deleted and turning it on again restores everything. 제거 (removeApp) goes further:
// it deletes the app's watches and disables its feature folders here, and deletes its stored data only when asked.
// Instances (hub/integrations.ts appEntries): createApp adds another instance of an app (POST /api/apps); deleteApp removes an OFF instance for good
// (DELETE /api/apps/<id>) with the same removal as 제거, and a deleted default instance stays as {off, deleted} so nothing brings it back by itself.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { watchOwner } from "./app-features.ts";
import { SettingsError, writeSettings } from "./app-settings.ts";
import { loadFeatureDirs } from "./featuredirs.ts";
import { type AppFilter, type AppRaw, APPS_FILE, appEntries, appLabel, type IntegrationEntry, inConv, INTEGRATIONS, readAppOff, readAppsFile, srcKey, whereOf } from "./integrations.ts";

const entryOf = (dataDir: string, app: string): IntegrationEntry | undefined => appEntries(dataDir).find(e => e.key === app);
const named = (list: readonly string[], watch: string): boolean => list.some(w => (w.endsWith("-") ? watch.startsWith(w) : watch === w));
const owns = (e: IntegrationEntry, watch: string): boolean => named(e.watches ?? [], watch) && !named(e.not?.watches ?? [], watch);

/** True when the watch belongs to an app this install switched off: the runner skips it. */
export const watchOff = (dataDir: string, watch: string, session?: { url: string }): boolean => {
	const off = readAppOff(dataDir);
	if (!off.size) return false;
	const owner = watchOwner(appEntries(dataDir), { name: watch, session });
	return owner !== undefined && off.has(owner);
};

type Blockable = { app?: string; src?: string; open?: string; decision?: { to?: string } };
/** True when a notice belongs to an off app (its stamped app, or it lives in the app's conversation prefix): no new one is kept, none is listed or counted. */
export function blockedByOff(dataDir: string, n: Blockable): boolean {
	const off = readAppOff(dataDir);
	if (!off.size) return false;
	if (n.app && off.has(n.app)) return true;
	const where = whereOf(n);
	return appEntries(dataDir).some(e => off.has(e.key) && where.some(w => inConv(e, w)));
}

export type RemovalPlan = { app: string; label: string; watches: string[]; features: string[]; data: string[] };
const dataPath = (dataDir: string, spec: string) => join(dataDir, spec.split("#")[0]!);
/** What 제거 will do on this install, in words the owner reads before the confirm. */
export function removalPlan(dataDir: string, app: string, watchNames: readonly string[]): RemovalPlan | undefined {
	const e = entryOf(dataDir, app);
	if (!e || e.gone) return undefined;
	const on = new Set(e.on.features ?? []), off = readAppOff(dataDir);
	// The feature folder is shared by the app's instances: it is disabled only with the last one that is still on (an added instance never owns it).
	const shared = e.created || appEntries(dataDir).some(x => x.app === e.app && x.key !== e.key && !x.gone && !off.has(x.key));
	return {
		app, label: e.label,
		watches: watchNames.filter(w => owns(e, w)),
		features: shared ? [] : loadFeatureDirs(dataDir).features.filter(f => f.enabled && on.has(f.id)).map(f => f.id),
		data: (e.data ?? []).filter(s => existsSync(dataPath(dataDir, s))),
	};
}

const writeJson = (file: string, doc: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
	renameSync(tmp, file);
};

/** The personal copy of a feature folder's feature.md with `enabled: false` (a personal folder replaces the shipped one of the same id). */
function disableFeature(dataDir: string, id: string): void {
	const f = loadFeatureDirs(dataDir).features.find(x => x.id === id);
	if (!f) return;
	const text = readFileSync(f.file, "utf8");
	const next = /^enabled:.*$/m.test(text) ? text.replace(/^enabled:.*$/m, "enabled: false") : text.replace(/^---\r?\n/, "---\nenabled: false\n");
	const dest = join(dataDir, "features", id, "feature.md");
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, next);
}

function deleteData(dataDir: string, spec: string): void {
	const [rel, key] = spec.split("#");
	const file = join(dataDir, rel!);
	if (!key) return void rmSync(file, { recursive: true, force: true });
	try {
		const doc = JSON.parse(readFileSync(file, "utf8"));
		if (doc && typeof doc === "object" && key in doc) {
			delete doc[key];
			writeJson(file, doc);
		}
	} catch { /* no file or not JSON: nothing to delete */ }
}

/** 제거: off, the app's watches deleted, its feature folders disabled here, and with `deleteStored` its data too. The off flag stays until 앱 추가. */
export function removeApp(dataDir: string, app: string, opts: { deleteStored?: boolean }, deps: { watchNames(): string[]; removeWatch(name: string): void }): RemovalPlan {
	const plan = removalPlan(dataDir, app, deps.watchNames());
	if (!plan) throw new Error(`${app}: 알 수 없는 앱이에요`);
	writeSettings(dataDir, app, { use_here: false });
	for (const w of plan.watches) deps.removeWatch(w);
	for (const id of plan.features) disableFeature(dataDir, id);
	if (opts.deleteStored) for (const s of entryOf(dataDir, app)!.data ?? []) deleteData(dataDir, s);
	return plan;
}

const appsDoc = (dataDir: string): Record<string, AppRaw | undefined> => ({ ...readAppsFile(dataDir) });
const writeApps = (dataDir: string, doc: Record<string, AppRaw | undefined>) => writeJson(join(dataDir, APPS_FILE), Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)));

/** Delete an instance for good: only one that is off. The removal of 제거 runs first (watches, features, data when asked), then its entry goes. */
export function deleteApp(dataDir: string, id: string, opts: { deleteStored?: boolean }, deps: { watchNames(): string[]; removeWatch(name: string): void }): RemovalPlan {
	const e = entryOf(dataDir, id);
	if (!e || e.gone) throw new SettingsError(`${id}: 알 수 없는 앱이에요`, 404);
	if (!readAppOff(dataDir).has(id)) throw new SettingsError(`${e.label}은(는) 켜져 있어요. 먼저 끄세요`, 409);
	const plan = removeApp(dataDir, id, opts, deps), doc = appsDoc(dataDir);
	doc[id] = e.created ? undefined : { off: true, deleted: true };
	writeApps(dataDir, doc);
	return plan;
}

const NAME = /^[a-z0-9][a-z0-9:._/-]{0,79}$/;
function cleanFilter(v: unknown, reg: IntegrationEntry): AppFilter {
	if (v === undefined || v === null) return {};
	if (typeof v !== "object" || Array.isArray(v)) throw new SettingsError("filter: 객체여야 해요");
	const out: AppFilter = {}, source = (v as Record<string, unknown>).source;
	if (source !== undefined) {
		if (typeof source !== "string" || source.length > 60 || !srcKey(source) || !reg.match.conv?.length) throw new SettingsError("filter.source: 메일 같은 앱의 출처 이름(영문·숫자 60자 이하)이어야 해요");
		out.source = source.trim();
	}
	for (const k of ["conv", "watches", "text", "data"] as const) {
		const list = (v as Record<string, unknown>)[k];
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.length > 20 || list.some(x => typeof x !== "string" || !x.trim() || x.length > 120)) throw new SettingsError(`filter.${k}: 글 목록(20개 이하)이어야 해요`);
		const items = (list as string[]).map(x => x.trim());
		// conv and watches are names; data is a folder or key of this install's custom/ only (it is what "데이터도 지우기" deletes).
		if (k !== "text" && items.some(x => (k === "data" ? !x.startsWith("custom/") || x.includes("..") : !NAME.test(x)))) throw new SettingsError(`filter.${k}: 쓸 수 없는 값이 있어요`);
		if (items.length) out[k] = [...new Set(items)];
	}
	return out;
}

/** Register another instance of an app: {app, label?, filter?, id?}. The id is `<app>-<n>` unless given (`<app>-<slug>`). With no filter and the app's default
 *  instance deleted, the default comes back instead. */
export function createApp(dataDir: string, b: { app?: unknown; label?: unknown; filter?: unknown; id?: unknown }): { id: string; label: string } {
	const reg = INTEGRATIONS.find(e => e.key === b.app);
	if (!reg) throw new SettingsError("app: 알 수 없는 앱이에요");
	if (b.label !== undefined && !appLabel(b.label)) throw new SettingsError("label: 1자에서 30자 사이 글이어야 해요");
	const label = appLabel(b.label), filter = cleanFilter(b.filter, reg), doc = appsDoc(dataDir);
	let id: string;
	if (typeof b.id === "string" && b.id) {
		if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(b.id) || !b.id.startsWith(`${reg.key}-`)) throw new SettingsError(`id: ${reg.key}-<이름> 꼴이어야 해요`);
		if (doc[b.id]) throw new SettingsError(`${b.id}: 이미 있어요`, 409);
		id = b.id;
	} else if (doc[reg.key]?.deleted && !Object.keys(filter).length) {
		doc[reg.key] = label ? { label } : undefined;
		writeApps(dataDir, doc);
		return { id: reg.key, label: label ?? reg.label };
	} else {
		let n = 2;
		while (doc[`${reg.key}-${n}`]) n++;
		id = `${reg.key}-${n}`;
	}
	doc[id] = { app: reg.key, ...(label ? { label } : {}), ...(Object.keys(filter).length ? { filter } : {}) };
	writeApps(dataDir, doc);
	return { id, label: label ?? reg.label };
}
