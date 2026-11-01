// Which conversations also go to Discord. The web app always gets every message; Discord gets a kind only while its switch is on, so
// the owner who reads on the web is not sent everything twice. Kept in <DATA_DIR>/discord-post.json: the owner's own setting in the data
// folder, never in the code. A missing or broken file is every kind on (Discord got everything before this switch existed) except
// web_lanes; migratePostSettings writes the first file so an install without Discord starts all off (web only).
// web_lanes: a session started from the web or terminal also gets a Discord channel/thread and posts there (off: it lives in the web).
// ask / result / news / conv are the notice classes (hub/notice-class.ts) as the owner's per-class "디스코드로도 보내기" switches (alert is the
// alert key above). A file written before they existed lacks them: each then follows today's kind (ask, news, conv: chat; result: lanes).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import { splitTone } from "./tone.ts";

export const POST_KINDS = ["chat", "lanes", "alert", "worklog", "web_lanes", "ask", "result", "news", "conv"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export type PostSettings = Record<PostKind, boolean>;

const file = () => join(DATA_DIR, "discord-post.json");
const ALL_ON: PostSettings = { chat: true, lanes: true, alert: true, worklog: true, web_lanes: false, ask: true, result: true, news: true, conv: true };
const ALL_OFF: PostSettings = { chat: false, lanes: false, alert: false, worklog: false, web_lanes: false, ask: false, result: false, news: false, conv: false };
// A class key the file does not hold yet follows the kind it was part of.
const CLASS_FALLBACK = { ask: "chat", result: "lanes", news: "chat", conv: "chat" } as const;

// Gateway start: the first file is today's routing where Discord is connected (nothing changes for that owner), all off where it
// is not, so connecting Discord later sends nothing until the owner turns kinds on. An existing file is never touched.
export function migratePostSettings(discordOn: boolean): void {
	if (existsSync(file())) return;
	writeAtomic(file(), `${JSON.stringify(discordOn ? ALL_ON : ALL_OFF)}\n`);
}

// A lane with no Discord place (started from the web, hub/threads.ts lanePlace); main.ts installs the lane-record reader.
let webLane: (name: string) => boolean = () => false;
export function setWebLane(fn: (name: string) => boolean): void {
	webLane = fn;
}

// alert / worklog are the gateway's own conversations, lane:<name> a session; everything else (main, work channels, threads) is chat.
export function postKind(target: string): PostKind {
	if (target === "alert") return "alert";
	if (target === "worklog") return "worklog";
	if (target.startsWith("lane:")) return "lanes";
	return "chat";
}

// The notice class of an outgoing post (hub/notice-class.ts), or undefined when none of the class switches decides it (progress, work log,
// anything else): then the target's kind does. `extra` is the post's event fields (source, update_key, system, mail; news = a monitor's post, hub/main.ts).
export function postClass(target: string, text: string, extra: Record<string, unknown> = {}): PostKind | undefined {
	const { tone } = splitTone(text);
	if (tone === "run" || target === "worklog" || typeof extra.update_key === "string") return undefined;
	if (tone === "ask") return "ask";
	if (target === "alert") return "alert";
	if (target.startsWith("lane:")) return tone === "done" || tone === "fail" || extra.lane_report === true ? "result" : undefined;
	if (extra.mail === true || extra.news === true) return "news";
	const bot = extra.source === undefined || extra.source === "orchestrator";
	return bot && !extra.system && /^(?:main|ch:|th:|settings:)/.test(target) ? "conv" : undefined;
}

let cache: { stamp: string; v: PostSettings } | undefined;
export function postSettings(): PostSettings {
	let stamp: string;
	try {
		const st = statSync(file());
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		return { ...ALL_ON };
	}
	if (cache?.stamp === stamp) return { ...cache.v };
	let v = { ...ALL_ON };
	try {
		const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
		for (const k of POST_KINDS) if (typeof raw?.[k] === "boolean") v[k] = raw[k] as boolean;
		for (const [k, from] of Object.entries(CLASS_FALLBACK)) if (typeof raw?.[k] !== "boolean") v[k as PostKind] = v[from];
	} catch {
		v = { ...ALL_ON };
	}
	cache = { stamp, v };
	return { ...v };
}

// Merges the booleans it is given (unknown keys and non-booleans are a 400 at the route) and returns the whole setting.
export function savePostSettings(patch: Record<string, unknown>): PostSettings {
	const next = postSettings();
	for (const [k, val] of Object.entries(patch)) {
		if (!(POST_KINDS as readonly string[]).includes(k) || typeof val !== "boolean") throw new Error(`알 수 없는 항목이에요: ${k}`);
		next[k as PostKind] = val;
	}
	writeAtomic(file(), `${JSON.stringify(next)}\n`);
	return next;
}

// Whether a post to `target` goes to Discord. An answer to a message the owner wrote on Discord (a Discord message id) always does:
// he asked there, so the answer has to be there.
// A web lane never does: it has no Discord place.
// `cls` (postClass): when given, its switch decides; without it the target's kind does.
export const discordPosts = (target: string, replyTo?: string, cls?: PostKind): boolean =>
	!(target.startsWith("lane:") && webLane(target.slice(5))) && (postSettings()[cls ?? postKind(target)] || (!!replyTo && /^\d{17,20}$/.test(replyTo)));
