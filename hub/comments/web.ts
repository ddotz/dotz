// Web routes of the comment feature (contract: docs/comments-api.md): /api/comments/*. Only the sources the owner chose are listed, readable
// or sendable. Events carry ids only, never a body. A reply goes out only through engine.send -> dispatchReply (contract.ts).
import type { Engine } from "./engine.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const OFF = { error: "댓글 연동이 꺼져 있어요" };
const MAX_TEXT = 2000;
const MAX_EXTRA = 500;

export type WebDeps = { engine: Engine; broadcast: (event: Record<string, unknown>) => void };

export function createCommentsWeb({ engine, broadcast }: WebDeps) {
	const drafting = new Set<string>();
	const pending = new Set<Promise<unknown>>();
	const track = (p: Promise<unknown>) => {
		pending.add(p);
		void p.finally(() => pending.delete(p));
	};

	async function route(req: Request, url: URL, parts: string[]): Promise<Response | undefined> {
		if (parts[0] !== "api" || parts[1] !== "comments") return undefined;
		const cfg = engine.store.config();
		const area = parts[2];
		const method = req.method;
		const body = async (): Promise<Record<string, any>> => ((await req.json().catch(() => ({}))) as Record<string, any>) ?? {};
		const arg = (i: number) => decodeURIComponent(parts[i] ?? "");

		if (area === "changed" && method === "POST") {
			const b = await body();
			for (const s of Array.isArray(b.threads) ? b.threads.slice(0, 50) : []) if (typeof s?.source === "string") broadcast({ kind: "comment", source: s.source, thread: String(s.thread ?? "") });
			return json({ ok: true });
		}
		if (area === "sources" && parts.length === 3 && method === "GET") {
			if (!cfg.enabled) return json({ on: false, sources: [] });
			const cursors = engine.store.cursors();
			return json({
				on: true,
				sources: Object.values(cfg.sources).map(s => ({ key: s.key, kind: s.kind, app: engine.ownerOf(s), label: s.label, watch: s.watch, autoDraft: s.autoDraft, autoSend: s.autoSend?.on === true, error: cursors[s.key]?.error ?? null, ranAt: cursors[s.key]?.ranAt ?? null })),
			});
		}
		if (area === "sources" && parts.length >= 4) {
			if (!cfg.enabled) return json(OFF, 409);
			const key = arg(3);
			if (!cfg.sources[key]) return json({ error: "그 댓글 출처를 찾지 못했어요" }, 404);
			if (parts.length === 5 && parts[4] === "posts" && method === "GET") {
				try {
					const watch = cfg.sources[key]!.watch;
					return json({ posts: (await engine.posts(key)).map(p => ({ ...p, watched: watch.includes("*") || watch.includes(p.id) })), all: watch.includes("*") });
				} catch {
					return json({ posts: [], error: "글 목록을 불러오지 못했어요" });
				}
			}
			if (parts.length === 4 && method === "PUT") {
				const b = await body();
				const okList = b.watch === undefined || (Array.isArray(b.watch) && b.watch.every((x: unknown) => typeof x === "string" && x.length <= 200) && b.watch.length <= 500);
				if (!okList || (b.autoDraft !== undefined && typeof b.autoDraft !== "boolean")) return json({ error: "watch (글 id 목록) / autoDraft (true/false) 형식이 아니에요" }, 400);
				const next = engine.update(key, { ...(b.watch !== undefined ? { watch: b.watch } : {}), ...(b.autoDraft !== undefined ? { autoDraft: b.autoDraft } : {}) });
				return json({ ok: true, watch: next?.watch ?? [], autoDraft: next?.autoDraft === true });
			}
			return undefined;
		}
		if (area === "threads" && parts.length === 3 && method === "GET") {
			if (!cfg.enabled) return json(OFF, 409);
			return json({ threads: engine.threads(url.searchParams.get("app") ?? "") });
		}
		if (area === "thread" && parts.length >= 5) {
			if (!cfg.enabled) return json(OFF, 409);
			const source = arg(3);
			const thread = arg(4);
			if (parts.length === 5 && method === "GET") {
				const view = engine.threadView(source, thread);
				return view ? json(view) : json({ error: "이 글은 보고 있지 않아요" }, 404);
			}
			if (parts.length === 6 && parts[5] === "read" && method === "POST") {
				if (!engine.threadView(source, thread)) return json({ error: "이 글은 보고 있지 않아요" }, 404);
				engine.markRead(source, thread);
				return json({ ok: true });
			}
			return undefined;
		}
		if (area === "comment" && parts.length === 5 && parts[4] === "no-reply" && (method === "POST" || method === "DELETE")) {
			if (!cfg.enabled) return json(OFF, 409);
			return engine.noReply(arg(3), method === "POST") ? json({ ok: true }) : json({ error: "원댓글을 찾지 못했어요" }, 404);
		}
		if (area === "comment" && parts.length === 5 && parts[4] === "draft" && method === "POST") {
			if (!cfg.enabled) return json(OFF, 409);
			const id = arg(3);
			const c = engine.store.comments().find(x => x.id === id);
			if (!c || !cfg.sources[c.source]) return json({ error: "원댓글을 찾지 못했어요" }, 404);
			if (drafting.has(id)) return json({ error: "이 댓글은 초안을 만드는 중이에요" }, 409);
			// `{ text, extra? }`: a draft written outside (a script of the owner), no model call; it still waits for the owner's 보내기.
			const b = await body();
			if (b.text !== undefined || b.extra !== undefined) {
				if (typeof b.text !== "string" || !b.text.trim() || [...b.text].length > MAX_TEXT) return json({ error: `text: 1자에서 ${MAX_TEXT}자 사이여야 해요` }, 400);
				if (b.extra !== undefined && (typeof b.extra !== "string" || [...b.extra].length > MAX_EXTRA)) return json({ error: `extra: ${MAX_EXTRA}자 이하 글이어야 해요` }, 400);
				const s = engine.addDraft(id, b.text, b.extra?.trim() || undefined);
				return s.ok ? json({ code: s.draft.code, state: "pending" }) : json({ error: s.reason }, 409);
			}
			drafting.add(id);
			track(
				engine
					.makeDraft(id)
					.then(s => {
						if (!s.ok) broadcast({ kind: "comment_draft", source: c.source, thread: c.thread, error: s.reason });
					})
					.finally(() => drafting.delete(id)),
			);
			return json({ state: "drafting" }, 202);
		}
		if (area === "drafts" && parts.length === 5 && method === "POST") {
			if (!cfg.enabled) return json(OFF, 409);
			const code = arg(3);
			const d = engine.store.drafts().find(x => x.code === code);
			if (!d) return json({ error: "그 초안을 찾지 못했어요" }, 404);
			if (parts[4] === "drop") {
				const r = engine.drop(code);
				return r.ok ? json({ ok: true }) : json({ error: r.reason }, 409);
			}
			if (parts[4] === "revise") {
				const change = String((await body()).change ?? "");
				const step = await engine.revise(code, change);
				return step.ok ? json({ ok: true, code: step.draft.code }) : json({ error: step.reason }, 409);
			}
			if (parts[4] === "send") {
				const text = (await body()).text;
				if (text !== undefined && (typeof text !== "string" || !text.trim() || [...text].length > MAX_TEXT)) return json({ error: `글은 1자에서 ${MAX_TEXT}자 사이여야 해요` }, 400);
				const r = engine.send(code, { by: "owner", ...(text !== undefined ? { text } : {}) });
				return r.ok ? json({ id: r.reply.id, state: "sending" }, 202) : json({ error: r.reason }, 409);
			}
		}
		return undefined;
	}

	const idle = async () => {
		while (pending.size) await Promise.all([...pending]);
		await engine.idle();
	};
	return { route, idle };
}
