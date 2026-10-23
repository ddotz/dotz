// HTTP routing of the hub: the install files, the identity check and the first part of the route chain; the rest is routes-settings.ts and routes-lanes.ts.
// Split out of main.ts; the restart hooks come from main as plumbing, so this module never imports it.
import { join } from "node:path";
import { ADDRESS, cfg, DATA_DIR, HUB_TOKEN, log, NAME, now, setMachineName } from "./config.ts";
import { keyedSelector, keyFileOk, spendOnKey } from "./fallback.ts";
import { changeTarget, ControlError, targetView, ForceRequired, looksLikeCommand, parseCommand } from "./control.ts";
import * as discord from "./discord.ts";
import { authRoute, pendingAuth } from "./auth.ts";
import { pushRoute } from "./push.ts";
import { conversationList, unreadOf } from "./conversations.ts";
import { integrationContext, integrationItems } from "./integrations.ts";
import { markRead } from "./reads.ts";
import { historyEvents, recentEvents, sentFiles, sseResponse } from "./events.ts";
import { isProjectTarget, projectTarget } from "./projectchat.ts";
import { MailError, mailBodyRoute, mailCard, mailByKey, mailFileRoute, mailSuggests, mailTargets, postMail, type MailDeps } from "./mail.ts";
import { attachmentLines, fileRoute, FileError, messageFiles, uploadsFrom } from "./files.ts";
import { laneCapacity, lanes, liveLanes, laneSummary } from "./lanes.ts";
import { withHomes } from "./laneviews.ts";
import { orch } from "./orchestrator.ts";
import { enqueue, queueItems, restore, take } from "./queue.ts";
import { listMonitors } from "./monitors.ts";
import { NOTICE_CAP, answerDecision, dismissNotice, ignoreNotice, listNotices, markNoticesRead, readConversationNotices, reopenNotices, resolveNotices, setViewing, unignoreNotice, unreadCount } from "./notices.ts";
import { loadProjects, saveProject } from "./projects.ts";
import { listSchedules } from "./schedule.ts";
import { readTodo } from "./todo.ts";
import { customRoute } from "./custom.ts";
import { deleteKey, importOmoKey, keysView, saveKey } from "./apikey-store.ts";
import { updateRoute } from "./selfupdate.ts";
import { appAsset, committedText, indexPage, webBuild } from "./webapp.ts";
import { listPeers } from "./peers.ts";
import { cleanName, friendlyName, resolveName } from "./machine-name.ts";
import { hostname } from "node:os";
import { queue, bgWork, out, progress, fileRoots } from "./outbound.ts";
import { parseReply, replyLine, sendWeb } from "./intake.ts";
import { json, body, terminals } from "./routes-util.ts";
import { ptyRoute } from "./pty.ts";
import { routeLanes } from "./routes-lanes.ts";
import { routeSettings } from "./routes-settings.ts";
import { commentFlags, commentNeeds, commentsRoute } from "./comments/gateway.ts";
import { kakaoRoute } from "./kakao/gateway.ts";

const BOOT_ID = Date.now().toString(36);
// Installable-app files next to index.html: manifest, service worker (never cached by HTTP, so an update is seen at once), icons.
const APP_FILES: Record<string, [string, string]> = {
	"/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
	"/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
	"/icons/icon-192.png": ["icons/icon-192.png", "image/png"],
	"/icons/icon-512.png": ["icons/icon-512.png", "image/png"],
	"/icons/maskable-512.png": ["icons/maskable-512.png", "image/png"],
	"/icons/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png"],
	"/icons/dotz.svg": ["icons/dotz.svg", "image/svg+xml"],
	"/icons/badge-96.png": ["icons/badge-96.png", "image/png"],
	"/icons/monochrome-192.png": ["icons/monochrome-192.png", "image/png"],
	"/icons/monochrome-512.png": ["icons/monochrome-512.png", "image/png"],
};
const ALLOW = new Set((cfg.web?.allow_logins ?? []).map(s => s.toLowerCase()));

function authorized(req: Request): boolean {
	if (req.headers.get("x-dotz-token") === HUB_TOKEN) return true;
	const login = (req.headers.get("tailscale-user-login") ?? "").toLowerCase();
	if (login && ALLOW.has(login)) return true;
	const seen = [...req.headers.keys()].filter(k => k.startsWith("tailscale-")).map(k => `${k}=${req.headers.get(k)}`).join(" ");
	log(`denied ${new URL(req.url).pathname} ${seen || "(no tailscale identity headers)"}`);
	return false;
}

type RestartHooks = { busyNow: () => string[]; restartGateway: () => string; restartGatewayNow: () => string; mailDeps?: () => MailDeps };
const isMailTarget = (t: string) => /^mail:[a-z0-9._-]+$/.test(t);
export function makeRoute({ busyNow, restartGateway, restartGatewayNow, mailDeps }: RestartHooks): (req: Request) => Promise<Response> {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		// The install files (manifest, service worker, icons) are public and secret-free, like any app store listing: a browser
		// or OS fetch that carries no tailnet identity (icon or manifest fetch, SW update check) must still get them, or the
		// phone falls back to a plain shortcut. Everything else stays behind the identity check.
		const appFile = req.method === "GET" || req.method === "HEAD" ? APP_FILES[url.pathname] : undefined;
		if (appFile) return new Response(req.method === "HEAD" ? null : committedText(appFile[0]) ?? Bun.file(join(import.meta.dir, "..", "web", appFile[0])), { headers: { "Content-Type": appFile[1], "Cache-Control": url.pathname === "/sw.js" || url.pathname.endsWith(".webmanifest") ? "no-cache" : "public, max-age=86400" } });
		// The other gateways read this computer's chosen name here (hub/peers.ts); it is a display name, no secret, so it is public like the manifest.
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/peer-info") return json({ name: resolveName(cfg.web?.machine_name, hostname()) });
		if (!authorized(req)) return new Response("forbidden", { status: 403 });
		const parts = url.pathname.split("/").filter(Boolean);
		const authResponse = authRoute(req, url);
		if (authResponse) return authResponse;
		const ptyResponse = await ptyRoute(req, url);
		if (ptyResponse) return ptyResponse;
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/custom.js") {
			const file = Bun.file(join(import.meta.dir, "..", "web", "custom.js"));
			return (await file.exists()) ? new Response(req.method === "HEAD" ? null : file, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } }) : new Response("not found", { status: 404 });
		}
		const pushResponse = await pushRoute(req, url);
		if (pushResponse) return pushResponse;
		const updateResponse = await updateRoute(req, url, { boot: BOOT_ID, busy: busyNow, restartIdle: restartGateway, restartNow: restartGatewayNow });
		if (updateResponse) return updateResponse;
		const customResponse = await customRoute(req, url, { lanes: () => withHomes(laneSummary(), discord.channels), channels: () => discord.channels, work: () => bgWork.list(), send: (target, text, login) => sendWeb({ ...(target === "main" ? {} : { lane: target.slice(5) }), channel: "web", text, mode: "default", login }) });
		if (customResponse) return customResponse;
		// Project records (hub/projects.ts) and the todo strip (hub/todo.ts), docs/layers.md §4.
		if (url.pathname === "/api/projects" && req.method === "PUT") {
			try {
				return json(saveProject(await body(req)).record);
			} catch (error) {
				return json({ error: (error as Error).message }, 400);
			}
		}
		if (url.pathname === "/api/projects" && req.method === "GET") return json({ projects: loadProjects() });
		if (url.pathname === "/api/todo" && req.method === "GET") {
			const target = url.searchParams.get("target") ?? "main";
			if (target !== "main" && !target.startsWith("lane:") && !isProjectTarget(target)) return json({ error: "target must be main, lane:<name> or ch:<id>" }, 400);
			const lane = target.startsWith("lane:") ? lanes.get(target.slice(5)) : undefined;
			if (target.startsWith("lane:") && !lane) return json({ error: `no lane ${target.slice(5)}` }, 404);
			return json(readTodo(lane ? lane.sessionFile : orch.sessionFile));
		}
		// API keys for fallback entries (hub/apikey-store.ts): GET shows masks only; PUT {provider, key} or {from: "omo"}; DELETE /api/apikeys/<provider>.
		if (parts[0] === "api" && parts[1] === "apikeys") {
			try {
				if (req.method === "GET" && parts.length === 2) return json(keysView());
				if (req.method === "PUT" && parts.length === 2) {
					const b = await body(req);
					return json(b.from === "omo" ? await importOmoKey() : await saveKey(String(b.provider ?? ""), String(b.key ?? "")));
				}
				if (req.method === "DELETE" && parts.length === 3) return json(deleteKey(parts[2]));
				return json({ error: "not found" }, 404);
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof ControlError ? error.status : 400);
			}
		}
		if (url.pathname === "/api/health") return json({ ok: true });
		if (req.method === "GET" && url.pathname === "/api/peers") return json(await listPeers());
		// This computer's name for the settings screen: the one in use, the one the owner set (empty = none), and the hostname default.
		if (url.pathname === "/api/machine" && req.method === "GET") return json({ name: resolveName(cfg.web?.machine_name, hostname()), custom: cleanName(cfg.web?.machine_name), default: friendlyName(hostname()) });
		if (url.pathname === "/api/machine" && req.method === "PUT") {
			const name = cleanName((await body(req)).name);
			setMachineName(name);
			return json({ name: resolveName(name, hostname()), custom: name, default: friendlyName(hostname()) });
		}
		if (req.method === "GET" && url.pathname === "/api/workers") return json({ items: bgWork.list() });
		if (req.method === "POST" && url.pathname === "/api/gateway/restart") return json({ ok: true, output: restartGateway() });
		if (url.pathname === "/api/state")
			return json({ name: NAME, address: ADDRESS, discord: discord.status, channels: discord.channels, orchestrator: { ...orch, lastText: orch.lastText.slice(0, 600), key_fallback: keyedSelector(orch.activeModel) }, terminals: Object.fromEntries(terminals), lanes: withHomes(laneSummary(), discord.channels), capacity: laneCapacity(), schedules: listSchedules(), auth: pendingAuth(), events: recentEvents(Number(url.searchParams.get("limit") ?? 100)), notices_unread: unreadCount(), work: bgWork.list(), work_now: Date.now(), web_build: webBuild() });
		if (req.method === "GET" && url.pathname === "/api/notices") return json(listNotices(Number(url.searchParams.get("limit") ?? 100)));
		if (req.method === "GET" && url.pathname === "/api/monitors") return json({ items: listMonitors() });
		if (req.method === "GET" && url.pathname === "/api/integrations") {
			const convUnread = Object.fromEntries(mailTargets().map(t => [t, unreadOf(t)]));
			return json({ items: integrationItems(integrationContext(DATA_DIR, (cfg as { zele?: { enabled?: boolean } }).zele?.enabled !== false && Bun.which("zele") ? ["zele", ...commentFlags()] : commentFlags()), listNotices(NOTICE_CAP).items, convUnread, 100, undefined, mailSuggests(), Date.now(), commentNeeds()) });
		}
		if (req.method === "POST" && url.pathname === "/api/notices/read") return json(markNoticesRead(await body(req)));
		// The bot closes the questions whose matter is over (ids, match text, conv or all): they are answered, read and off 답변 필요.
		if (req.method === "POST" && url.pathname === "/api/notices/resolve") return json(resolveNotices(await body(req)));
		if (req.method === "POST" && url.pathname === "/api/notices/reopen") return json(reopenNotices((await body(req)).ids));
		// The page reports the conversation it shows ("" = hidden): answers there make no unread message item (hub/notices.ts).
		if (req.method === "POST" && url.pathname === "/api/viewing") {
			const b = await body(req);
			const r = setViewing(b.id, b.conv);
			return json(r, r.ok ? 200 : 400);
		}
		const dismiss = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/dismiss$/.exec(url.pathname) : null;
		if (dismiss) {
			const r = dismissNotice(decodeURIComponent(dismiss[1]!));
			return json(r, r.ok ? 200 : r.held ? 409 : 404);
		}
		// The x (무시) on a question that waits, and its undo: off the badge and 답변 필요, kept in the history, nothing sent to the bot.
		const ignore = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/(ignore|unignore)$/.exec(url.pathname) : null;
		if (ignore) {
			const r = (ignore[2] === "ignore" ? ignoreNotice : unignoreNotice)(decodeURIComponent(ignore[1]!));
			return json(r.body, r.status);
		}
		// A button of a decision notice: the answer goes where the question came from (chat, session, project chat or login request).
		const decide = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/answer$/.exec(url.pathname) : null;
		if (decide) {
			const login = req.headers.get("tailscale-user-login") ?? "local";
			const r = await answerDecision(decodeURIComponent(decide[1]!), await body(req), async a => {
				if (a.to.startsWith("auth:")) {
					const path = `/api/auth/${a.to.slice(5)}`;
					const res = await authRoute(new Request(`http://local${path}`, { method: "POST", body: JSON.stringify({ action: a.action }) }), new URL(`http://local${path}`));
					if (!res?.ok) throw new Error("로그인 요청을 처리하지 못했어요");
					return;
				}
				const lane = a.to.startsWith("lane:") ? a.to.slice(5) : undefined;
				const project = a.to.startsWith("ch:") ? projectTarget(a.to, discord.channels.work) : undefined;
				const conv = a.to === "alert" || a.to === "worklog" ? a.to : undefined;
				const mail = a.to.startsWith("mail:") ? mailByKey(a.to.slice(5)) : undefined;
				if (a.to.startsWith("mail:") && !mail) throw new Error("이 메일 대화를 찾을 수 없어요");
				await sendWeb({ lane, project, mail, conv, channel: "web", text: a.text, mode: "default", login, replyTo: a.replyTo, decision: a.notice, picks: a.picks });
			});
			return json(r.body, r.status);
		}
		if (req.method === "POST" && url.pathname === "/api/read") {
			const r = markRead(await body(req));
			// Reading a conversation also reads its bell items up to there (whether or not the position moved), so the two never disagree.
			if (r.ok) readConversationNotices(r.target, r.ts);
			return json(r, r.ok ? 200 : 400);
		}
		if (req.method === "GET" && url.pathname === "/api/conversations") {
			const items = conversationList([...liveLanes().live.map(n => `lane:${n}`), ...Object.keys(discord.channels.work).map(id => `ch:${id}`), ...mailTargets()]).map(c => {
				const m = c.target.startsWith("mail:") ? mailByKey(c.target.slice(5)) : undefined;
				return m ? { ...c, mail: mailCard(m) } : c;
			});
			return json({ items });
		}
		// One attached file of a mail: only files the mail's own record names, only inside the mail files folder (hub/mail.ts).
		const mailFile = (req.method === "GET" || req.method === "HEAD") && /^\/api\/mail\/([a-z0-9._-]+)\/files\/(\d+)$/.exec(url.pathname);
		if (mailFile) return mailFileRoute(req, url, mailFile[1]!, mailFile[2]!);
		const mailBody = req.method === "GET" && /^\/api\/mail\/([a-z0-9._-]+)\/body$/.exec(url.pathname);
		if (mailBody) return mailBodyRoute(mailBody[1]!);
		// A mail from an outside poster (a webmail watcher, a custom plugin): one conversation per mail (hub/mail.ts, docs/custom-plugins.md).
		if (req.method === "POST" && url.pathname === "/api/mail") {
			if (!mailDeps) return json({ error: "mail is not wired in this process" }, 503);
			try {
				return json(await postMail(await body(req), mailDeps()));
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof MailError ? error.status : 500);
			}
		}
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (req.method === "GET" && url.pathname === "/api/history") {
			const target = url.searchParams.get("target") ?? "main";
			if (target !== "main" && target !== "alert" && target !== "worklog" && !target.startsWith("lane:") && !isProjectTarget(target) && !isMailTarget(target)) return json({ error: "target must be main, alert, worklog, lane:<name>, ch:<id> or mail:<key>" }, 400);
			const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 150) || 150, 500));
			return json({ target, events: historyEvents(target, limit, url.searchParams.get("before") ?? undefined) });
		}
		if (req.method === "POST" && url.pathname === "/api/attach") {
			const b = await body(req);
			if (b.detach) terminals.delete(String(b.session));
			else terminals.set(String(b.session), { cwd: b.cwd, at: now() });
			return json({ ok: true });
		}
		if (req.method === "POST" && url.pathname === "/api/upload") {
			try {
				return json({ ok: true, files: await uploadsFrom(req) });
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof FileError ? error.status : 400);
			}
		}
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/file") {
			return fileRoute(req, url, fileRoots(), sentFiles());
		}
		if (req.method === "GET" && url.pathname === "/api/lanes/live") return json(liveLanes());
		if (url.pathname === "/api/target") {
			const fail = (error: unknown) => json({ error: (error as Error).message, ...(error instanceof ForceRequired ? { requires_force: true, context_tokens: error.contextTokens } : {}) }, error instanceof ControlError ? error.status : 400);
			try {
				if (req.method === "GET") return json(await targetView(url.searchParams.get("target") ?? "main"));
				if (req.method === "PUT") {
					const b = await body(req);
					return json(await changeTarget(String(b.target ?? "main"), { model: b.model ? String(b.model) : undefined, thinking: b.thinking ? String(b.thinking) : undefined, compact: b.compact === true, force: b.force === true }));
				}
			} catch (error) {
				return fail(error);
			}
		}
		if (req.method === "POST" && url.pathname === "/api/message") {
			const b = await body(req);
			const files = messageFiles(b.files);
			if (!b.text && !files.length) return json({ error: "text required" }, 400);
			const text = String(b.text ?? "");
			const login = req.headers.get("tailscale-user-login") ?? "local";
			// mode: none (main takes it as the next message, a working lane is steered), "steer" (into the running turn
			// now), "interrupt" (abort the running turn, then send as a new prompt), "queue" (a working target gets it
			// when its turn ends, see queue.ts; an idle target gets it now).
			const mode = b.mode === "steer" || b.mode === "interrupt" || b.mode === "queue" ? b.mode : "default";
			const lane = b.lane ? String(b.lane) : undefined;
			const conv = b.conv === "alert" || b.conv === "worklog" ? b.conv : undefined;
			const channel = b.channel === "terminal" ? "terminal" : "web";
			// A reply to a message (swipe / reply button in the web): the quoted message reaches the model like a Discord reply (intake.ts parseReply).
			const reply = parseReply(b.reply, login);
			let project: { target: string; name: string } | undefined;
			if ([lane, b.project, b.mail].filter(Boolean).length > 1) return json({ error: "lane, project and mail are exclusive" }, 400);
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
			if (mode === "queue" && !project && !mail && !conv && (lane ? lanes.has(lane) : !parseCommand(text) && !looksLikeCommand(text)) && (lane ? lanes.get(lane)?.status === "working" : orch.status === "working")) {
				const item = enqueue(lane ? `lane:${lane}` : "main", [reply ? replyLine(reply) : "", text, files.length ? attachmentLines(files) : ""].filter(Boolean).join("\n"), login);
				return json({ ok: true, queued: item });
			}
			try {
				// A decision answer from the chat card: the asking message (its ts) and the chosen option per block (intake.ts decisionLines).
				const picks = Array.isArray(b.picks) ? b.picks.slice(0, 10).flatMap((p: any) => (p && Number.isFinite(Number(p.n)) ? [{ q: String(p.q ?? "").slice(0, 200), n: Number(p.n), label: String(p.label ?? "").slice(0, 120), ...(typeof p.note === "string" && p.note.trim() ? { note: p.note.replace(/\s+/g, " ").trim().slice(0, 500) } : {}) }] : [])) : [];
				await sendWeb({ lane, project, mail, conv: lane || project || mail ? undefined : conv, channel, text, mode: mode === "queue" ? "default" : mode, login, files, ...(typeof b.reply_to === "string" && b.reply_to ? { replyTo: b.reply_to.slice(0, 40) } : {}), ...(reply ? { reply } : {}), ...(picks.length ? { picks } : {}) });
			} catch (error) {
				return json({ error: (error as Error).message }, 409);
			}
			return json({ ok: true });
		}
		if (url.pathname === "/api/queue" && req.method === "GET") return json({ items: queueItems() });
		if (parts[0] === "api" && parts[1] === "queue" && parts.length >= 3) {
			const id = decodeURIComponent(parts[2]);
			if (req.method === "DELETE" && parts.length === 3) {
				const item = take(id);
				return item ? json({ text: item.text }) : json({ error: "not queued (already sent)" }, 404);
			}
			if (req.method === "POST" && parts[3] === "send" && parts.length === 4) {
				const item = take(id);
				if (!item) return json({ error: "not queued (already sent)" }, 404);
				try {
					await sendWeb({ lane: item.target.startsWith("lane:") ? item.target.slice(5) : undefined, channel: "web", text: item.text, mode: "steer", login: item.author ?? "local" });
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
		if (req.method === "POST" && url.pathname === "/api/send") {
			const b = await body(req);
			const target = String(b.target ?? "chat");
			// `resolves` (text in the title / text of the open questions it settles, or "*" for all): this post says their matter is over.
			if (typeof b.resolves === "string" && b.resolves.trim()) resolveNotices(b.resolves.trim() === "*" ? { all: true } : { match: b.resolves });
			if (b.update_key) {
				try {
					return json(await progress(target, String(b.update_key), String(b.text ?? ""), b.reply_to));
				} catch (error) {
					return json({ delivered: false, reason: (error as Error).message }, 502);
				}
			}
			// Answer only when it is ready: an early text to the asking channel waits for the turn's final answer.
			if (queue.holdEarly(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined))
				return json({ delivered: true, held: true, note: "held: it goes out together with your final answer for this request; do not send it again" });
			queue.sent(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined);
			try {
				return json(await out(target, String(b.text ?? ""), b.reply_to));
			} catch (error) {
				return json({ delivered: false, reason: (error as Error).message }, 502);
			}
		}
		const commentsResponse = await commentsRoute(req, url, parts);
		if (commentsResponse) return commentsResponse;
		const kakaoResponse = await kakaoRoute(req, url, parts);
		if (kakaoResponse) return kakaoResponse;
		const settingsResponse = await routeSettings(req, url, parts);
		if (settingsResponse) return settingsResponse;
		const laneResponse = await routeLanes(req, url, parts);
		if (laneResponse) return laneResponse;
		return new Response("not found", { status: 404 });
	};
}
