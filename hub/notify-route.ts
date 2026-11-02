// The one place that decides where an outgoing notice goes: the web app's notice center, the phone push, and each messenger (Discord, JANDI, the
// agent messengers). Every sender asks route(); nobody reads the switches themselves.
//   hub/outbound.ts   what goes to Discord (route().messengers.discord)
//   hub/push.ts       whether a phone push goes out (route().push)
//   hub/messenger.ts  which non-native adapters get an "out" event (route().messengers[adapterId])
// The switches stay where they were, so an existing install routes as before:
//   web        always on: hub/notices.ts keeps everything (its per-app switches, hub/app-off.ts, are applied by the notice store).
//   push       config.json notify.push per class (CLASS_PUSH_DEFAULTS when unset); a news notice also follows its app's own switch (custom/apps.json <app>.push).
//   discord    <DATA_DIR>/discord-post.json: the class key for a class, the conversation kind (chat/lanes/worklog) for a post with no class (progress, work log).
//   messenger  <DATA_DIR>/notify-route.json { messengers: { <adapterId>: { <class>: boolean } } }; a missing entry is on (these messengers got everything before).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, updateNotifyPush, writeAtomic } from "./config.ts";
import { isWebLane, postKind, postSettings, savePostSettings } from "./discord-post.ts";
import { CLASS_LABELS, CLASS_PUSH_DEFAULTS, NOTICE_CLASSES, type NoticeClass } from "./notice-class.ts";
import { splitTone } from "./tone.ts";

export type RouteInput = {
	/** The notice class. Without it the class of the post (`target` + `text`) decides; a post with no class (progress, the work log) is "log". */
	cls?: NoticeClass;
	/** The conversation a post goes to ("main", "lane:<name>", "ch:<id>", "alert", ...). */
	target?: string;
	text?: string;
	/** The post's event fields: source, update_key, system, lane_report, mail, news. */
	extra?: Record<string, unknown>;
	replyTo?: string;
	/** The app a news notice came from: its own phone switch applies. */
	app?: string;
	/** Adapter ids to decide besides Discord (the non-native adapters a fan-out would deliver to). */
	messengers?: readonly string[];
};
export type Route = { web: boolean; push: boolean; messengers: Record<string, boolean> };

// The notice class of an outgoing post, or undefined when none applies (progress, work log, anything else).
// `extra` is the post's event fields (source, update_key, system, mail; news = a monitor's post, hub/main.ts).
export function postClass(target: string, text: string, extra: Record<string, unknown> = {}): NoticeClass | undefined {
	const { tone } = splitTone(text);
	const t = target === "web:alert" ? "alert" : target === "web:worklog" ? "worklog" : target;
	if (tone === "run" || t === "worklog" || typeof extra.update_key === "string") return undefined;
	if (tone === "ask") return "ask";
	if (t === "alert") return "alert";
	if (t.startsWith("lane:")) return tone === "done" || tone === "fail" || extra.lane_report === true ? "result" : undefined;
	if (extra.mail === true || extra.news === true) return "news";
	const bot = extra.source === undefined || extra.source === "orchestrator";
	return bot && !extra.system && /^(?:main|ch:|th:|settings:)/.test(t) ? "conv" : undefined;
}

// The phone switches: CLASS_PUSH_DEFAULTS under config.json notify.push.
export const pushClasses = (): Record<NoticeClass, boolean> => ({
	...CLASS_PUSH_DEFAULTS,
	...Object.fromEntries(Object.entries(cfg.notify?.push ?? {}).filter(([k, v]) => k in CLASS_PUSH_DEFAULTS && typeof v === "boolean")),
});
const appPushes = (app: string): boolean => {
	try {
		return (JSON.parse(readFileSync(join(DATA_DIR, "custom", "apps.json"), "utf8")) as Record<string, { push?: unknown }>)[app]?.push !== false;
	} catch {
		return true;
	}
};

const file = () => join(DATA_DIR, "notify-route.json");
type Stored = Record<string, Partial<Record<NoticeClass, boolean>>>;
let cache: { stamp: string; v: Stored } | undefined;
function stored(): Stored {
	let stamp: string;
	try {
		const st = statSync(file());
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		return {};
	}
	if (cache?.stamp === stamp) return cache.v;
	let v: Stored = {};
	try {
		const raw = (JSON.parse(readFileSync(file(), "utf8")) as { messengers?: Record<string, Record<string, unknown>> }).messengers ?? {};
		for (const [id, per] of Object.entries(raw)) v[id] = Object.fromEntries(NOTICE_CLASSES.filter(c => typeof per?.[c] === "boolean").map(c => [c, per[c] as boolean]));
	} catch {
		v = {};
	}
	cache = { stamp, v };
	return v;
}
const messengerOn = (id: string, cls: NoticeClass): boolean => stored()[id]?.[cls] !== false;

const discordOn = (target: string | undefined, cls: NoticeClass | undefined, replyTo: string | undefined): boolean => {
	if (target?.startsWith("lane:") && isWebLane(target.slice(5))) return false;
	// An answer to a message the owner wrote on Discord (a Discord message id) always goes there: he asked there.
	const key = cls && cls !== "log" ? cls : target !== undefined ? postKind(target) : undefined;
	return (key !== undefined && postSettings()[key]) || (!!replyTo && /^\d{17,20}$/.test(replyTo));
};

export function route(input: RouteInput): Route {
	const cls = input.cls ?? (input.target !== undefined && input.text !== undefined ? postClass(input.target, input.text, input.extra) : undefined);
	const c = cls ?? "log";
	return {
		web: true,
		push: pushClasses()[c] && (c !== "news" || !input.app || appPushes(input.app)),
		messengers: { discord: discordOn(input.target, cls, input.replyTo), ...Object.fromEntries((input.messengers ?? []).map(id => [id, messengerOn(id, c)])) },
	};
}

// The settings matrix: one row per class, one column per place. `null`: no switch (Discord's 기록 follows the conversation kind, 설정 → Discord).
export type Column = { id: string; label: string };
export type Matrix = { classes: { id: NoticeClass; label: string }[]; columns: Column[]; cells: Record<NoticeClass, Record<string, boolean | null>> };

export function matrix(messengers: readonly Column[], discordConnected: boolean): Matrix {
	const columns: Column[] = [{ id: "web", label: "웹앱" }, { id: "push", label: "휴대폰" }, ...(discordConnected ? [{ id: "discord", label: "디스코드" }] : []), ...messengers];
	const post = postSettings(), push = pushClasses();
	const cells = Object.fromEntries(NOTICE_CLASSES.map(c => [c, Object.fromEntries(columns.map(col => [col.id, col.id === "web" ? true : col.id === "push" ? push[c] : col.id === "discord" ? (c === "log" ? null : post[c]) : messengerOn(col.id, c)]))])) as Matrix["cells"];
	return { classes: NOTICE_CLASSES.map(id => ({ id, label: CLASS_LABELS[id] })), columns, cells };
}

/** Sets one cell of the matrix; `messengers` are the adapter ids that have a column. A cell that cannot change throws (the route answers 400). */
export function setCell(cls: string, column: string, on: unknown, messengers: readonly string[]): void {
	if (!(NOTICE_CLASSES as readonly string[]).includes(cls)) throw new Error(`알 수 없는 분류예요: ${cls}`);
	if (typeof on !== "boolean") throw new Error("on은 true나 false여야 해요");
	const c = cls as NoticeClass;
	if (column === "web") {
		if (!on) throw new Error("웹앱 알림은 끌 수 없어요");
	} else if (column === "push") updateNotifyPush({ [c]: on });
	else if (column === "discord") {
		if (c === "log") throw new Error("기록은 대화별 설정을 따라요");
		savePostSettings({ [c]: on });
	} else if (messengers.includes(column)) {
		const next: Stored = { ...stored(), [column]: { ...stored()[column], [c]: on } };
		writeAtomic(file(), `${JSON.stringify({ messengers: next }, null, 2)}\n`);
	} else throw new Error(`알 수 없는 항목이에요: ${column}`);
}
