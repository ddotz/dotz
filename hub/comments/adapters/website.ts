// Generic website adapter (how a site plugs in: docs/comments-api.md). Reading: an RSS comment feed, a JSON endpoint, or a small script of
// the owner's. Posting: a webhook/API or a script. The site's own settings live in ~/.dotz/custom/comments/config.json (`site`); a site's
// script lives next to it under ~/.dotz/custom/comments/sites/. Nothing here names a site.
//
// Script/JSON read output:  {"comments":[{"id","thread","parent?","author","text","postTitle?","postLink?","at"(ISO or ms),"mine?"}],"cursor?"}
// A read script is run as `<command...> --since <cursor>`; a JSON endpoint gets `?since=<cursor>`.
// Post body (webhook JSON, or stdin of the script): {"sendId","commentId","thread","parent?","text"}; answer {"ok":true,"ref?"} or {"ok":false,"reason"}.
import { join } from "node:path";
import { readSecretFile } from "../../secretbox.ts";
import type { CommentAdapter, RawComment, SiteConfig } from "../contract.ts";

export type Exec = (argv: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export type WebsiteDeps = { exec: Exec; fetch: typeof fetch; secretsDir: string; siteDir: string };

export const bunExec: Exec = async (argv, stdin) => {
	const p = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => p.kill(), 60_000);
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	clearTimeout(timer);
	return { code, stdout, stderr };
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
	return {
		kind: "website",
		async list(src, cursor) {
			const site = siteOf(src);
			const { read } = site;
			if (read.kind === "script") {
				const r = await deps.exec([...command(read.command), ...(cursor ? ["--since", cursor] : [])]);
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
		},
		async reply(src, c, text, sendId) {
			try {
				const { post } = siteOf(src);
				const body = JSON.stringify({ sendId, commentId: c.native, thread: c.thread, ...(c.parent ? { parent: c.parent } : {}), text });
				if (post.kind === "script") {
					const r = await deps.exec(command(post.command), body);
					if (r.code !== 0) return { ok: false, reason: (r.stderr || r.stdout).trim().slice(0, 160) || `보내기 스크립트가 ${r.code}로 끝났어요` };
					const out = r.stdout.trim() ? (JSON.parse(r.stdout) as { ok?: boolean; reason?: string; ref?: string }) : { ok: true };
					return out.ok === false ? { ok: false, reason: out.reason ?? "사이트가 답글을 받지 않았어요" } : { ok: true, ...(out.ref ? { ref: out.ref } : {}) };
				}
				if (!post.url || !/^https?:\/\//.test(post.url)) return { ok: false, reason: "보낼 주소가 올바르지 않아요" };
				const token = secret(post.secret);
				const res = await deps.fetch(post.url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
				if (!res.ok) return { ok: false, reason: `사이트가 ${res.status}로 답했어요` };
				const out = (await res.json().catch(() => ({}))) as { ref?: unknown };
				return { ok: true, ...(out.ref ? { ref: str(out.ref) } : {}) };
			} catch (e) {
				return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "보내지 못했어요" };
			}
		},
	};
}
