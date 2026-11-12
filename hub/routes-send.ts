// HTTP routes that send: /api/message (with its client-id retry memory), /api/queue, /api/fallback-spend, /api/conv-sessions and /api/send.
// Split out of routes.ts, called there at the same place of the chain; the function answers undefined for every path that is not its own.
import { log } from "./config.ts";
import { msg } from "./i18n.ts";
import { keyFileOk, spendOnKey } from "./fallback.ts";
import { parseCommand } from "./control.ts";
import * as discord from "./discord.ts";
import { fieldsOf } from "./app-settings.ts";
import { watchOfSubject } from "./watch-settings.ts";
import { historyEvents } from "./events.ts";
import { projectTarget } from "./projectchat.ts";
import { mailByKey } from "./mail.ts";
import { attachmentLines, FileError, ownerFiles } from "./files.ts";
import { ownerElements, pickedLines } from "./picked.ts";
import { ownerRefs, refLines } from "./mentions.ts";
import { lanes } from "./lanes.ts";
import { orch } from "./orchestrator.ts";
import { enqueue, queueItems, restore, take } from "./queue.ts";
import { resolveNotices } from "./notices.ts";
import { AGENT_AUTHOR, tokenOk } from "./entry-check.ts";
import { queue, bgWork, out, progress } from "./outbound.ts";
import { convs, maxLiveView } from "./convsessions.ts";
import { repostRefusal } from "./lanewire.ts";
import { MAIN, primaryTarget, QUICK } from "./session-key.ts";
import { authHeld, parseReply, replyLine, sendWeb } from "./intake.ts";
import { json, body } from "./routes-util.ts";
import { attachNote } from "./attach-lines.ts";
import { bannedHits, bannedNote } from "./word-ban.ts";

// Where a forwarded action came from (a machine name), as one short line; the event it makes carries it as `via`.
export const viaOf = (v: unknown): string | undefined => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 40) || undefined : undefined);
// The last web sends by client id, with the answer each got (POST /api/message `cid`). Set before the send so a double tap in flight is a retry too.
const sentCids = new Map<string, unknown>();
const rememberCid = (cid: string, answer: unknown): void => {
	sentCids.set(cid, answer);
	if (sentCids.size > 500) sentCids.delete(sentCids.keys().next().value as string);
};
// The routes that put a message into a conversation: /api/message, the queue, a worker's spend report, the conversation sessions and /api/send; undefined for any other path.
export async function routeSend(req: Request, url: URL, parts: string[], { peer }: { peer: string }): Promise<Response | undefined> {
	if (req.method === "POST" && url.pathname === "/api/message") {
		const b = await body(req);
		// The web's id for one send (`cid`): the same id again is a retry, answered as the first was, stored once.
		const cid = typeof b.cid === "string" && b.cid ? b.cid.slice(0, 80) : "";
		if (cid && sentCids.has(cid)) return json(sentCids.get(cid));
		let files: ReturnType<typeof ownerFiles>;
		try {
			files = ownerFiles(b.files);
		} catch (error) {
			return json({ error: (error as Error).message }, error instanceof FileError ? error.status : 400);
		}
		const elements = ownerElements(b.elements);
		// What the owner named with @ (hub/mentions.ts), resolved against what runs now: one [지칭] line each in the turn.
		const refs = refLines(ownerRefs(b.refs), {
			task: id => [...bgWork.list(), ...convs.conversations().flatMap(c => c.bg.list())].find(w => w.id === id),
			lane: name => lanes.get(name),
			conv: key => { const c = convs.conversations().find(x => x.primary === key); return c && { name: c.meta.name, live: convs.live(c) }; },
		});
		if (!String(b.text ?? "").trim() && !files.length && !elements.length) return json({ error: "text required" }, 400);
		const text = String(b.text ?? "");
		const login = peer === "none" && tokenOk(req) ? AGENT_AUTHOR : (req.headers.get("tailscale-user-login") ?? "local"); // an agent's own post is never the owner's word (hub/model-guard.ts)
		// mode: none (main takes it as the next message, a working lane is steered), "steer" (into the running turn
		// now), "interrupt" (abort the running turn, then send as a new prompt), "queue" (a working target gets it
		// when its turn ends, see queue.ts; an idle target gets it now).
		const mode = b.mode === "steer" || b.mode === "interrupt" || b.mode === "queue" ? b.mode : "default";
		const lane = b.lane ? String(b.lane) : undefined;
		const conv = b.conv === "alert" || b.conv === "worklog" || (b.conv === QUICK && convs.ownKinds().includes(QUICK)) ? b.conv : undefined;
		const channel = b.channel === "terminal" ? "terminal" : "web";
		// A reply to a message (swipe / reply button in the web): the quoted message reaches the model like a Discord reply (intake.ts parseReply).
		const reply = parseReply(b.reply, login);
		let project: { target: string; name: string } | undefined;
		const settings = typeof b.settings === "string" && (fieldsOf(b.settings).length || watchOfSubject(b.settings)) ? b.settings : undefined;
		if ([lane, b.project, b.mail, settings].filter(Boolean).length > 1) return json({ error: "lane, project and mail are exclusive" }, 400);
		const mail = b.mail ? mailByKey(String(b.mail)) : undefined;
		if (b.mail && !mail) return json({ error: `no mail conversation ${String(b.mail)}` }, 404);
		if (b.project) {
			try {
				project = projectTarget(String(b.project), discord.channels.work);
			} catch (error) {
				return json({ error: (error as Error).message }, 404);
			}
		}
		// The queue sends to the main conversation when the turn ends; a project message goes in now (intake merges a burst).
		if (mode === "queue" && !project && !mail && !conv && (lane ? lanes.has(lane) : !parseCommand(text) && !authHeld("web")) && (lane ? lanes.get(lane)?.status === "working" : orch.status === "working")) {
			const item = enqueue(lane ? `lane:${lane}` : "main", [reply ? replyLine(reply) : "", text, files.length ? attachmentLines(files) : "", elements.length ? pickedLines(elements) : "", ...refs].filter(Boolean).join("\n"), login);
			if (cid) rememberCid(cid, { ok: true, queued: item });
			return json({ ok: true, queued: item });
		}
		if (cid) rememberCid(cid, { ok: true });
		try {
			// A decision answer from the chat card: the asking message (its ts) and the chosen option per block (intake.ts decisionLines).
			const picks = Array.isArray(b.picks) ? b.picks.slice(0, 10).flatMap((p: any) => (p && Number.isFinite(Number(p.n)) ? [{ q: String(p.q ?? "").slice(0, 200), n: Number(p.n), label: String(p.label ?? "").slice(0, 120), ...(typeof p.note === "string" && p.note.trim() ? { note: p.note.replace(/\s+/g, " ").trim().slice(0, 500) } : {}) }] : [])) : [];
			await sendWeb({ lane, project, mail, settings, conv: lane || project || mail || settings ? undefined : conv, channel, text, mode: mode === "queue" ? "default" : mode, login, files, ...(elements.length ? { elements } : {}), ...(refs.length ? { refs } : {}), ...(typeof b.reply_to === "string" && b.reply_to ? { replyTo: b.reply_to.slice(0, 40) } : {}), ...(reply ? { reply } : {}), ...(typeof b.decision === "string" && b.decision ? { decision: b.decision.slice(0, 80) } : {}), ...(picks.length ? { picks } : {}), via: viaOf(b.via) });
		} catch (error) {
			sentCids.delete(cid);
			return json({ error: (error as Error).message }, 409);
		}
		return json({ ok: true });
	}
	if (url.pathname === "/api/queue" && req.method === "GET") return json({ items: queueItems() });
	if (parts[0] === "api" && parts[1] === "queue" && parts.length >= 3) {
		const id = decodeURIComponent(parts[2]);
		if (req.method === "DELETE" && parts.length === 3) {
			const item = take(id);
			return item ? json({ text: item.text }) : json({ error: msg().refuse.queueGone }, 404);
		}
		if (req.method === "POST" && parts[3] === "send" && parts.length === 4) {
			const item = take(id);
			if (!item) return json({ error: msg().refuse.queueGone }, 404);
			try {
				await sendWeb({ lane: item.target.startsWith("lane:") ? item.target.slice(5) : undefined, channel: "web", text: item.text, mode: "steer", sendNow: true, login: item.author ?? "local" });
			} catch (error) {
				restore([item]);
				return json({ error: (error as Error).message }, 409);
			}
			return json({ ok: true });
		}
	}
	// A task worker on an API key reports what a request cost, so its entry's cap counts the workers too (extension keyProvider).
	if (req.method === "POST" && url.pathname === "/api/fallback-spend") {
		const b = await body(req);
		const tokens = Number(b.tokens);
		if (!keyFileOk(String(b.key_file ?? "")) || !(tokens > 0)) return json({ error: "key_file (an existing key file) and tokens are required" }, 400);
		spendOnKey(String(b.key_file), tokens, Number(b.usd) > 0 ? Number(b.usd) : undefined);
		return json({ ok: true });
	}
	// The conversations main oversees (hub/convsessions.ts) for the dotz_conv tool: which have a session of their own, what it is doing,
	// and the exchange a read asks for. A conversation session may write only into main; main may send into any conversation.
	if (req.method === "GET" && url.pathname === "/api/conv-sessions") {
		return json({
			capacity: maxLiveView(),
			items: convs.conversations().map(c => ({ key: c.key, name: c.meta.name || c.primary, primary: c.primary, live: convs.live(c), state: convs.stateOf(c.primary), status: c.o.orch.status, model: c.o.orch.activeModel, ctx: { tokens: c.o.orch.ctx.tokens }, lastOwnerAt: c.meta.lastOwnerAt })),
		});
	}
	{
		const m = /^\/api\/conv-sessions\/([^/]+)\/(history|send)$/.exec(url.pathname);
		const key = m ? decodeURIComponent(m[1]!) : "";
		if (m && m[2] === "history" && req.method === "GET") {
			const c = convs.get(key);
			if (!c) return json({ error: `no conversation session ${key}` }, 404);
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 40);
			return json({ key, primary: c.primary, events: historyEvents(c.primary, limit) });
		}
		if (m && m[2] === "send" && req.method === "POST") {
			const b = await body(req);
			const text = String(b.text ?? "").trim();
			const from = String(b.from ?? "").trim() || MAIN;
			if (!text) return json({ error: "text required" }, 400);
			const sender = convs.get(from);
			if (!sender) return json({ error: `unknown session ${from}` }, 400);
			// One round only: a turn a session was handed another session's work for must not hand it back or onward.
			const cur = sender.queue.current();
			if (cur && !cur.done && (cur.from || cur.handback)) return json({ error: "handed work: answer it here, do not pass it on" }, 409);
			const toMain = from !== MAIN;
			if (!toMain && !convs.get(key)) return json({ error: `no conversation session ${key}` }, 404);
			// Into main: its answer goes to the conversation that asked, where its own window shows it.
			if (toMain) {
				queue.deliver(`[conversation ${from}] ${text}`, { target: sender.primary, replyTo: cur?.replyTo, from });
				return json({ ok: true, to: MAIN, answers_in: sender.primary });
			}
			const c = convs.get(key)!;
			// Main's request is that conversation's next turn with no reply_to: its answer is posted there; only back:true marks it handed work, answered to main (handBack).
			convs.deliverTo(key, `[main session] ${text}`, { target: c.primary, ...(b.back === true ? { from: MAIN } : {}) });
			return json({ ok: true, to: key, answers_in: b.back === true ? MAIN : c.primary });
		}
	}
	if (req.method === "POST" && url.pathname === "/api/send") {
		const b = await body(req);
		const target = String(b.target ?? "chat");
		// Text for the owner only: a brief to a session (lane:<name>) may quote the listed words to forbid them.
		const banned = target.startsWith("lane:") ? [] : bannedHits(String(b.text ?? ""));
		if (banned.length) return json({ error: bannedNote(banned) }, 422);
		const unattached = target.startsWith("lane:") ? undefined : attachNote(String(b.text ?? ""));
		if (unattached) return json({ delivered: false, reason: unattached });
		// A conversation's own session answers only there (hub/convsessions.ts): a post of it anywhere else, an early text, a progress note or a send with no reply_to alike, is refused, so another window's answer never lands in this one.
		const session = typeof b.session === "string" && b.session ? b.session : MAIN;
		if (session !== MAIN && convs.keyOf(target) !== session) return json({ delivered: false, reason: `this session answers only ${primaryTarget(session)}; hand other work to main with dotz_conv send main` }, 403);
		const sender = convs.get(session)?.queue ?? queue;
		const refused = session === MAIN && !b.update_key && repostRefusal(target, String(b.text ?? ""));
		if (refused) return json({ delivered: false, reason: refused });
		// `resolves` (text in the title / text of the open questions it settles, or "*" for all): this post says their matter is over.
		if (typeof b.resolves === "string" && b.resolves.trim()) resolveNotices(b.resolves.trim() === "*" ? { all: true } : { match: b.resolves }, conv => convs.keyOf(conv ?? "") === session);
		if (b.update_key) {
			try {
				return json(await progress(target, String(b.update_key), String(b.text ?? ""), b.reply_to, session, "dotz_send"));
			} catch (error) {
				return json({ delivered: false, reason: (error as Error).message }, 502);
			}
		}
		// Answer only when it is ready: an early text to the asking channel waits for the turn's final answer. Meanwhile the owner sees it at once on that conversation's progress line (owner 2026-10-28: 중간 말을 바로 보여 주기), which the answer replaces.
		if (sender.holdEarly(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined)) {
			void progress(target, "progress", String(b.text ?? ""), b.reply_to, session, "dotz_send").catch(e => log(`early text not shown on the progress line: ${(e as Error).message}`));
			return json({ delivered: true, held: true, note: "held: it is shown on the progress line now and goes out together with your final answer for this request; do not send it again" });
		}
		const answers = sender.sent(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined);
		try {
			return json(await out(target, String(b.text ?? ""), b.reply_to ?? answers, { session, cross: "dotz_send" }));
		} catch (error) {
			return json({ delivered: false, reason: (error as Error).message }, 502);
		}
	}
	return undefined;
}
