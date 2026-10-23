// Custom plugins: <DATA_DIR>/custom/plugins/*.ts|*.js (docs/custom-plugins.md), per-install code that is not part of the
// product. Loaded once when a process starts (the hub, the agent extension, the Claude deny hook); a plugin that fails to
// load, to start or inside a hook is logged and skipped, never fatal. Six hook points, nothing else: `start` (hub only),
// `claim` (Discord channels outside the bot's categories), `thread` (an owner message in a thread), `deny` (shell
// command guard), `reply` and `repliesWithFiles` (sending an approved mail reply with its files). With no plugin installed every call below returns at once. No config.ts import: the command guard
// loads this too.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Claim } from "./discord.ts";

export type { Claim };

/** What the hub hands a plugin at start. */
export type PluginContext = {
	dataDir: string;
	log: (line: string) => void;
	postTo: (channelId: string, text: string) => Promise<void>;
	ack: (channelId: string, messageId: string) => void;
	/** Gives a dotz watch (hub/watch.ts); a watch of that name with the same command is kept, one with another command is replaced. */
	ensureWatch: (spec: Record<string, any>) => void;
	/** Owner approval of a watch that has `approval_minutes`. */
	approveWatch: (name: string) => void;
};
/** An approved reply to a mail the plugin posted. `attachments` are the files staged for the draft, absolute paths on this computer. */
export type MailReply = { source: string; id: string; to: string; subject?: string; body: string; attachments: { name: string; path: string; size: number }[] };
export type MailReplyResult = { ok: boolean; message: string };
export type ThreadMessage = { thread: string; text: string };
/** `note` is appended to the orchestrator's inbox turn for this message; `parentName` replaces the parent's name there. */
export type ThreadReply = { parentName?: string; note?: string };

export type Plugin = {
	/** Defaults to the file name. */
	name?: string;
	/** Once, when the hub has started its watches; claim and thread hooks may run before it, so keep their state at module level. */
	start?(ctx: PluginContext): void;
	/** Owner messages in a channel the bot does not own: `raw` takes them as they are, `thread` makes the channel a thread of `parent`. */
	claim?(channelId: string): Claim | undefined;
	/** Owner message in a thread: side effects, a note for the orchestrator, a parent name. */
	thread?(message: ThreadMessage): ThreadReply | undefined;
	/** A shell command about to run (hub agents and Claude): a string blocks it and is the reason. */
	deny?(command: string, dataDir: string): string | undefined;
	/** Sends an approved mail reply (reply-drafts) for a mail source this plugin posts; `undefined` = not this plugin's source. */
	reply?(draft: MailReply): MailReplyResult | undefined | Promise<MailReplyResult | undefined>;
	/** True when `reply` sends `attachments` for this source. Without it the approval sheet says the files cannot go and asks once more. */
	repliesWithFiles?(source: string): boolean;
};

type Loaded = { name: string; plugin: Plugin };
let loaded: Loaded[] = [];
let note: (line: string) => void = () => undefined;
let didLoad = false;
export const pluginsLoaded = (): boolean => didLoad;

// *.test.ts and *.d.ts may sit next to a plugin (its own tests) and are not plugins.
const isPluginFile = (f: string) => /\.(ts|js)$/.test(f) && !/\.(test|d)\.(ts|js)$/.test(f) && !f.startsWith(".");

/** Replaces the loaded set with the plugins in <dataDir>/custom/plugins. */
export async function loadPlugins(dataDir: string, log: (line: string) => void = () => undefined): Promise<void> {
	note = log;
	loaded = [];
	didLoad = true;
	let files: string[];
	try {
		files = readdirSync(join(dataDir, "custom", "plugins")).filter(isPluginFile).sort();
	} catch {
		return;
	}
	for (const file of files) {
		try {
			const plugin = (await import(pathToFileURL(join(dataDir, "custom", "plugins", file)).href)).default as Plugin | undefined;
			if (!plugin || typeof plugin !== "object") throw new Error("default export is not a plugin object");
			loaded.push({ name: plugin.name ?? file.replace(/\.(ts|js)$/, ""), plugin });
		} catch (error) {
			log(`plugin ${file} not loaded: ${error}`);
		}
	}
	if (loaded.length) log(`plugins: ${loaded.map(l => l.name).join(", ")}`);
}

function each<T>(hook: string, call: (l: Loaded) => T | undefined): { name: string; value: T } | undefined {
	for (const l of loaded) {
		try {
			const value = call(l);
			if (value !== undefined) return { name: l.name, value };
		} catch (error) {
			note(`plugin ${l.name}: ${hook} failed: ${error}`);
		}
	}
	return undefined;
}

/** Runs every plugin's `start`; one that throws is dropped for the rest of the run. */
export function startPlugins(ctx: PluginContext): void {
	loaded = loaded.filter(l => {
		try {
			l.plugin.start?.(ctx);
			return true;
		} catch (error) {
			note(`plugin ${l.name}: start failed, skipped: ${error}`);
			return false;
		}
	});
}

export const pluginClaim = (channelId: string): Claim | undefined => each("claim", l => l.plugin.claim?.(channelId))?.value;

export const pluginThread = (message: ThreadMessage): ThreadReply | undefined => each("thread", l => l.plugin.thread?.(message))?.value;

/** The block reason of the first plugin that denies the command, or undefined. */
export function pluginDeny(command: string, dataDir: string): string | undefined {
	const hit = each("deny", l => l.plugin.deny?.(command, dataDir) || undefined);
	return hit && `Blocked by dotz (custom plugin ${hit.name}): ${hit.value.replace(/\.?$/, ".")}`;
}

/** The first plugin that takes the reply sends it; a throw is a failed send. `undefined` = no plugin owns the source. */
export async function pluginReply(draft: MailReply): Promise<MailReplyResult | undefined> {
	for (const l of loaded) {
		try {
			const result = await l.plugin.reply?.(draft);
			if (result) return result;
		} catch (error) {
			note(`plugin ${l.name}: reply failed: ${error}`);
			return { ok: false, message: `플러그인 ${l.name}이(가) 보내지 못했어요: ${String(error).slice(0, 160)}` };
		}
	}
	return undefined;
}

export const pluginRepliesWithFiles = (source: string): boolean => each("repliesWithFiles", l => l.plugin.repliesWithFiles?.(source) || undefined) !== undefined;
