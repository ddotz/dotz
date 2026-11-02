// Custom plugins: <DATA_DIR>/custom/plugins/*.ts|*.js (docs/custom-plugins.md), per-install code that is not part of the
// product. Loaded when a process starts (the hub, the agent extension, the Claude deny hook) and reloaded before a hook
// runs when a plugin file was edited, added or removed (`refresh`); a plugin that fails to
// load, to start or inside a hook is logged and skipped, never fatal. Six hook points, nothing else: `start` (hub only),
// `claim` (Discord channels outside the bot's categories), `thread` (an owner message in a thread), `deny` (shell
// command guard), `reply` and `repliesWithFiles` (sending an approved mail reply with its files). With no plugin installed every call below returns at once. No config.ts import: the command guard
// loads this too.
import { readdirSync, statSync } from "node:fs";
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
/**
 * An approved reply to a mail the plugin posted. `attachments` are the files staged for the draft, absolute paths on this computer.
 * `to` is one address or a comma list of them (the owner may keep several on the card); `cc` is the 참조 list the same way, absent or ""
 * when there is none; `all` is true when the owner picked 전체 답장, so a source that can differ between 답장 and 전체 답장 (a mail UI's own
 * 회신 / 모두 회신) should follow it. A plugin must send every address it is given, or return ok: false saying what it cannot send.
 */
export type MailReply = { source: string; id: string; to: string; cc?: string; all?: boolean; subject?: string; body: string; attachments: { name: string; path: string; size: number }[] };
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

type Loaded = { name: string; plugin: Plugin; file: string };
let loaded: Loaded[] = [];
let pluginDir = "";
/** File name -> mtime of its last load attempt, loaded or failed, so an unchanged broken file is not retried on every hook. */
let seen = new Map<string, number>();
/** Files whose `start` threw: they stay out until the next loadPlugins, edited or not. */
let dropped = new Set<string>();
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
	pluginDir = join(dataDir, "custom", "plugins");
	seen = new Map();
	dropped = new Set();
	const files = pluginFiles();
	for (const [file, mtime] of files) {
		seen.set(file, mtime);
		try {
			loaded.push(asLoaded((await import(pathToFileURL(join(pluginDir, file)).href)).default, file));
		} catch (error) {
			log(`plugin ${file} not loaded: ${error}`);
		}
	}
	if (loaded.length) log(`plugins: ${loaded.map(l => l.name).join(", ")}`);
}

/** The plugin files in pluginDir with their mtimes, in name order; none when the dir is missing. */
function pluginFiles(): Map<string, number> {
	const files = new Map<string, number>();
	let names: string[];
	try {
		names = readdirSync(pluginDir).filter(isPluginFile).sort();
	} catch {
		return files;
	}
	for (const name of names) {
		try {
			files.set(name, statSync(join(pluginDir, name)).mtimeMs);
		} catch {
			// removed between readdir and stat: treated as gone
		}
	}
	return files;
}

function asLoaded(plugin: unknown, file: string): Loaded {
	if (!plugin || typeof plugin !== "object") throw new Error("default export is not a plugin object");
	return { name: (plugin as Plugin).name ?? file.replace(/\.(ts|js)$/, ""), plugin: plugin as Plugin, file };
}

/**
 * Picks up plugin files edited, added or removed since they were loaded: one readdir and a stat per file, no file reads unless
 * something changed. The hooks are synchronous, so the new code comes in through require() with a `?v=<mtime>` query (Bun keeps
 * ESM modules cached by URL; the query makes a new module, the plugin's own imports stay cached). A plugin with top-level await
 * cannot be required and, like any reload that throws, keeps its previous version, logged. `start` is not re-run for a reloaded
 * or added plugin: it is the hub's one-time setup (watches), so a reloaded plugin keeps module-level state from its new code only.
 */
function refresh(): void {
	if (!pluginDir) return;
	const files = pluginFiles();
	if (files.size === seen.size && [...files].every(([file, mtime]) => seen.get(file) === mtime)) return;
	let next = loaded.filter(l => files.has(l.file));
	for (const l of loaded) if (!files.has(l.file)) note(`plugin ${l.name} removed`);
	for (const file of seen.keys()) if (!files.has(file)) seen.delete(file);
	for (const [file, mtime] of files) {
		if (seen.get(file) === mtime || dropped.has(file)) continue;
		seen.set(file, mtime);
		try {
			const fresh = asLoaded(require(`${join(pluginDir, file)}?v=${mtime}`).default, file);
			next = next.filter(l => l.file !== file).concat(fresh);
			note(`plugin ${fresh.name} reloaded`);
		} catch (error) {
			note(`plugin ${file} not reloaded${next.some(l => l.file === file) ? ", keeping the previous version" : ""}: ${error}`);
		}
	}
	loaded = next.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function each<T>(hook: string, call: (l: Loaded) => T | undefined): { name: string; value: T } | undefined {
	refresh();
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
			dropped.add(l.file);
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
	refresh();
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
