import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg, DATA_DIR, expand, log, NAME, paths, writeAtomic } from "./config.ts";
import { msg } from "./i18n.ts";
import { threadForReply, threadTitle } from "./threads.ts";
import { metaToSubtext, parseTone, plainChoice, TONE_EMOJI } from "./tone.ts";

const LIMIT = 1900;
// An answer longer than this goes out as a few messages cut at paragraph breaks: a wall of text reads badly on a phone.
export const SOFT_LIMIT = 1200;
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const tokenPath = expand(String(cfg.discord?.token_file ?? ""));
const TOKEN = tokenPath && existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
const GUILD = String(cfg.discord?.guild ?? "");
const OWNER = String(cfg.discord?.owner_id ?? "");
const AVATAR_MARK = join(DATA_DIR, "identity", ".avatar-applied");

export type Thread = { parent: string; name: string };
export type Channels = { category?: string; workCategory?: string; chat?: string; worklog?: string; alert?: string; dm?: string; lanes: Record<string, string>; homes: Record<string, string>; work: Record<string, string>; threads: Record<string, Thread>; archiveAt: Record<string, number> };
export const channels: Channels = existsSync(paths.channels) ? JSON.parse(readFileSync(paths.channels, "utf8")) : { lanes: {} };
channels.lanes ??= {};
// A home lane lives in a thread of an existing work channel: lanes[name] is the thread id, homes[name] the parent channel id.
channels.homes ??= {};
channels.work ??= {};
channels.threads ??= {};
// Done threads stay open (and visible in the sidebar) for ARCHIVE_DELAY_MS so the owner can still track them, then archive.
channels.archiveAt ??= {};
const ARCHIVE_DELAY_MS = 3600_000;
delete (channels as any).rails;
delete (channels as any).railCategory;
let onGone: (id: string) => void = () => {};
export function setChannelGoneHandler(fn: (id: string) => void): void {
	onGone = fn;
}
const save = () => writeAtomic(paths.channels, `${JSON.stringify(channels, null, 2)}\n`);
export const status = { enabled: Boolean(TOKEN && GUILD && OWNER), connected: false, user: "", error: "" };

// Discord lowercases text channel names and turns spaces into dashes; compare in that form.
const textName = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
// Layout without emoji: category "<name>" holds the three main channels (chat, alerts, worklog in the identity's language);
// the work category holds one channel per project, topic or lane, named plainly, with no bot-name prefix.
const fixedNames = () => { const n = msg().channelNames; return { chat: n.chat, alert: n.alert, worklog: n.worklog } as const; };
const workCategoryName = () => msg().channelNames.workCategory(NAME);
export const noEmoji = (s: string) => s.replace(/ ?[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]+/gu, "");
const scrub = (s: string) => noEmoji(s).replace(/[┃|]/g, " ").replace(/\s+/g, " ").trim();
const cleanName = (s: string) => scrub(s).slice(0, 90) || "work";
// Thread names are plain words of what the work is (threads.ts threadTitle); the old "[kind]" prefix is gone.
export const threadName = (title: string, fallback?: string): string => threadTitle(title, fallback);
// A thread starts from a real message in its parent channel (as 오모냥 does), so it shows under that message with its
// content instead of appearing empty with a "you were added" notice. Falls back to a bare thread if the post fails.
// With `fromMessage` (the owner's own message in that channel) the thread hangs from it and nothing new is posted.
async function threadFromMessage(parentId: string, starter: string, name: string, fromMessage?: string): Promise<{ id: string; name: string }> {
	const mid = fromMessage ?? await post(parentId, buildPayloads(starter)[0]!).catch(e => {
		log(`discord: thread starter post failed in ${parentId}: ${e}`);
		return undefined;
	});
	const body = { name, auto_archive_duration: 10080 };
	const t = mid ? await rest("POST", `/channels/${parentId}/messages/${mid}/threads`, body) : await rest("POST", `/channels/${parentId}/threads`, { ...body, type: 11 });
	return { id: String(t.id), name: String(t.name) };
}
// Thread status is a traffic-light reaction on the parent-channel message the thread hangs from (owner 2026-10-19,
// option 3): working 🟡, waiting 🔴 (needs the owner or someone else), done 🟢. Names are never changed for status:
// every rename posts a "changed the channel name" system message that cannot be deleted (50021), and a channel allows
// only 2 renames per 10 minutes. A thread started from a message has that message's id; a bare thread gets no light.
export type ThreadState = "working" | "waiting" | "done";
const LIGHT: Record<ThreadState, string> = { working: "🟡", waiting: "🔴", done: "🟢" };
async function setLight(id: string, parentId: string, state: ThreadState): Promise<void> {
	const base = `/channels/${parentId}/messages/${id}/reactions`;
	for (const [s, e] of Object.entries(LIGHT)) if (s !== state) await rest("DELETE", `${base}/${encodeURIComponent(e)}/@me`).catch(() => undefined);
	await rest("PUT", `${base}/${encodeURIComponent(LIGHT[state])}/@me`).catch(e => log(`thread light ${state} failed on ${id}: ${e}`));
}
// Marks a thread done now and archives it an hour later (kept across restarts in channels.archiveAt).
async function markDone(id: string, parentId: string): Promise<void> {
	await setLight(id, parentId, "done");
	channels.archiveAt[id] = Date.now() + ARCHIVE_DELAY_MS;
	save();
}
let archiveTimer: Timer | undefined;
function startArchiveTimer(): void {
	if (archiveTimer) return;
	archiveTimer = setInterval(() => {
		const now = Date.now();
		for (const [id, at] of Object.entries(channels.archiveAt)) {
			if (at > now) continue;
			delete channels.archiveAt[id];
			save();
			void rest("PATCH", `/channels/${id}`, { archived: true }).catch(e => log(`discord: thread ${id} archive failed: ${e}`));
		}
	}, 60_000);
}
const isWorkParent = (parent?: string) => !!parent && (parent === channels.category || parent === channels.workCategory);

async function rest(method: string, path: string, body?: unknown): Promise<any> {
	for (let attempt = 0; ; attempt++) {
		const r = await fetch(`${process.env.DOTZ_DISCORD_API || "https://discord.com/api/v10"}${path}`, {
			method,
			headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (r.status === 429 && attempt < 3) {
			const wait = Number(((await r.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
			await Bun.sleep(Math.min(wait, 30) * 1000 + 250);
			continue;
		}
		if (!r.ok) throw new Error(`discord ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
		return r.status === 204 ? null : r.json();
	}
}

export async function ensureChannels(): Promise<void> {
	if (!status.enabled) return;
	const all = (await rest("GET", `/guilds/${GUILD}/channels`)) as any[];
	const existing = new Map(all.map(c => [String(c.id), String(c.name)]));
	const parentOf = new Map(all.map(c => [String(c.id), c.parent_id ? String(c.parent_id) : ""]));
	const place = async (id: string, want: string, parent?: string, text = true) => {
		const patch: Record<string, string> = {};
		if (existing.get(id) !== (text ? textName(want) : want)) patch.name = want;
		if (parent && parentOf.get(id) !== parent) patch.parent_id = parent;
		if (Object.keys(patch).length) await rest("PATCH", `/channels/${id}`, patch);
	};
	if (!channels.category || !existing.has(channels.category)) channels.category = (await rest("POST", `/guilds/${GUILD}/channels`, { name: NAME, type: 4 })).id;
	else await place(channels.category, NAME, undefined, false);
	if (!channels.workCategory || !existing.has(channels.workCategory)) channels.workCategory = (await rest("POST", `/guilds/${GUILD}/channels`, { name: workCategoryName(), type: 4 })).id;
	else await place(channels.workCategory, workCategoryName(), undefined, false);
	const fixed = fixedNames();
	for (const [key, name] of Object.entries(fixed) as [keyof typeof fixed, string][]) {
		if (!channels[key] || !existing.has(channels[key]!)) channels[key] = (await rest("POST", `/guilds/${GUILD}/channels`, { name, type: 0, parent_id: channels.category })).id;
		else await place(channels[key]!, name, channels.category);
	}
	// Lane channels keep the owner-facing name they were created or renamed with; only their category is fixed here.
	for (const [lane, id] of Object.entries(channels.lanes)) {
		if (channels.homes[lane]) continue; // a home lane is a thread; the channel list does not include threads
		if (!existing.has(id)) delete channels.lanes[lane];
		else await place(id, existing.get(id)!, channels.workCategory);
	}
	for (const lane of Object.keys(channels.homes)) if (!channels.lanes[lane]) delete channels.homes[lane];
	for (const id of Object.keys(channels.work)) {
		if (!existing.has(id)) {
			delete channels.work[id];
			onGone(id);
		} else channels.work[id] = existing.get(id)!;
	}
	for (const [id, t] of Object.entries(channels.threads)) if (!existing.has(t.parent)) delete channels.threads[id];
	save();
	startArchiveTimer();
	await keepPrivate(all).catch(e => log(`discord: could not hide channels from other bots (needs administrator): ${e}`));
}

// The bot's categories belong to it alone: other bots in the server (each has a managed role tagged with its bot id)
// get View Channel denied on both categories and every channel in them, so they neither read nor answer there.
async function keepPrivate(all: any[]): Promise<void> {
	const VIEW = 1n << 10n;
	const me = (await rest("GET", "/users/@me")) as { id: string };
	const others = ((await rest("GET", `/guilds/${GUILD}/roles`)) as any[]).filter(r => r.tags?.bot_id && r.tags.bot_id !== me.id);
	if (!others.length) return;
	const cats = [channels.category, channels.workCategory].filter(Boolean) as string[];
	const byId = new Map(all.map(c => [String(c.id), c]));
	const targets = new Set([...cats, ...all.filter(c => cats.includes(String(c.parent_id))).map(c => String(c.id))]);
	let changed = 0;
	for (const id of targets)
		for (const role of others) {
			const ow = (byId.get(id)?.permission_overwrites ?? []).find((o: any) => o.id === role.id);
			if (ow && (BigInt(ow.deny) & VIEW) === VIEW) continue;
			await rest("PUT", `/channels/${id}/permissions/${role.id}`, { type: 0, deny: String((ow ? BigInt(ow.deny) : 0n) | VIEW), allow: String(ow ? BigInt(ow.allow) & ~VIEW : 0n) });
			changed++;
		}
	if (changed) log(`discord: hid ${targets.size} channel(s) from ${others.map(r => r.name).join(", ")}`);
}

// Threads under chat or a work channel are sub-topics of that channel (one item, one mail, one task): the owner's
// messages there arrive with the parent's context and the answer goes back into the thread.
const threadParent = (parentId: string) => (parentId === channels.chat ? "chat" : channels.work[parentId] ? `ch:${parentId}` : undefined);

// `starter` is the message posted in the parent channel that the thread hangs from (defaults to the thread name).
export async function createThread(parent: string, name: string, starter?: string): Promise<{ id: string; name: string }> {
	const parentId = resolve(parent);
	if (!status.enabled || !parentId || !threadParent(parentId)) throw new Error(`threads can be made in chat or a work channel (ch:<id>), not ${parent}`);
	const full = threadName(name, starter);
	const t = await threadFromMessage(parentId, starter?.trim() || full, full);
	channels.threads[t.id] = { parent: parentId, name: t.name };
	save();
	return t;
}

// Thread id -> parent channel id, for sub-topic threads and lane threads (a thread made from a message has its id).
const starterThreads = (): Record<string, string> => ({ ...Object.fromEntries(Object.entries(channels.threads).map(([id, x]) => [id, x.parent])), ...Object.fromEntries(Object.entries(channels.homes).map(([lane, parent]) => [channels.lanes[lane], parent])) });

export const threadInfo = (id: string) => {
	const t = channels.threads[id];
	return t ? { ...t, parentTarget: threadParent(t.parent) ?? "chat", parentName: t.parent === channels.chat ? msg().channelNames.chat : (channels.work[t.parent] ?? "?") } : undefined;
};

// Work channels: the owner hands out work by channel, so any other text channel under this bot's categories is a work
// channel with its own context (the server is shared with other bots, so channels elsewhere are never answered).
const notWork = new Set<string>();
async function classify(id: string): Promise<{ work: string } | { thread: string } | undefined> {
	if (channels.work[id]) return { work: channels.work[id] };
	if (channels.threads[id]) return { thread: channels.threads[id].name };
	if (notWork.has(id) || !channels.category) return undefined;
	const c = await rest("GET", `/channels/${id}`).catch(() => undefined);
	if (c && (c.type === 11 || c.type === 12)) {
		const parentKnown = threadParent(c.parent_id) || ("work" in ((await classify(c.parent_id)) ?? {}) ? c.parent_id : undefined);
		if (parentKnown) {
			channels.threads[id] = { parent: c.parent_id, name: String(c.name) };
			save();
			return { thread: String(c.name) };
		}
	}
	if (!c || c.type !== 0 || !isWorkParent(c.parent_id) || [channels.chat, channels.worklog, channels.alert, ...Object.values(channels.lanes)].includes(id)) {
		notWork.add(id);
		return undefined;
	}
	channels.work[id] = String(c.name);
	save();
	log(`work channel #${c.name} (${id}) registered`);
	return { work: channels.work[id] };
}

export async function createWorkChannel(name: string): Promise<{ id: string; name: string }> {
	if (!status.enabled || !channels.workCategory) throw new Error("discord not configured");
	const c = await rest("POST", `/guilds/${GUILD}/channels`, { name: cleanName(name), type: 0, parent_id: channels.workCategory });
	channels.work[c.id] = String(c.name);
	save();
	return { id: c.id, name: c.name };
}

export async function syncProfile(): Promise<void> {
	if (!status.enabled) return;
	const me = await rest("GET", "/users/@me");
	if (me.username !== NAME) {
		await rest("PATCH", "/users/@me", { username: NAME }).then(
			() => log(`discord username set to ${NAME}`),
			e => log(`discord username not changed (Discord allows two changes per hour): ${e}`),
		);
	}
	const avatar = cfg.identity?.avatar ? expand(cfg.identity.avatar) : "";
	if (!avatar || !existsSync(avatar)) return;
	const bytes = readFileSync(avatar);
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (existsSync(AVATAR_MARK) && readFileSync(AVATAR_MARK, "utf8").trim() === sha) return;
	const mime = avatar.toLowerCase().endsWith(".png") ? "image/png" : avatar.toLowerCase().endsWith(".gif") ? "image/gif" : "image/jpeg";
	const data = `data:${mime};base64,${bytes.toString("base64")}`;
	await rest("PATCH", "/users/@me", { avatar: data });
	await rest("PATCH", "/applications/@me", { icon: data }).catch(e => log(`app icon not changed: ${e}`));
	mkdirSync(dirname(AVATAR_MARK), { recursive: true });
	writeFileSync(AVATAR_MARK, `${sha}\n`);
	log(`discord avatar set from ${avatar}`);
}

// `title` is the owner-facing channel name (their language, plain words); the lane name stays the internal key. `place`
// (threads.ts lanePlace) says where it works: a new channel, a thread in a work channel (hanging from the owner's own
// message when it came from there), or an existing sub-topic thread the lane takes over.
export type LaneSpot = { kind: "channel" } | { kind: "thread"; parent: string; fromMessage?: string } | { kind: "adopt"; thread: string; parent: string };
export async function laneChannel(lane: string, title: string | undefined, place: LaneSpot, starter?: string, goal?: string): Promise<string | undefined> {
	if (!status.enabled || !channels.category) return undefined;
	if (!channels.lanes[lane]) {
		if (place.kind === "adopt") {
			channels.lanes[lane] = place.thread;
			channels.homes[lane] = place.parent;
			delete channels.threads[place.thread];
			delete channels.archiveAt[place.thread];
			await setLight(place.thread, place.parent, "working");
		} else if (place.kind === "thread") {
			const full = threadName(title?.trim() || lane, goal);
			const t = await threadFromMessage(place.parent, starter?.trim() || `[run] ${full}`, full, place.fromMessage);
			channels.lanes[lane] = t.id;
			channels.homes[lane] = place.parent;
			await setLight(t.id, place.parent, "working");
		} else channels.lanes[lane] = (await rest("POST", `/guilds/${GUILD}/channels`, { name: cleanName(title?.trim() || lane), type: 0, parent_id: channels.workCategory ?? channels.category })).id;
		save();
	}
	return channels.lanes[lane];
}

// Validates a lane `home` argument (ch:<id> of a known work channel) and returns the channel id.
export function homeChannel(home: string): string {
	const id = home.startsWith("ch:") ? home.slice(3) : "";
	if (!id || !channels.work[id]) throw new Error(`home must be a work channel (ch:<id> from the inbox header or dotz_channel list), not ${home}`);
	return id;
}

// Lane stop for a home lane: a short done marker, a done light and an archive an hour later, the mapping dropped. The parent
// channel is never touched and the thread is not locked, so an owner message there still reaches the orchestrator as a
// thread of that work channel. Other lanes keep their channel.
export async function releaseLane(lane: string): Promise<void> {
	const id = channels.lanes[lane];
	const parentId = channels.homes[lane];
	if (!parentId || !id) return;
	delete channels.lanes[lane];
	delete channels.homes[lane];
	save();
	if (!status.enabled) return;
	await post(id, buildPayloads(msg().threadDone)[0]!, true).catch(e => log(`lane ${lane} done marker failed: ${e}`));
	await markDone(id, parentId).catch(e => log(`lane ${lane} thread done failed: ${e}`));
}

function resolve(target: string): string | undefined {
	if (target.startsWith("lane:")) return channels.lanes[target.slice(5)];
	if (target.startsWith("ch:")) return channels.work[target.slice(3)] ? target.slice(3) : undefined;
	if (target.startsWith("th:")) return channels.threads[target.slice(3)] ? target.slice(3) : undefined;
	if (target === "chat" || target === "worklog" || target === "alert" || target === "dm") return channels[target];
	return undefined;
}

function split(text: string, limit = LIMIT): string[] {
	const out: string[] = [];
	let rest_ = text;
	while (rest_.length > limit) {
		const nl = rest_.lastIndexOf("\n", limit);
		const cut = nl > 200 ? nl : limit;
		out.push(rest_.slice(0, cut));
		rest_ = rest_.slice(cut);
	}
	out.push(rest_);
	return out.filter(s => s.trim());
}

// One answer is one message. Text within LIMIT goes out whole; longer text is cut only at paragraph boundaries (a blank
// line outside a ``` fence) into the fewest messages, paragraphs packed greedily and joined by a blank line. A line ending
// in ":" stays with the paragraph after it, and a single paragraph over LIMIT falls back to the line-based split().
export function chunks(text: string, limit = LIMIT): string[] {
	if (!text.trim()) return [];
	if (text.length <= limit) return [text];
	const blocks: string[] = [];
	let cur: string[] = [];
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		if (!fence && !line.trim()) {
			if (cur.length) blocks.push(cur.join("\n"));
			cur = [];
		} else cur.push(line);
	}
	if (cur.length) blocks.push(cur.join("\n"));
	const paragraphs: string[] = [];
	for (const b of blocks) {
		if (paragraphs.length && /:\s*$/.test(paragraphs.at(-1)!)) paragraphs[paragraphs.length - 1] += `\n\n${b}`;
		else paragraphs.push(b);
	}
	const out: string[] = [];
	let acc = "";
	for (const p of paragraphs) {
		if (acc && acc.length + 2 + p.length <= limit) acc += `\n\n${p}`;
		else if (p.length > limit) {
			if (acc) out.push(acc);
			const parts = split(p, limit);
			acc = parts.pop() ?? "";
			out.push(...parts);
		} else {
			if (acc) out.push(acc);
			acc = p;
		}
	}
	if (acc) out.push(acc);
	return out;
}

// `embeds: []` appears only on PATCH (see edit()), so it is optional.
type Body = { content: string; embeds?: never[]; allowed_mentions?: { parse: never[] }; message_reference?: { message_id: string; fail_if_not_exists: boolean } };
const mentionsOff = { parse: [] as never[] };
const reference = (replyTo?: string) => (replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {});

// Plain message text: the explicit marker becomes the one status emoji, the model's own emoji are stripped (before the
// status emoji is added), choice blocks lose their quote prefixes and meta lines become subtext.
function plainParts(text: string): { emoji: string; body: string } {
	const { tone, text: bare } = parseTone(text);
	return { emoji: tone ? TONE_EMOJI[tone] : "", body: noEmoji(metaToSubtext(plainChoice(readable(tone ? bare.trimStart() : bare)))) };
}

// Discord-mobile layout the model cannot break, outside ``` fences: a "# heading" becomes a bold line, a "| table |"
// becomes "a · b" lines (separator rows dropped), and raw ch:<id> / th:<id> targets become channel links.
export function readable(text: string): string {
	let fence = false;
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			fence = !fence;
			out.push(line);
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}
		const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (h && !line.startsWith("-# ")) {
			out.push(`**${h[1]!.replace(/\*\*/g, "")}**`);
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line)) {
			if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
			out.push(line.trim().replace(/^\|\s*|\s*\|$/g, "").split(/\s*\|\s*/).filter(Boolean).join(" · "));
			continue;
		}
		out.push(line.replace(/(?<![\w<#])(?:ch|th):(\d{17,20})\b/g, "<#$1>"));
	}
	return out.join("\n");
}

// What goes on the wire for one send: plain content only, split by chunks(); the status emoji leads the first message.
// Pure, so it is testable offline.
export function buildPayloads(text: string, replyTo?: string, limit = LIMIT): Body[] {
	const { emoji, body } = plainParts(text);
	const pieces = body.trim() ? chunks(body, limit) : emoji ? [""] : [];
	return pieces.map((piece, i) => ({
		content: i === 0 && emoji ? (piece ? `${emoji} ${piece}` : emoji) : piece,
		allowed_mentions: mentionsOff,
		...(i === 0 ? reference(replyTo) : {}),
	}));
}

// One message that is edited in place or posted as a progress note: never split, too long text is cut to fit.
export function buildSingle(text: string): Body {
	const { emoji, body } = plainParts(text);
	return { content: (emoji && body ? `${emoji} ${body}` : emoji || body).slice(0, LIMIT) };
}

// `reopen` allows unarchiving a thread that Discord auto-archived (50083); lane threads and sub-topic threads qualify.
async function post(id: string, body: Body, reopen = false): Promise<string> {
	try {
		return (await rest("POST", `/channels/${id}/messages`, body)).id;
	} catch (error) {
		const laneThread = Object.keys(channels.homes).some(lane => channels.lanes[lane] === id);
		if (!(reopen || laneThread || channels.threads[id]) || !/50083/.test(String(error))) throw error;
		await rest("PATCH", `/channels/${id}`, { archived: false });
		return (await rest("POST", `/channels/${id}/messages`, body)).id;
	}
}

// ---- Interactive messages (hub/auth.ts): content + components, edits, interaction callbacks ----

export type RichBody = { content: string; components: unknown[] };
/** The part of an INTERACTION_CREATE payload the hub reads. Its values are never logged. */
export type Interaction = {
	id: string;
	token: string;
	type: number;
	member?: { user?: { id?: string } };
	user?: { id?: string };
	data?: { custom_id?: string; components?: { components?: { custom_id?: string; value?: string }[] }[] };
};
let onInteraction: (d: Interaction) => void = () => {};
export function setInteractionHandler(fn: (d: Interaction) => void): void {
	onInteraction = fn;
}

export async function postRich(target: string, body: RichBody): Promise<{ channelId: string; messageId: string }> {
	const channelId = resolve(target);
	if (!channelId) throw new Error(`no discord channel for ${target}`);
	// Body has no `components`; the payload is sent as-is.
	const payload = { allowed_mentions: mentionsOff, ...body } as unknown as Body;
	return { channelId, messageId: await post(channelId, payload) };
}

export async function editRich(channelId: string, messageId: string, body: RichBody): Promise<void> {
	await rest("PATCH", `/channels/${channelId}/messages/${messageId}`, { ...body, allowed_mentions: mentionsOff });
}

// The interaction token is part of the URL; it is stripped from any error text so it cannot reach a log.
export async function interactionCallback(d: Interaction, type: number, data?: unknown): Promise<void> {
	try {
		await rest("POST", `/interactions/${d.id}/${d.token}/callback`, data === undefined ? { type } : { type, data });
	} catch (error) {
		throw new Error(String(error).split(d.token).join("<token>"));
	}
}

const sentAt = new Map<string, number>();
// When the last message (not a progress note) went to a target through send(); the live status line reads it to know
// whether an answer already reached the channel.
export const lastSendAt = (target: string): number => sentAt.get(target) ?? 0;

export async function send(target: string, text: string, replyTo?: string): Promise<{ delivered: boolean; reason?: string; ids?: string[] }> {
	if (!status.enabled) return { delivered: false, reason: "discord not configured (run setup with a bot token)" };
	const id = resolve(target);
	if (!id) return { delivered: false, reason: `unknown target ${target}` };
	const ids: string[] = [];
	sentAt.set(target, Date.now());
	for (const body of buildPayloads(text, replyTo, SOFT_LIMIT)) ids.push(await post(id, body));
	return { delivered: true, ids };
}

export async function edit(target: string, messageId: string, text: string): Promise<{ delivered: boolean; reason?: string; ids?: string[] }> {
	const id = resolve(target);
	if (!status.enabled || !id) return { delivered: false, reason: `unknown target ${target}` };
	// `embeds: []` clears the embed of a legacy message (sent before messages became plain text) when it is edited in place.
	await rest("PATCH", `/channels/${id}/messages/${messageId}`, { ...buildSingle(text), embeds: [] });
	return { delivered: true, ids: [messageId] };
}

// A message that is already gone (404 / Unknown Message) is the state the caller wanted.
export async function deleteMessage(target: string, messageId: string): Promise<void> {
	const id = resolve(target);
	if (!status.enabled || !id) return;
	await rest("DELETE", `/channels/${id}/messages/${messageId}`).catch(e => {
		if (!/ 404 |10008/.test(String(e))) throw e;
	});
}

// One evolving status per (target, key) is a single message edited in place (Dori: grow one message only when it is one
// evolving answer). A progress note is not the answer: clearProgress removes it once the turn's answer is posted.
const progressIds = new Map<string, Map<string, string>>();
export async function progress(target: string, key: string, text: string, replyTo?: string): Promise<{ delivered: boolean; reason?: string; edited?: boolean }> {
	const prev = progressIds.get(target)?.get(key);
	if (prev) return { ...(await edit(target, prev, text)), edited: true };
	if (!status.enabled) return { delivered: false, reason: "discord not configured (run setup with a bot token)" };
	const id = resolve(target);
	if (!id) return { delivered: false, reason: `unknown target ${target}` };
	const mid = await post(id, { ...buildSingle(text), allowed_mentions: mentionsOff, ...reference(replyTo) });
	if (!progressIds.has(target)) progressIds.set(target, new Map());
	progressIds.get(target)!.set(key, mid);
	return { delivered: true, ids: [mid] };
}

// Runs first in clearProgress: the live status line stops its ticker there (and waits for a post still in flight), so no
// late tick can put a message back after the clearing.
let beforeClear: (target: string) => Promise<void> | void = () => {};
export function setBeforeClearHook(fn: (target: string) => Promise<void> | void): void {
	beforeClear = fn;
}

export async function clearProgress(target: string): Promise<void> {
	await beforeClear(target);
	const tracked = progressIds.get(target);
	if (!tracked) return;
	progressIds.delete(target);
	for (const mid of tracked.values()) await deleteMessage(target, mid).catch(e => log(`progress message ${mid} in ${target} not deleted: ${e}`));
}

// Thread status as in Dori, shown as the traffic-light reaction above; done archives it an hour later, other states
// reopen it and cancel a pending archive.
export async function threadStatus(target: string, state: ThreadState): Promise<string> {
	const id = resolve(target);
	const t = id && channels.threads[id];
	if (!status.enabled || !t) throw new Error(`${target} is not a known thread (th:<id>)`);
	if (state === "done") await markDone(id, t.parent);
	else {
		delete channels.archiveAt[id];
		await rest("PATCH", `/channels/${id}`, { archived: false });
		await setLight(id, t.parent, state);
	}
	save();
	return `${LIGHT[state]} ${t.name}`;
}

export function ack(channelId: string, messageId: string): void {
	void rest("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent("👀")}/@me`).catch(e => log(`ack failed: ${e}`));
}
export function typing(target: string): void {
	const id = resolve(target);
	if (status.enabled && id) void rest("POST", `/channels/${id}/typing`).catch(() => undefined);
}

export type Incoming = {
	id: string;
	channelId: string;
	// Where the owner wrote it (the 👀 goes there); differs from channelId when a reply to a thread's starter is routed into the thread.
	ackChannelId: string;
	channel: "chat" | "dm" | "worklog" | "alert" | { lane: string } | { work: string; name: string; first: boolean } | { thread: string; name: string };
	author: string;
	content: string;
	attachments: { name: string; url: string; type?: string }[];
	replyTo?: { author: string; content: string };
};

// Owner messages sent while the gateway restarts or is disconnected are fetched after the next READY, as 오모냥 handles
// "messages between restarts": the id of the last handled owner message is kept on disk, and ids already handled in this
// process are skipped so a message seen both live and in the catch-up is delivered once.
const SEEN_FILE = join(DATA_DIR, "discord-seen.json");
const CATCHUP_MS = 12 * 3600_000;
let lastSeen: string = existsSync(SEEN_FILE) ? String(JSON.parse(readFileSync(SEEN_FILE, "utf8")).last ?? "") : "";
const handled = new Set<string>();
// Shutdown: intake closes first (incoming messages are dropped, lastSeen stays put so the next start's catch-up replays
// them), the socket closes later; `closing` stops the reconnect loop.
let intakeOpen = true;
let closing = false;
let socket: WebSocket | undefined;
export function stopIntake(): void {
	intakeOpen = false;
}
// Closes the gateway socket and resolves once it is closed (at most 3 s); no reconnect afterwards.
export function disconnect(): Promise<void> {
	closing = true;
	const ws = socket;
	if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise(resolve => {
		const timer = setTimeout(resolve, 3000);
		ws.addEventListener("close", () => {
			clearTimeout(timer);
			resolve();
		});
		ws.close(1000, "shutdown");
	});
}
const snowflakeMs = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);

// Edits of recent owner messages: the text of each delivered owner message is kept by id so MESSAGE_UPDATE can be delivered
// as a correction carrying the old text (as 오모냥 does). An edit is delivered once per distinct content.
const EDIT_WINDOW_MS = 15 * 60_000;
const recentTexts = new Map<string, string>();
const remember = (id: string, text: string) => {
	recentTexts.delete(id);
	recentTexts.set(id, text);
	if (recentTexts.size > 500) recentTexts.delete(recentTexts.keys().next().value!);
};

// Returns the text to deliver for a MESSAGE_UPDATE, or undefined when it is not a fresh owner edit (embed unfurl, same text, too old).
export function editedText(m: { id: string; content?: unknown; edited_timestamp?: unknown; author?: { id?: unknown; bot?: boolean } }, now = Date.now()): string | undefined {
	if (m.author?.bot || String(m.author?.id) !== OWNER || !m.edited_timestamp || typeof m.content !== "string") return undefined;
	if (now - snowflakeMs(m.id) > EDIT_WINDOW_MS) return undefined;
	const previous = recentTexts.get(m.id);
	if (previous === m.content) return undefined;
	remember(m.id, m.content);
	return `[edited message: the owner changed an earlier message, treat this as a correction, do not answer the original again; previous text: ${JSON.stringify(previous ?? "(unknown)")}]\n${m.content}`;
}

export function connect(onMessage: (m: Incoming) => void): void {
	if (!status.enabled) return;
	const deliverIncoming = (m: any, channel: Incoming["channel"], edited?: string) => {
		if (!intakeOpen) return;
		if (edited === undefined) {
			if (handled.has(m.id)) return;
			handled.add(m.id);
			remember(m.id, String(m.content ?? ""));
		}
		if (handled.size > 500) handled.delete(handled.values().next().value!);
		if (!lastSeen || BigInt(m.id) > BigInt(lastSeen)) {
			lastSeen = m.id;
			writeAtomic(SEEN_FILE, `${JSON.stringify({ last: lastSeen })}\n`);
		}
		const ref = m.referenced_message;
		onMessage({
			id: m.id,
			channelId: m.channel_id,
			ackChannelId: m.ack_channel_id ?? m.channel_id,
			channel,
			author: m.author.global_name ?? m.author.username,
			content: edited ?? String(m.content ?? ""),
			attachments: (m.attachments ?? []).map((a: any) => ({ name: a.filename, url: a.url, type: a.content_type })),
			...(ref ? { replyTo: { author: ref.author?.bot ? NAME : (ref.author?.global_name ?? ref.author?.username ?? "?"), content: String(ref.content ?? "").slice(0, 300) } } : {}),
		});
	};
	let seq: number | null = null;
	let sessionId = "";
	let resumeUrl = "";
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const open = () => {
		if (closing) return;
		const ws = new WebSocket(resumeUrl || "wss://gateway.discord.gg/?v=10&encoding=json");
		socket = ws;
		let acked = true;
		ws.onmessage = ev => {
			const p = JSON.parse(String(ev.data));
			if (p.s) seq = p.s;
			if (p.op === 10) {
				heartbeat = setInterval(() => {
					// No ACK since the last beat = zombie connection: close and resume.
					if (!acked) return ws.close(4000, "heartbeat ack missing");
					acked = false;
					ws.send(JSON.stringify({ op: 1, d: seq }));
				}, p.d.heartbeat_interval);
				ws.send(JSON.stringify(sessionId && resumeUrl
					? { op: 6, d: { token: TOKEN, session_id: sessionId, seq } }
					: { op: 2, d: { token: TOKEN, intents: INTENTS, properties: { os: "darwin", browser: "dotz", device: "dotz" } } }));
			} else if (p.op === 11) acked = true;
			else if (p.op === 1) ws.send(JSON.stringify({ op: 1, d: seq }));
			else if (p.op === 7) ws.close();
			else if (p.op === 9) {
				sessionId = resumeUrl = "";
				ws.close();
			} else if (p.op === 0 && p.t === "READY") {
				sessionId = p.d.session_id;
				resumeUrl = `${p.d.resume_gateway_url}/?v=10&encoding=json`;
				status.connected = true;
				status.error = "";
				status.user = p.d.user?.username ?? "";
				log(`discord connected as ${status.user}`);
				void catchUp().catch(e => log(`discord catch-up failed: ${e}`));
			} else if (p.op === 0 && p.t === "RESUMED") status.connected = true;
			else if (p.op === 0 && p.t === "MESSAGE_CREATE") handle(p.d);
			else if (p.op === 0 && p.t === "INTERACTION_CREATE") onInteraction(p.d);
			else if (p.op === 0 && p.t === "MESSAGE_UPDATE") {
				const edited = editedText(p.d);
				if (edited !== undefined) handle(p.d, edited);
			} else if (p.op === 0 && p.t === "THREAD_DELETE" && (channels.threads[p.d.id] || Object.values(channels.lanes).includes(p.d.id))) {
				delete channels.threads[p.d.id];
				for (const [lane, id] of Object.entries(channels.lanes)) if (id === p.d.id && channels.homes[lane]) {
					delete channels.lanes[lane];
					delete channels.homes[lane];
				}
				save();
			} else if (p.op === 0 && p.t === "CHANNEL_DELETE" && channels.work[p.d.id]) {
				delete channels.work[p.d.id];
				for (const [id, t] of Object.entries(channels.threads)) if (t.parent === p.d.id) delete channels.threads[id];
				save();
				onGone(p.d.id);
			} else if (p.op === 0 && p.t === "CHANNEL_UPDATE" && channels.work[p.d.id]) {
				if (!isWorkParent(p.d.parent_id)) {
					delete channels.work[p.d.id];
					onGone(p.d.id);
				} else channels.work[p.d.id] = String(p.d.name);
				save();
			}
		};
		ws.onclose = ev => {
			clearInterval(heartbeat);
			status.connected = false;
			status.error = `closed ${ev.code}`;
			if ([4004, 4010, 4011, 4012, 4013, 4014].includes(ev.code)) {
				log(`discord fatal close ${ev.code}; not reconnecting`);
				return;
			}
			if (!closing) setTimeout(open, 5000);
		};
	};
	const catchUp = async () => {
		if (!lastSeen) return;
		const floor = Date.now() - CATCHUP_MS;
		const ids = [channels.chat, channels.dm, channels.worklog, channels.alert, ...Object.values(channels.lanes), ...Object.keys(channels.work), ...Object.keys(channels.threads)].filter((x): x is string => !!x);
		const missed: any[] = [];
		for (const id of new Set(ids)) {
			const list = await rest("GET", `/channels/${id}/messages?after=${lastSeen}&limit=50`).catch(() => []);
			if (Array.isArray(list)) missed.push(...list.filter(m => !m.author?.bot && String(m.author?.id) === OWNER && snowflakeMs(m.id) >= floor && !handled.has(m.id)));
		}
		missed.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
		if (missed.length) log(`discord: catching up ${missed.length} owner message(s) sent while offline`);
		for (const m of missed) handle({ ...m, guild_id: m.guild_id ?? (m.channel_id === channels.dm ? undefined : GUILD) });
	};
	const handle = (m: any, edited?: string) => {
		if (!intakeOpen) return;
		if (m.author?.bot || String(m.author?.id) !== OWNER) return;
		const into = threadForReply(m.message_reference?.message_id, m.channel_id, starterThreads());
		if (into) m = { ...m, channel_id: into, ack_channel_id: m.channel_id };
		const lane = Object.entries(channels.lanes).find(([, id]) => id === m.channel_id)?.[0];
		// chat, worklog and alert are the orchestrator level: owner messages there reach the orchestrator, which routes them.
		const fixed = lane ? { lane } : m.channel_id === channels.chat ? "chat" : m.channel_id === channels.worklog ? "worklog" : m.channel_id === channels.alert ? "alert" : !m.guild_id ? "dm" : undefined;
		if (!fixed && m.guild_id === GUILD) {
			const first = edited === undefined && !channels.work[m.channel_id] && !channels.threads[m.channel_id];
			void classify(m.channel_id).then(c => {
				if (c && "work" in c) deliverIncoming(m, { work: m.channel_id, name: c.work, first }, edited);
				else if (c) deliverIncoming(m, { thread: m.channel_id, name: c.thread }, edited);
			});
			return;
		}
		const channel = fixed;
		if (!channel) return;
		if (channel === "dm" && channels.dm !== m.channel_id) {
			channels.dm = m.channel_id;
			save();
		}
		deliverIncoming(m, channel, edited);
	};
	open();
}
