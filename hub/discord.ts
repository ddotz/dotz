import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg, DATA_DIR, expand, log, NAME, paths, writeAtomic } from "./config.ts";
import { embedChoice, extractMeta, metaToSubtext, parseTone, TONE_COLORS, type Tone } from "./tone.ts";

const LIMIT = 1900;
// Embed description cap, and the chunk size used when a toned message is longer (headroom for title and footer).
const EMBED_MAX = 4096;
const EMBED_CHUNK = 4000;
const EMBED_TOTAL = 6000;
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const tokenPath = expand(String(cfg.discord?.token_file ?? ""));
const TOKEN = tokenPath && existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
const GUILD = String(cfg.discord?.guild ?? "");
const OWNER = String(cfg.discord?.owner_id ?? "");
const AVATAR_MARK = join(DATA_DIR, "identity", ".avatar-applied");

export type Thread = { parent: string; name: string };
export type Channels = { category?: string; workCategory?: string; chat?: string; worklog?: string; alert?: string; dm?: string; lanes: Record<string, string>; homes: Record<string, string>; work: Record<string, string>; threads: Record<string, Thread> };
export const channels: Channels = existsSync(paths.channels) ? JSON.parse(readFileSync(paths.channels, "utf8")) : { lanes: {} };
channels.lanes ??= {};
// A home lane lives in a thread of an existing work channel: lanes[name] is the thread id, homes[name] the parent channel id.
channels.homes ??= {};
channels.work ??= {};
channels.threads ??= {};
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
// Layout follows 오모냥 without emoji: category "<name>" holds the three main channels 대화, 알림 and 작업로그; category
// "<name> 작업" holds one channel per project, topic or lane, named plainly, with no bot-name prefix.
const fixed = { chat: "대화", alert: "알림", worklog: "작업로그" } as const;
const workCategoryName = () => `${NAME} 작업`;
export const noEmoji = (s: string) => s.replace(/ ?[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]+/gu, "");
const cleanName = (s: string) => noEmoji(s).replace(/[┃|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "작업";
const isWorkParent = (parent?: string) => !!parent && (parent === channels.category || parent === channels.workCategory);

async function rest(method: string, path: string, body?: unknown): Promise<any> {
	for (let attempt = 0; ; attempt++) {
		const r = await fetch(`https://discord.com/api/v10${path}`, {
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

export async function createThread(parent: string, name: string): Promise<{ id: string; name: string }> {
	const parentId = resolve(parent);
	if (!status.enabled || !parentId || !threadParent(parentId)) throw new Error(`threads can be made in chat or a work channel (ch:<id>), not ${parent}`);
	const t = await rest("POST", `/channels/${parentId}/threads`, { name: cleanName(name), type: 11, auto_archive_duration: 10080 });
	channels.threads[t.id] = { parent: parentId, name: String(t.name) };
	save();
	return { id: t.id, name: t.name };
}

export const threadInfo = (id: string) => {
	const t = channels.threads[id];
	return t ? { ...t, parentTarget: threadParent(t.parent) ?? "chat", parentName: t.parent === channels.chat ? "대화" : (channels.work[t.parent] ?? "?") } : undefined;
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

// `title` is the owner-facing channel name (their language, plain words); the lane name stays the internal key.
// With `home` (ch:<id> of an existing work channel) no channel is made: the lane gets a thread in that channel instead.
export async function laneChannel(lane: string, title?: string, home?: string): Promise<string | undefined> {
	if (!status.enabled || !channels.category) return undefined;
	if (!channels.lanes[lane]) {
		if (home) {
			const parentId = homeChannel(home);
			const t = await rest("POST", `/channels/${parentId}/threads`, { name: cleanName(title?.trim() || lane), type: 11, auto_archive_duration: 10080 });
			channels.lanes[lane] = t.id;
			channels.homes[lane] = parentId;
		} else channels.lanes[lane] = (await rest("POST", `/guilds/${GUILD}/channels`, { name: title?.trim() || lane, type: 0, parent_id: channels.workCategory ?? channels.category })).id;
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

// Lane stop for a home lane: a short done marker, the thread archived with a [done] name, the mapping dropped. The parent
// channel is never touched and the thread is not locked, so an owner message there still reaches the orchestrator as a
// thread of that work channel. Other lanes keep their channel.
export async function releaseLane(lane: string): Promise<void> {
	const id = channels.lanes[lane];
	if (!channels.homes[lane] || !id) return;
	delete channels.lanes[lane];
	delete channels.homes[lane];
	save();
	if (!status.enabled) return;
	await post(id, buildPayloads(`레인 ${lane} 작업을 마쳤어요. 이 스레드는 보관할게요.`)[0]!, true).catch(e => log(`lane ${lane} done marker failed: ${e}`));
	const t = await rest("GET", `/channels/${id}`).catch(() => undefined);
	const base = String(t?.name ?? lane).replace(/^\[(working|waiting|done)\]\s*/, "");
	await rest("PATCH", `/channels/${id}`, { name: `[done] ${base}`.slice(0, 100), archived: true }).catch(e => log(`lane ${lane} thread archive failed: ${e}`));
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

type Embed = { color: number; title?: string; description?: string; footer?: { text: string } };
type Body = { content: string; embeds?: Embed[]; allowed_mentions?: { parse: never[] }; message_reference?: { message_id: string; fail_if_not_exists: boolean } };
const mentionsOff = { parse: [] as never[] };
const reference = (replyTo?: string) => (replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {});

// Title, description and footer of a toned message: meta lines go to the footer, the first line (markdown stripped) to
// the title when it fits, choice blocks lose their quote prefixes and get the recommended badge.
function embedParts(text: string): { title?: string; description: string; footer?: string } {
	const { body, footer } = extractMeta(noEmoji(text));
	const lines = embedChoice(body).trimStart().split("\n");
	// A first line that opens a ``` fence stays in the description, or the fence would lose its opener.
	const title = /^\s*```/.test(lines[0]!) ? "" : lines[0]!.replace(/\*\*|`/g, "").trim();
	const fits = title.length > 0 && title.length <= 256;
	return { ...(fits ? { title } : {}), description: (fits ? lines.slice(1).join("\n") : lines.join("\n")).trim(), ...(footer ? { footer: noEmoji(footer) } : {}) };
}

// What goes on the wire for one send: untoned text is plain content (meta lines as subtext, packed as before); toned text
// is one embed per message, split by chunks() only when the description would not fit. Pure, so it is testable offline.
export function buildPayloads(text: string, fallback?: Tone, replyTo?: string): Body[] {
	const { tone, text: bare } = parseTone(text, fallback);
	const first = (i: number) => (i === 0 ? reference(replyTo) : {});
	if (!tone) return chunks(metaToSubtext(bare)).map((content, i) => ({ content: noEmoji(content), allowed_mentions: mentionsOff, ...first(i) }));
	const p = embedParts(bare);
	const fits = p.description.length <= EMBED_MAX && (p.title?.length ?? 0) + p.description.length + (p.footer?.length ?? 0) <= EMBED_TOTAL;
	const pieces = fits ? [p.description] : chunks(p.description, EMBED_CHUNK);
	return pieces.flatMap((description, i) => {
		const embed: Embed = { color: TONE_COLORS[tone], ...(i === 0 && p.title ? { title: p.title } : {}), ...(description ? { description } : {}), ...(i === pieces.length - 1 && p.footer ? { footer: { text: p.footer } } : {}) };
		return embed.title || embed.description || embed.footer ? [{ content: "", embeds: [embed], allowed_mentions: mentionsOff, ...first(i) }] : [];
	});
}

// One message that is edited in place or posted as a progress note: never split, too long text is cut to fit. The other
// form is cleared (`embeds: []` / `content: ""`) so a note can switch between plain and embed.
export function buildSingle(text: string, fallback?: Tone): Body {
	const { tone, text: bare } = parseTone(text, fallback);
	if (!tone) return { content: noEmoji(metaToSubtext(bare)).slice(0, LIMIT), embeds: [] };
	const p = embedParts(bare);
	const description = p.description.slice(0, Math.min(EMBED_MAX, EMBED_TOTAL - (p.title?.length ?? 0) - (p.footer?.length ?? 0)));
	// An embed with no title, description or footer is rejected by Discord (50006): a bare-marker note gets a blank description.
	return { content: "", embeds: [{ color: TONE_COLORS[tone], ...(p.title ? { title: p.title } : {}), description: description || "\u200b", ...(p.footer ? { footer: { text: p.footer } } : {}) }] };
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

// `fallback` is the tone for text without a marker (alert: fail); an explicit marker in the text always wins.
export async function send(target: string, text: string, replyTo?: string, fallback?: Tone): Promise<{ delivered: boolean; reason?: string; ids?: string[] }> {
	if (!status.enabled) return { delivered: false, reason: "discord not configured (run setup with a bot token)" };
	const id = resolve(target);
	if (!id) return { delivered: false, reason: `unknown target ${target}` };
	const ids: string[] = [];
	for (const body of buildPayloads(text, fallback, replyTo)) ids.push(await post(id, body));
	return { delivered: true, ids };
}

export async function edit(target: string, messageId: string, text: string, fallback?: Tone): Promise<{ delivered: boolean; reason?: string; ids?: string[] }> {
	const id = resolve(target);
	if (!status.enabled || !id) return { delivered: false, reason: `unknown target ${target}` };
	await rest("PATCH", `/channels/${id}/messages/${messageId}`, buildSingle(text, fallback));
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
	if (prev) return { ...(await edit(target, prev, text, "run")), edited: true };
	if (!status.enabled) return { delivered: false, reason: "discord not configured (run setup with a bot token)" };
	const id = resolve(target);
	if (!id) return { delivered: false, reason: `unknown target ${target}` };
	const mid = await post(id, { ...buildSingle(text, "run"), allowed_mentions: mentionsOff, ...reference(replyTo) });
	if (!progressIds.has(target)) progressIds.set(target, new Map());
	progressIds.get(target)!.set(key, mid);
	return { delivered: true, ids: [mid] };
}

export async function clearProgress(target: string): Promise<void> {
	const tracked = progressIds.get(target);
	if (!tracked) return;
	progressIds.delete(target);
	for (const mid of tracked.values()) await deleteMessage(target, mid).catch(e => log(`progress message ${mid} in ${target} not deleted: ${e}`));
}

// Thread status as in Dori: a [working]/[waiting]/[done] prefix on the name; done archives it, other states reopen it.
export async function threadStatus(target: string, state: "working" | "waiting" | "done"): Promise<string> {
	const id = resolve(target);
	const t = id && channels.threads[id];
	if (!status.enabled || !t) throw new Error(`${target} is not a known thread (th:<id>)`);
	const name = `[${state}] ${t.name.replace(/^\[(working|waiting|done)\]\s*/, "")}`.slice(0, 100);
	if (state !== "done") await rest("PATCH", `/channels/${id}`, { archived: false });
	const r = await rest("PATCH", `/channels/${id}`, { name, ...(state === "done" ? { archived: true } : {}) });
	t.name = String(r.name);
	save();
	return t.name;
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
		const ws = new WebSocket(resumeUrl || "wss://gateway.discord.gg/?v=10&encoding=json");
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
			setTimeout(open, 5000);
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
		if (m.author?.bot || String(m.author?.id) !== OWNER) return;
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
