// Switching an app off or removing it on THIS install (모니터링 > 앱 > 설정 > 이 기기에서 쓰기 / 제거). The switch is a setting
// (hub/app-settings.ts `use_here`, file custom/apps.json {"mail":{"off":true}}), so the web's switch, a change card and a peer's
// /api/peer/act all use the one PATCH. Off is read live by the list (hub/integrations.ts), the watch runner (setWatchGate), the notice
// store (setAppBlocker) and POST /api/mail: nothing is deleted and turning it on again restores everything. 제거 (removeApp) goes further:
// it deletes the app's watches and disables its feature folders here, and deletes its stored data only when asked.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeSettings } from "./app-settings.ts";
import { loadFeatureDirs } from "./featuredirs.ts";
import { type IntegrationEntry, INTEGRATIONS, readAppOff, whereOf } from "./integrations.ts";

const entryOf = (app: string): IntegrationEntry | undefined => INTEGRATIONS.find(e => e.key === app);
const owns = (e: IntegrationEntry, watch: string): boolean => (e.watches ?? []).some(w => (w.endsWith("-") ? watch.startsWith(w) : watch === w));

/** True when the watch belongs to an app this install switched off: the runner skips it. */
export const watchOff = (dataDir: string, watch: string): boolean => {
	const off = readAppOff(dataDir);
	return off.size > 0 && INTEGRATIONS.some(e => off.has(e.key) && owns(e, watch));
};

type Blockable = { app?: string; src?: string; open?: string; decision?: { to?: string } };
/** True when a notice belongs to an off app (its stamped app, or it lives in the app's conversation prefix): no new one is kept, none is listed or counted. */
export function blockedByOff(dataDir: string, n: Blockable): boolean {
	const off = readAppOff(dataDir);
	if (!off.size) return false;
	if (n.app && off.has(n.app)) return true;
	const where = whereOf(n);
	return INTEGRATIONS.some(e => off.has(e.key) && (e.match.conv ?? []).some(p => where.some(w => w.startsWith(p))));
}

export type RemovalPlan = { app: string; label: string; watches: string[]; features: string[]; data: string[] };
const dataPath = (dataDir: string, spec: string) => join(dataDir, spec.split("#")[0]!);
/** What 제거 will do on this install, in words the owner reads before the confirm. */
export function removalPlan(dataDir: string, app: string, watchNames: readonly string[]): RemovalPlan | undefined {
	const e = entryOf(app);
	if (!e) return undefined;
	const on = new Set(e.on.features ?? []);
	return {
		app, label: e.label,
		watches: watchNames.filter(w => owns(e, w)),
		features: loadFeatureDirs(dataDir).features.filter(f => f.enabled && on.has(f.id)).map(f => f.id),
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
	if (opts.deleteStored) for (const s of entryOf(app)!.data ?? []) deleteData(dataDir, s);
	return plan;
}
