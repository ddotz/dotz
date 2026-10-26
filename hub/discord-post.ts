// Which conversations also go to Discord. The web app always gets every message; Discord gets a kind only while its switch is on, so
// the owner who reads on the web is not sent everything twice. Kept in <DATA_DIR>/discord-post.json: the owner's own setting in the data
// folder, never in the code. A missing or broken file is every kind on (Discord got everything before this switch existed).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";

export const POST_KINDS = ["chat", "lanes", "alert", "worklog"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export type PostSettings = Record<PostKind, boolean>;

const file = () => join(DATA_DIR, "discord-post.json");
const ALL_ON: PostSettings = { chat: true, lanes: true, alert: true, worklog: true };

// alert / worklog are the gateway's own conversations, lane:<name> a session; everything else (main, work channels, threads) is chat.
export function postKind(target: string): PostKind {
	if (target === "alert") return "alert";
	if (target === "worklog") return "worklog";
	if (target.startsWith("lane:")) return "lanes";
	return "chat";
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
export const discordPosts = (target: string, replyTo?: string): boolean => postSettings()[postKind(target)] || (!!replyTo && /^\d{17,20}$/.test(replyTo));
