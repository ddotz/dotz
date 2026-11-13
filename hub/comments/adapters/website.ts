// Generic website adapter (how a site plugs in: docs/comments-api.md). Reading: an RSS comment feed, a JSON endpoint, or a small script of
// the owner's. Posting: a webhook/API or a script. The site's own settings live in ~/.dotz/custom/comments/config.json (`site`); a site's
// script lives next to it under ~/.dotz/custom/comments/sites/. Nothing here names a site.
//
// Script/JSON read output:  {"comments":[{"id","thread","parent?","author","text","postTitle?","postLink?","at"(ISO or ms),"mine?"}],"cursor?"}
// The read output SHOULD include the owner's own replies (mine:true, parent) of the last 30 days, so answered comments close (the hub never sees
// an answer given on the site otherwise).
// A read script is run as `<command...> --since <cursor>`; a JSON endpoint gets `?since=<cursor>`. The cursor `1` means "from the beginning": the owner's past replies
// (mine:true, parent) and the comments they answer, read-only (nothing on the site is marked, no message room is opened). An RSS feed is read as usual.
// Post body (webhook JSON, or stdin of the script): {"sendId","commentId","thread","parent?","text"}; answer {"ok":true,"ref?"} or {"ok":false,"reason"}.
// A script that exits non-zero counts as "may have posted" unless its output says {"sent":"no"}; a webhook 5xx, timeout or cut may have posted too.
//
// DM inbox (optional `site.dm`): read output {"messages":[{"room","id","author","text","at","mine?","title?"}],"cursor?"} from
// `<command...> [--since <cursor>] [--room <room>]` or `GET <url>?since=&room=`; each message becomes a comment of thread `dm:<room>`. A reply goes
// to `site.dm.post` with {"sendId","room","text"} and is then read back (`--room`): it counts as sent only when the room's newest message is the
// owner's with that text. A DM read failure leaves the comments read and is reported as the source's error.
import { join } from "node:path";
import { readSecretFile } from "../../secretbox.ts";
import { type CommentAdapter, DM_THREAD, type RawComment, type ReplyOutcome, sameWords, type SiteConfig } from "../contract.ts";

export type Exec = (argv: string[], stdin?: string, timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export const HISTORY_CURSOR = "1";
const HISTORY_TIMEOUT_MS = 240_000;
export type WebsiteDeps = { exec: Exec; fetch: typeof fetch; secretsDir: string; siteDir: string };

// A site script may start its own helpers (a browser repl, a login keeper) that inherit its pipes: on timeout the whole process group is
// killed, and the pipes are read for at most a moment after the script exited, so a helper left behind cannot hold the watch open.
export const bunExec = async (argv: string[], stdin?: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> => {
	const p = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", detached: true, timeout: timeoutMs, killSignal: "SIGKILL" });
	const kill = () => {
		try {
			process.kill(-p.pid, "SIGKILL");
		} catch {}
	};
	const out = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const code = await p.exited;
	// Helpers still holding the pipes after the script exited are killed with its group; what the script wrote is kept.
	const within = () => Promise.race([out, Bun.sleep(2_000).then(() => undefined)]);
	let read = await within();
	if (!read) {
		kill();
		read = await within();
	}
	return read ? { code, stdout: read[0], stderr: read[1] } : { code: code || 1, stdout: "", stderr: "스크립트가 끝난 뒤에도 출력이 닫히지 않았어요" };
};

const atOf = (v: unknown): number => (typeof v === "number" ? v : Date.parse(String(v ?? "")) || 0);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function parseSiteJson(text: string): { comments: RawComment[]; cursor?: string } {
	const body = JSON.parse(text) as { comments?: Record<string, unknown>[]; cursor?: unknown };
	if (!body || !Array.isArray(body.comments)) throw new Error("읽기 결과에 comments 목록이 없어요");
	const comments = body.comments.flatMap((c): RawComment[] => {
		const native = str(c.id);
		if (!native || !str(c.text).trim()) return [];
		return [{ native, thread: str(c.thread) || "site", ...(c.parent ? { parent: str(c.parent) } : {}), author: str(c.author) || "익명", text: str(c.text), postTitle: str(c.postTitle) || "웹사이트 글", ...(c.postLink ? { postLink: str(c.postLink) } : {}), at: atOf(c.at), ...(c.mine === true ? { mine: true } : {}) }];
	});
	return { comments, ...(body.cursor != null ? { cursor: str(body.cursor) } : {}) };
}

const unescape = (s: string) =>
	s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
const tag = (item: string, name: string) => {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(item);
	return m ? unescape(m[1]!) : "";
};

// A comment feed (e.g. a blog's /comments/feed): one <item> per comment; guid = id, dc:creator = author, description = text, link
// without its #fragment = the post, "Comment on <post> by <author>" = the post title.
export function parseRss(xml: string, owner?: string): RawComment[] {
	const out: RawComment[] = [];
	for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
		const item = m[0];
		const link = tag(item, "link");
		const native = tag(item, "guid") || link;
		const text = tag(item, "description") || tag(item, "content:encoded");
		if (!native || !text) continue;
		const author = tag(item, "dc:creator") || tag(item, "author") || "익명";
		const title = tag(item, "title").replace(/^(Comment on|댓글:?)\s*/i, "").replace(/\s+(by|작성자:?)\s+.*$/i, "") || "웹사이트 글";
		const post = link.split("#")[0] ?? "";
		out.push({ native, thread: post || title, author, text, postTitle: title, ...(post ? { postLink: post } : {}), at: Date.parse(tag(item, "pubDate")) || 0, ...(owner && author === owner ? { mine: true } : {}) });
	}
	return out;
}


export function parseDmJson(text: string): { comments: RawComment[]; cursor?: string } {
	const body = JSON.parse(text) as { messages?: Record<string, unknown>[]; cursor?: unknown };
	if (!body || !Array.isArray(body.messages)) throw new Error("쪽지 읽기 결과에 messages 목록이 없어요");
	const comments = body.messages.flatMap((m): RawComment[] => {
		const room = str(m.room), id = str(m.id);
		if (!room || !id || !str(m.text).trim()) return [];
		return [{ native: `${DM_THREAD}${room}:${id}`, thread: `${DM_THREAD}${room}`, author: str(m.author) || "익명", text: str(m.text), postTitle: str(m.title) || "쪽지", at: atOf(m.at), ...(m.mine === true ? { mine: true } : {}) }];
	});
	return { comments, ...(body.cursor != null ? { cursor: str(body.cursor) } : {}) };
}

// With a DM inbox the adapter's cursor holds both: {"c": comments cursor, "d": DM cursor}. A plain cursor (before the inbox was added) is the comments one.
export function splitCursor(cursor: string | undefined): { c?: string; d?: string } {
	if (cursor?.startsWith('{"c"') || cursor?.startsWith('{"d"')) {
		try {
			const j = JSON.parse(cursor) as { c?: unknown; d?: unknown };
			return { ...(j.c != null ? { c: str(j.c) } : {}), ...(j.d != null ? { d: str(j.d) } : {}) };
		} catch {}
	}
	return cursor === undefined ? {} : { c: cursor };
}

export function websiteAdapter(deps: WebsiteDeps): CommentAdapter {
	const siteOf = (src: { site?: SiteConfig; key: string }): SiteConfig => {
		if (!src.site) throw new Error("이 사이트의 읽기·보내기 설정이 없어요");
		return src.site;
	};
	const command = (argv: string[] | undefined): string[] => {
		if (!argv?.length) throw new Error("실행할 스크립트가 정해지지 않았어요");
		return argv.map(a => a.replace(/^\{site\}/, deps.siteDir));
	};
	const secret = (name?: string): string | undefined => {
		if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
		try {
			return readSecretFile(join(deps.secretsDir, name)).trim();
		} catch {
			return undefined;
		}
	};
	// Reply design 2.3, comment table: "no" only where nothing can have reached the site.
	const no = (code: string, reason: string, detail?: string): ReplyOutcome => ({ ok: false, code, sent: "no", reason, ...(detail ? { detail } : {}) });
	const maybe = (code: string, reason: string, detail?: string): ReplyOutcome => ({ ok: false, code, sent: "maybe", reason, ...(detail ? { detail } : {}) });
	const CONFIG = "사이트 보내기 설정이 올바르지 않아요", UNKNOWN = "보내다가 문제가 생겼어요", REJECTED = "사이트에서 이 글을 받지 않았어요";
	const fetchFailure = (e: unknown): ReplyOutcome => {
		const detail = e instanceof Error ? e.message : String(e);
		const code = (e as { code?: unknown } | undefined)?.code;
		if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return maybe("timeout", "보내는 데 너무 오래 걸려서 멈췄어요", detail);
		if (typeof code === "string" && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused", "FailedToOpenSocket"].includes(code)) return no("offline", "인터넷에 연결되지 않았어요", detail);
		return maybe("net_cut", "보내는 중에 연결이 끊겼어요", detail);
	};
	const deliver = async (post: { kind: "webhook" | "script"; url?: string; command?: string[]; secret?: string }, body: string): Promise<ReplyOutcome> => {
		if (post.kind === "script") {
			if (!post.command?.length) return no("config", CONFIG, "no post command");
			let r: Awaited<ReturnType<Exec>>;
			try {
				r = await deps.exec(command(post.command), body);
			} catch (e) {
				return maybe("unknown", UNKNOWN, e instanceof Error ? e.message : String(e));
			}
			const raw = (r.stderr || r.stdout).trim().slice(0, 500);
			let out: { ok?: boolean; sent?: string; ref?: string } | undefined;
			try {
				out = r.stdout.trim() ? JSON.parse(r.stdout) : { ok: true };
			} catch {
				out = undefined;
			}
			if (r.code !== 0) return out?.sent === "no" ? no("rejected", REJECTED, raw) : maybe("unknown", UNKNOWN, raw || `exit ${r.code}`);
			if (!out) return maybe("unknown", UNKNOWN, raw);
			return out.ok === false ? no("rejected", REJECTED, raw) : { ok: true, ...(out.ref ? { ref: out.ref } : {}) };
		}
		if (!post.url || !/^https?:\/\//.test(post.url)) return no("config", CONFIG, `bad post url ${post.url ?? ""}`);
		const token = secret(post.secret);
		let res: Response;
		try {
			res = await deps.fetch(post.url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
		} catch (e) {
			return fetchFailure(e);
		}
		if (res.status === 401 || res.status === 403) return no("login_expired", "사이트 로그인이 풀렸어요", `http ${res.status}`);
		if (res.status >= 400 && res.status < 500) return no("rejected", REJECTED, `http ${res.status}`);
		if (res.status >= 500) return maybe("server_error", "사이트에서 오류로 답했어요", `http ${res.status}`);
		if (!res.ok) return maybe("unknown", UNKNOWN, `http ${res.status}`);
		const out = (await res.json().catch(() => ({}))) as { ref?: unknown };
		return { ok: true, ...(out.ref ? { ref: str(out.ref) } : {}) };
	};
	const readDms = async (dm: NonNullable<SiteConfig["dm"]>, since?: string, room?: string): Promise<{ comments: RawComment[]; cursor?: string }> => {
		if (dm.read.kind === "script") {
			const r = await deps.exec([...command(dm.read.command), ...(since ? ["--since", since] : []), ...(room ? ["--room", room] : [])]);
			if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 160) || `쪽지 읽기 스크립트가 ${r.code}로 끝났어요`);
			return parseDmJson(r.stdout);
		}
		if (!dm.read.url || !/^https?:\/\//.test(dm.read.url)) throw new Error("쪽지를 읽을 주소가 올바르지 않아요");
		const url = new URL(dm.read.url);
		if (since) url.searchParams.set("since", since);
		if (room) url.searchParams.set("room", room);
		const res = await deps.fetch(url, { headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`사이트가 ${res.status}로 답했어요`);
		return parseDmJson(await res.text());
	};
	const readComments = async (site: SiteConfig, cursor: string | undefined, timeoutMs?: number): Promise<{ comments: RawComment[]; cursor?: string }> => {
		const { read } = site;
		if (read.kind === "script") {
			const r = await deps.exec([...command(read.command), ...(cursor ? ["--since", cursor] : [])], undefined, timeoutMs);
			if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 160) || `읽기 스크립트가 ${r.code}로 끝났어요`);
			return parseSiteJson(r.stdout);
		}
		if (!read.url || !/^https?:\/\//.test(read.url)) throw new Error("읽을 주소가 올바르지 않아요");
		const url = new URL(read.url);
		if (read.kind === "json" && cursor) url.searchParams.set("since", cursor);
		const res = await deps.fetch(url, { headers: { accept: read.kind === "rss" ? "application/rss+xml, application/xml, text/xml" : "application/json" } });
		if (!res.ok) throw new Error(`사이트가 ${res.status}로 답했어요`);
		if (read.kind === "json") return parseSiteJson(await res.text());
		const comments = parseRss(await res.text(), site.owner);
		const newest = comments.reduce((max, c) => Math.max(max, c.at), Number(cursor) || 0);
		return { comments: comments.filter(c => !cursor || c.at > Number(cursor)), cursor: String(newest) };
	};
	return {
		kind: "website",
		async list(src, cursor) {
			const site = siteOf(src);
			if (!site.dm) return readComments(site, cursor);
			const at = splitCursor(cursor);
			const read = await readComments(site, at.c);
			let dms: { comments: RawComment[]; cursor?: string } = { comments: [] };
			let error: string | undefined;
			try {
				dms = await readDms(site.dm, at.d);
			} catch (e) {
				error = `쪽지함: ${e instanceof Error ? e.message.slice(0, 150) : "읽지 못했어요"}`;
			}
			const c = read.cursor ?? at.c, d = dms.cursor ?? at.d;
			return { comments: [...read.comments, ...dms.comments], cursor: JSON.stringify({ ...(c !== undefined ? { c } : {}), ...(d !== undefined ? { d } : {}) }), ...(error ? { error } : {}) };
		},
		// Past replies for the pair file: one read from the beginning. The DM inbox is not read (reading a room can mark it read on the site). A failure throws.
		async history(src, opts) {
			const site = siteOf(src);
			return (await readComments(site, site.read.kind === "rss" ? undefined : HISTORY_CURSOR, Math.max(1_000, Math.min(HISTORY_TIMEOUT_MS, opts.deadline - Date.now())))).comments;
		},
		async reply(src, c, text, sendId) {
			if (!src.site) return no("config", "이 사이트의 읽기·보내기 설정이 없어요");
			const site = src.site;
			if (!c.thread.startsWith(DM_THREAD)) return deliver(site.post, JSON.stringify({ sendId, commentId: c.native, thread: c.thread, ...(c.parent ? { parent: c.parent } : {}), text }));
			if (!site.dm) return no("config", "이 사이트의 쪽지 보내기 설정이 없어요");
			const room = c.thread.slice(DM_THREAD.length);
			const sent = await deliver(site.dm.post, JSON.stringify({ sendId, room, text }));
			if (!sent.ok) return sent;
			// Read back: a 2xx is not proof the message landed in that room.
			try {
				const last = (await readDms(site.dm, undefined, room)).comments.filter(m => m.thread === c.thread).sort((a, b) => a.at - b.at).at(-1);
				if (!last?.mine || !sameWords(last.text, text)) return maybe("readback_mismatch", "보냈다는 답은 왔지만 다시 읽은 마지막 쪽지가 이 답장이 아니에요. 사이트에서 확인해 주세요");
			} catch (e) {
				return maybe("readback_mismatch", "보낸 뒤 다시 읽어 확인하지 못했어요(갔을 수도 있어요)", e instanceof Error ? e.message : String(e));
			}
			return sent;
		},
		// A DM is answered once the owner wrote in that room after it (on the site itself or through dotz).
		answered: (c, mine) => c.thread.startsWith(DM_THREAD) && mine.some(m => m.at >= c.at),
	};
}
