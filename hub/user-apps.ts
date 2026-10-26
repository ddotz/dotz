// User apps: an app the owner adds to THIS install, beyond the shipped ones (모니터링's contact-first apps) and beyond the
// custom cards. Data only, no code: <DATA_DIR>/custom/apps/<id>/app.json. The gateway merges them into the 앱 list
// (GET /api/apps), checks their health, and reverse-proxies a tool app's own web UI at /apps/<id>/ (hub/app-proxy.ts).
//
//   {
//     "label": "문서 도구",                    // the name the owner reads, required
//     "kind": "tool",                          // "tool": its own web UI (web.url required) | "monitor": no UI, status only
//     "icon": "file",                          // a web icon name (web/js/01-core.js ICONS), or
//     "iconPath": "M4 5h16...",                //    a 24x24 stroke path when the web has no icon for it
//     "id": "mydocs",                           // optional; must equal the folder name
//     "web": { "url": "http://127.0.0.1:4417", // loopback only (127.0.0.1, ::1, localhost); no path, query or login
//              "path": "/",                    //   where the app's own http server answers
//              "mode": "rewrite" },             // "prefix" (default): the app serves under /apps/<id>/ itself, relative URLs
//                                               // "rewrite": the app was written for "/" (mydocs): the gateway prefixes its
//                                               //   root-absolute URLs and injects a fetch/XHR/WebSocket shim
//     "start": { "command": "bun src/server.ts", "cwd": "~/Code/my-docs", "env": { "PORT": "4417" } },
//                                               // a HINT for the owner and the bot: the gateway never runs it
//     "health": "/",                           // path on web.url that answers when the app is up (GET, any 2xx-4xx = running)
//     "watches": ["mydocs-"],                   // watch names/prefixes this app owns (shown in its 설정 panel)
//     "settings": { "port": 4417 },            // free-form name -> string/number/boolean, shown read-only in 설정
//     "order": 10                              // list order (default 100)
//   }
//
// A bad manifest is listed in `errors` with its reason and never stops the others; a manifest that reuses a shipped app's
// id (or another manifest's) is an error too. 끄기/켜기 is custom/apps.json {"<id>":{"off":true}} (the same file the app
// instances use; this module only reads the ids of manifests). 제거 moves the folder to custom/apps-removed/ (recoverable).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAppsFile } from "./integrations.ts";

export type UserAppKind = "monitor" | "tool";
export type UserAppWeb = { url: string; path: string; mode: "prefix" | "rewrite" };
export type UserAppStart = { command: string; cwd?: string; env?: Record<string, string> };
export type UserApp = {
	id: string;
	label: string;
	kind: UserAppKind;
	icon?: string;
	iconPath?: string;
	web?: UserAppWeb;
	start?: UserAppStart;
	health: string;
	watches: string[];
	settings: Record<string, string | number | boolean>;
	order: number;
	dir: string;
	off: boolean;
};
export type UserAppError = { id: string; dir: string; reason: string };
export type UserApps = { apps: UserApp[]; errors: UserAppError[] };

export const APPS_DIR = "custom/apps";
export const REMOVED_DIR = "custom/apps-removed";
/** `/apps/<id>/…` on this gateway: the one place a tool app's own UI is served. */
export const PROXY_ROOT = "/apps";
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|::1)$/i;
const MODES: UserAppWeb["mode"][] = ["prefix", "rewrite"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, min: number, max: number): string | undefined =>
	typeof v === "string" && v.trim().length >= min && v.trim().length <= max ? v.trim() : undefined;

/** The origin of a loopback http URL ("http://127.0.0.1:4417/open" is refused: `web.path` says where the app answers). */
export function loopbackOrigin(raw: unknown): { origin: string; error?: undefined } | { origin?: undefined; error: string } {
	const s = typeof raw === "string" ? raw.trim() : "";
	if (!s) return { error: "web.url이 없어요" };
	if (/\s/.test(s)) return { error: "web.url에 공백이 있어요" };
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return { error: `web.url이 주소가 아니에요: ${s}` };
	}
	if (u.protocol !== "http:") return { error: `web.url은 http://여야 해요 (지금 ${u.protocol})` };
	if (!LOOPBACK.test(u.hostname)) return { error: `web.url은 이 컴퓨터(127.0.0.1)만 가리킬 수 있어요 (지금 ${u.hostname})` };
	if (u.username || u.password) return { error: "web.url에 로그인 정보를 넣지 마세요" };
	if (u.pathname !== "/" || u.search || u.hash) return { error: "web.url에는 경로를 넣지 말고 web.path를 쓰세요" };
	return { origin: u.origin };
}

const pathOk = (s: string): boolean => s.startsWith("/") && !s.startsWith("//") && s.length <= 200 && !/\s/.test(s);

/** One manifest, as read from its file. A string is the reason it is refused. */
export function parseUserApp(id: string, raw: string): UserApp | string {
	let j: unknown;
	try {
		j = JSON.parse(raw);
	} catch (e) {
		return `app.json을 읽을 수 없어요: ${(e as Error).message}`;
	}
	if (!isObj(j)) return "app.json은 객체 하나여야 해요";
	if (id === "apps" || id === "app") return `"${id}"는 주소로 쓸 수 없는 이름이에요`;
	if (j.id !== undefined && j.id !== id) return `id "${String(j.id)}"가 폴더 이름 "${id}"와 달라요`;
	const label = str(j.label, 1, 30);
	if (!label) return "label(앱 이름, 30자까지)이 비어 있어요";
	const kind = j.kind ?? "tool";
	if (kind !== "tool" && kind !== "monitor") return `kind는 "tool" 또는 "monitor"여야 해요 (지금 ${JSON.stringify(kind)})`;
	let web: UserAppWeb | undefined;
	if (j.web !== undefined) {
		if (!isObj(j.web)) return "web은 객체여야 해요";
		const origin = loopbackOrigin(j.web.url);
		if (origin.error) return origin.error;
		const path = j.web.path ?? "/";
		if (typeof path !== "string" || !pathOk(path.endsWith("/") ? path : `${path}/`)) return "web.path는 /로 시작하는 경로여야 해요";
		const mode = j.web.mode ?? "prefix";
		if (typeof mode !== "string" || !MODES.includes(mode as UserAppWeb["mode"])) return `web.mode는 ${MODES.join(" | ")} 중 하나여야 해요`;
		web = { url: origin.origin!, path: path.endsWith("/") ? path : `${path}/`, mode: mode as UserAppWeb["mode"] };
	}
	if (kind === "tool" && !web) return "kind \"tool\"인 앱은 web.url이 있어야 해요";
	const health = j.health ?? "/";
	if (typeof health !== "string" || !pathOk(health)) return "health는 /로 시작하는 경로여야 해요";
	let start: UserAppStart | undefined;
	if (j.start !== undefined) {
		if (!isObj(j.start)) return "start는 객체여야 해요";
		const command = str(j.start.command, 1, 500);
		if (!command) return "start.command가 비어 있어요";
		const cwd = j.start.cwd === undefined ? undefined : str(j.start.cwd, 1, 500);
		if (j.start.cwd !== undefined && (!cwd || !(cwd.startsWith("/") || cwd.startsWith("~/")))) return "start.cwd는 절대 경로나 ~/ 경로여야 해요";
		let env: Record<string, string> | undefined;
		if (j.start.env !== undefined) {
			if (!isObj(j.start.env)) return "start.env는 객체여야 해요";
			env = {};
			for (const [k, v] of Object.entries(j.start.env)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string") return `start.env의 ${k}: 이름은 대문자/숫자/_이고 값은 문자열이어야 해요`;
				env[k] = v;
			}
		}
		start = { command, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) };
	}
	const watches = j.watches === undefined ? [] : Array.isArray(j.watches) ? j.watches.filter((w): w is string => typeof w === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(w)) : null;
	if (!watches) return "watches는 watch 이름의 배열이어야 해요";
	const settings: Record<string, string | number | boolean> = {};
	if (j.settings !== undefined) {
		if (!isObj(j.settings)) return "settings는 객체여야 해요";
		for (const [k, v] of Object.entries(j.settings)) {
			if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return `settings의 ${k}: 문자열, 숫자 또는 true/false여야 해요`;
			settings[k] = typeof v === "string" ? v.slice(0, 200) : v;
		}
	}
	const icon = j.icon === undefined ? undefined : str(j.icon, 1, 40);
	if (j.icon !== undefined && (!icon || !/^[a-z0-9-]+$/.test(icon))) return "icon은 소문자 아이콘 이름이어야 해요";
	const iconPath = j.iconPath === undefined ? undefined : str(j.iconPath, 4, 400);
	if (j.iconPath !== undefined && (!iconPath || !/^[Mm0-9.,\s-]+$/.test(iconPath))) return "iconPath는 24x24 선 아이콘 경로여야 해요";
	const order = j.order === undefined ? 100 : Number(j.order);
	if (!Number.isFinite(order)) return "order는 숫자여야 해요";
	return {
		id, label, kind: kind as UserAppKind, ...(icon ? { icon } : {}), ...(iconPath ? { iconPath } : {}),
		...(web ? { web } : {}), ...(start ? { start } : {}), health, watches, settings, order,
		dir: "", off: false,
	};
}

/** Every manifest folder under `<dataDir>/custom/apps`, with the ones that cannot load kept apart as errors. */
export function loadUserApps(dataDir: string, registryIds: readonly string[] = []): UserApps {
	const root = join(dataDir, APPS_DIR), apps: UserApp[] = [], errors: UserAppError[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort();
	} catch {
		return { apps, errors };
	}
	const off = new Set(Object.entries(readAppsFile(dataDir)).filter(([, v]) => v && typeof v === "object" && (v as { off?: unknown }).off === true).map(([k]) => k));
	const seen = new Set<string>(registryIds);
	for (const name of names) {
		const dir = join(root, name);
		const bad = (reason: string) => errors.push({ id: name, dir, reason });
		if (!ID.test(name)) { bad(`폴더 이름은 [a-z0-9-] (40자까지)여야 해요`); continue; }
		if (seen.has(name)) { bad(`id "${name}"가 이미 있어요 (다른 앱과 같은 id)`); continue; }
		const file = join(dir, "app.json");
		if (!existsSync(file)) { bad("app.json이 없어요"); continue; }
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (e) {
			bad(`app.json을 읽지 못했어요: ${(e as Error).message}`);
			continue;
		}
		if (Buffer.byteLength(text) > 32 * 1024) { bad("app.json이 너무 커요 (32KB까지)"); continue; }
		const app = parseUserApp(name, text);
		if (typeof app === "string") { bad(app); continue; }
		seen.add(name);
		apps.push({ ...app, dir, off: off.has(name) });
	}
	apps.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, "ko"));
	return { apps, errors };
}

/** The one app, whatever its switch says; undefined when it does not load or does not exist. */
export const userApp = (dataDir: string, id: string, registryIds: readonly string[] = []): UserApp | undefined =>
	loadUserApps(dataDir, registryIds).apps.find(a => a.id === id);

/** 끄기/켜기: custom/apps.json {"<id>":{"off":true}} (the same file app instances keep their state in). */
export function setUserAppOff(dataDir: string, id: string, off: boolean): void {
	const file = join(dataDir, "custom/apps.json");
	let doc: Record<string, unknown> = {};
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		if (isObj(v)) doc = v;
	} catch {}
	const mine = isObj(doc[id]) ? (doc[id] as Record<string, unknown>) : {};
	if (off) doc[id] = { ...mine, off: true };
	else {
		delete mine.off;
		if (Object.keys(mine).length) doc[id] = mine;
		else delete doc[id];
	}
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
	renameSync(tmp, file);
}

/** 제거: the folder moves to custom/apps-removed/<stamp>-<id>/ (recoverable by hand), and its off entry goes. */
export function removeUserApp(dataDir: string, id: string, registryIds: readonly string[] = []): { removed: string; kept: string } | undefined {
	const app = userApp(dataDir, id, registryIds);
	if (!app) return undefined;
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	const kept = join(dataDir, REMOVED_DIR, `${stamp}-${id}`);
	mkdirSync(dirname(kept), { recursive: true });
	renameSync(app.dir, kept);
	try {
		setUserAppOff(dataDir, id, false);
	} catch {}
	healthCache.delete(id);
	return { removed: app.dir, kept };
}

export type AppHealth = { status: "running" | "unreachable" | "unknown"; reason?: string; checkedAt?: string; ms?: number };
const HEALTH_TTL = 5_000;
const healthCache = new Map<string, { at: number; value: AppHealth }>();

/** Is the app's own server answering? A loopback GET of its `health` path, 1.2s at most, cached 5s (the list polls). */
export async function appHealth(app: UserApp, timeoutMs = 1200, now = Date.now()): Promise<AppHealth> {
	if (!app.web) return { status: "unknown" };
	const hit = healthCache.get(app.id);
	if (hit && now - hit.at < HEALTH_TTL) return hit.value;
	const target = `${app.web.url}${app.health}`;
	const started = Date.now();
	let value: AppHealth;
	try {
		const r = await fetch(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		await r.body?.cancel();
		value = { status: r.status < 500 ? "running" : "unreachable", checkedAt: new Date().toISOString(), ms: Date.now() - started, ...(r.status >= 500 ? { reason: `HTTP ${r.status}` } : {}) };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		value = { status: "unreachable", checkedAt: new Date().toISOString(), ms: Date.now() - started, reason: /abort|timeout/i.test(msg) ? "응답이 없어요" : "연결하지 못했어요" };
	}
	healthCache.set(app.id, { at: Date.now(), value });
	return value;
}
