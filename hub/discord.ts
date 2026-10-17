import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg, DATA_DIR, expand, log, NAME, paths } from "./config.ts";

const LIMIT = 1900;
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const tokenPath = expand(String(cfg.discord?.token_file ?? ""));
const TOKEN = tokenPath && existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
const GUILD = String(cfg.discord?.guild ?? "");
const OWNER = String(cfg.discord?.owner_id ?? "");
const AVATAR_MARK = join(DATA_DIR, "identity", ".avatar-applied");

export type Thread = { parent: string; name: string };
export type Channels = { category?: string; workCategory?: string; chat?: string; worklog?: string; alert?: string; dm?: string; lanes: Record<string, string>; work: Record<string, string>; threads: Record<string, Thread> };
export const channels: Channels = existsSync(paths.channels) ? JSON.parse(readFileSync(paths.channels, "utf8")) : { lanes: {} };
channels.lanes ??= {};
channels.work ??= {};
channels.threads ??= {};
delete (channels as any).rails;
delete (channels as any).railCategory;
let onGone: (id: string) => void = () => {};
export function setChannelGoneHandler(fn: (id: string) => void): void {
	onGone = fn;
}
const save = () => writeFileSync(paths.channels, `${JSON.stringify(channels, null, 2)}\n`);
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
		if (!existing.has(id)) delete channels.lanes[lane];
		else await place(id, existing.get(id)!, channels.workCategory);
	}
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
export async function laneChannel(lane: string, title?: string): Promise<string | undefined> {
	if (!status.enabled || !channels.category) return undefined;
	if (!channels.lanes[lane]) {
		channels.lanes[lane] = (await rest("POST", `/guilds/${GUILD}/channels`, { name: title?.trim() || lane, type: 0, parent_id: channels.workCategory ?? channels.category })).id;
		save();
	}
	return channels.lanes[lane];
}

function resolve(target: string): string | undefined {
	if (target.startsWith("lane:")) return channels.lanes[target.slice(5)];
	if (target.startsWith("ch:")) return channels.work[target.slice(3)] ? target.slice(3) : undefined;
	if (target.startsWith("th:")) return channels.threads[target.slice(3)] ? target.slice(3) : undefined;
	if (target === "chat" || target === "worklog" || target === "alert" || target === "dm") return channels[target];
	return undefined;
}

function split(text: string): string[] {
	const out: string[] = [];
	let rest_ = text;
	while (rest_.length > LIMIT) {
		const nl = rest_.lastIndexOf("\n", LIMIT);
		const cut = nl > 200 ? nl : LIMIT;
		out.push(rest_.slice(0, cut));
		rest_ = rest_.slice(cut);
	}
	out.push(rest_);
	return out.filter(s => s.trim());
}

// Replies read like a person chatting (Dori writing rules): one message per paragraph, a fenced code block stays whole,
// a line ending in ":" stays with the list after it, and a long tail is folded into the last message.
const MAX_CHUNKS = 6;
export function chunks(text: string): string[] {
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
	const merged: string[] = [];
	for (const b of blocks) {
		if (merged.length && /:\s*$/.test(merged.at(-1)!)) merged[merged.length - 1] += `\n${b}`;
		else merged.push(b);
	}
	while (merged.length > MAX_CHUNKS) merged.splice(MAX_CHUNKS - 1, 2, `${merged[MAX_CHUNKS - 1]}\n\n${merged[MAX_CHUNKS]}`);
	return merged.flatMap(split);
}

async function post(id: string, content: string, replyTo?: string): Promise<string> {
	const body = { content: noEmoji(content), allowed_mentions: { parse: [] }, ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}) };
	try {
		return (await rest("POST", `/channels/${id}/messages`, body)).id;
	} catch (error) {
		if (!channels.threads[id] || !/50083/.test(String(error))) throw error;
		await rest("PATCH", `/channels/${id}`, { archived: false });
		return (await rest("POST", `/channels/${id}/messages`, body)).id;
	}
}

export async function send(target: string, text: string, replyTo?: string, opts: { single?: boolean } = {}): Promise<{ delivered: boolean; reason?: string; ids?: string[] }> {
	if (!status.enabled) return { delivered: false, reason: "discord not configured (run setup with a bot token)" };
	const id = resolve(target);
	if (!id) return { delivered: false, reason: `unknown target ${target}` };
	const ids: string[] = [];
	for (const [i, part] of (opts.single ? split(text) : chunks(text)).entries()) ids.push(await post(id, part, i === 0 ? replyTo : undefined));
	return { delivered: true, ids };
}

export async function edit(target: string, messageId: string, text: string): Promise<{ delivered: boolean; reason?: string; ids?: string[] }> {
	const id = resolve(target);
	if (!status.enabled || !id) return { delivered: false, reason: `unknown target ${target}` };
	await rest("PATCH", `/channels/${id}/messages/${messageId}`, { content: noEmoji(text).slice(0, LIMIT) });
	return { delivered: true, ids: [messageId] };
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

export function connect(onMessage: (m: Incoming) => void): void {
	if (!status.enabled) return;
	const deliverIncoming = (m: any, channel: Incoming["channel"]) => {
		if (handled.has(m.id)) return;
		handled.add(m.id);
		if (handled.size > 500) handled.delete(handled.values().next().value!);
		if (!lastSeen || BigInt(m.id) > BigInt(lastSeen)) {
			lastSeen = m.id;
			writeFileSync(SEEN_FILE, `${JSON.stringify({ last: lastSeen })}\n`);
		}
		const ref = m.referenced_message;
		onMessage({
			id: m.id,
			channelId: m.channel_id,
			channel,
			author: m.author.global_name ?? m.author.username,
			content: String(m.content ?? ""),
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
			else if (p.op === 0 && p.t === "THREAD_DELETE" && channels.threads[p.d.id]) {
				delete channels.threads[p.d.id];
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
	const handle = (m: any) => {
		if (m.author?.bot || String(m.author?.id) !== OWNER) return;
		const lane = Object.entries(channels.lanes).find(([, id]) => id === m.channel_id)?.[0];
		// chat, worklog and alert are the orchestrator level: owner messages there reach the orchestrator, which routes them.
		const fixed = lane ? { lane } : m.channel_id === channels.chat ? "chat" : m.channel_id === channels.worklog ? "worklog" : m.channel_id === channels.alert ? "alert" : !m.guild_id ? "dm" : undefined;
		if (!fixed && m.guild_id === GUILD) {
			const first = !channels.work[m.channel_id] && !channels.threads[m.channel_id];
			void classify(m.channel_id).then(c => {
				if (c && "work" in c) deliverIncoming(m, { work: m.channel_id, name: c.work, first });
				else if (c) deliverIncoming(m, { thread: m.channel_id, name: c.thread });
			});
			return;
		}
		const channel = fixed;
		if (!channel) return;
		if (channel === "dm" && channels.dm !== m.channel_id) {
			channels.dm = m.channel_id;
			save();
		}
		deliverIncoming(m, channel);
	};
	open();
}
