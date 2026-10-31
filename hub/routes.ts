// HTTP routing of the hub: the install files, the identity check and the first part of the route chain; the rest is routes-settings.ts and routes-lanes.ts.
// Split out of main.ts; the restart hooks come from main as plumbing, so this module never imports it.
import { readFileSync } from "node:fs";
import { dropAnsweredMailDraft } from "./draft-drop.ts";
import { approvalRoute, TRIAGE_MIN_DEFAULT, webAnswer } from "./approval-wire.ts";
import { droppedDraftRefs, restoreReopenedDrafts } from "./draft-restore.ts";
import { join } from "node:path";
import type { Server } from "bun";
import { ADDRESS, cfg, DATA_DIR, HUB_TOKEN, log, NAME, now, setMachineName } from "./config.ts";
import { keyedSelector, keyFileOk, spendOnKey } from "./fallback.ts";
import { changeTarget, ControlError, targetView, ForceRequired, looksLikeCommand, parseCommand } from "./control.ts";
import * as discord from "./discord.ts";
import { authRoute, pendingAuth } from "./auth.ts";
import { pushRoute } from "./push.ts";
import { conversationList, unreadOf } from "./conversations.ts";
import { appEntries, INTEGRATIONS, readAppOff, integrationAvailable, integrationContext, integrationItems, withConnection, withStoreDrafts } from "./integrations.ts";
import { createApp, deleteApp, removalPlan, removeApp } from "./app-off.ts";
import { readAppTemplates } from "./app-templates.ts";
import { allWatches, approveWatch, removeWatch, runWatch } from "./watch.ts";
import { watchConnection } from "./watch-status.ts";
import { featuresOf, ownedWatches, retryInternal, setFeature } from "./app-features.ts";
import { fieldsOf, isSettingsTarget, readSettings, SettingsError, writeSettings } from "./app-settings.ts";
import { refreshReplyModelChoices, replyModelLabel } from "./reply-model-choices.ts";
import { replyModel } from "./reply-model.ts";
import { watchOfSubject } from "./watch-settings.ts";
import { markRead } from "./reads.ts";
import { activityItems, broadcast, historyEvents, ownerMessage, recentEvents, sentFiles, sseResponse } from "./events.ts";
import { subagentLists } from "./activity.ts";
import { cancelOmoWorker, retryText, runningOmoWork, workConversation } from "./bgwork.ts";
import { lastTurnEnd, mailConversation, openTodos, runIntent, runState, stallNudge, workConversationRuns, type RunState } from "./runstate.ts";
import { isProjectTarget, projectTarget } from "./projectchat.ts";
import { askedFile, draftAttachRoute } from "./draft-attach.ts";
import { parseFollowup, triggerFollowup } from "./followup.ts";
import { draftFileRoute } from "./draft-files.ts";
import { draftRecipientsRoute } from "./draft-recipients.ts";
import { composeMail, deleteMail, MailError, mailBodyRoute, settleMailDrafts, mailCard, mailByKey, mailByThread, mailFileRoute, mailSuggests, mailTarget, mailTargets, postMail, setMailFyi, setMailNoReply, sentReplyRefs, setMailReply, unrepliedMails, type MailDeps } from "./mail.ts";
import { holdDrafts, listDrafts, restoreDrafts } from "../features/reply-drafts/lib/store.ts";
import { attachmentLines, canvasRoute, fileRoute, FileError, messageFiles, ownerFiles, serveFile, uploadsFrom } from "./files.ts";
import { ownerElements, pickedLines } from "./picked.ts";
import { laneCapacity, lanes, liveLanes, laneSummary } from "./lanes.ts";
import { withHomes } from "./laneviews.ts";
import { orch } from "./orchestrator.ts";
import { enqueue, queueItems, restore, take } from "./queue.ts";
import { listMonitors } from "./monitors.ts";
import { type DecisionSend, type Notice, NOTICE_CAP, settleHandledDrafts, answerDecision, dismissedAlertAts, dismissNotice, ignoreNotice, listNotices, markNoticesRead, readConversationNotices, reopenDraftNotices, reopenNotices, resolveNotices, setViewing, unignoreNotice, unreadCount } from "./notices.ts";
import { loadProjects, saveProject } from "./projects.ts";
import { deleteProject, planDelete, ProjectDeleteError } from "./projectdelete.ts";
import { listSchedules } from "./schedule.ts";
import { openMonitor, readTodo } from "./todo.ts";
import { customRoute } from "./custom.ts";
import { deleteKey, importOmoKey, keysView, saveKey } from "./apikey-store.ts";
import { updateRoute } from "./selfupdate.ts";
import { harnessUpdateRoute } from "./harness-update.ts";
import { appAsset, committedText, indexPage, setAppName, webBuild } from "./webapp.ts";
import { listPeers, ownLogin } from "./peers.ts";
import { handlePair, PAIR_PATH } from "./peer-pair.ts";
import { checkPeer } from "./peer-auth.ts";
import { activatePeerMonitor, createPeerMonitor } from "./peer-monitor.ts";
import { handleLease, type LeaseReq } from "./send-lease.ts";
import { cleanName, friendlyName, resolveName } from "./machine-name.ts";
import { machineHost } from "./hostname.ts";
import { queue, bgWork, out, progress, fileRoots } from "./outbound.ts";
import { convs, maxLiveView } from "./convsessions.ts";
import { MAIN, primaryTarget } from "./session-key.ts";
import { parseReply, replyLine, sendWeb } from "./intake.ts";
import { json, body, terminals } from "./routes-util.ts";
import { ptyRoute } from "./pty.ts";
import { routeLanes } from "./routes-lanes.ts";
import { routeSettings } from "./routes-settings.ts";
import { commentFlags, commentNeeds, commentPending, commentsRoute } from "./comments/gateway.ts";
import { appHealth, loadUserApps, PROXY_ROOT, removeUserApp, setUserAppOff, userApp } from "./user-apps.ts";
import { proxyMatch, proxyRequest } from "./app-proxy.ts";
import { igDmRoute } from "./ig-dm-gateway.ts";
import { kakaoPendingCount, kakaoPendingDrafts, kakaoRoute, kakaoUnreplied } from "./kakao/gateway.ts";

const BOOT_ID = Date.now().toString(36);
setAppName(NAME);
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
	// xterm.js for the web terminal (web/js/36-shell.js loads it on first open); library code, no secrets.
	"/vendor/xterm.js": ["vendor/xterm.js", "text/javascript; charset=utf-8"],
	"/vendor/addon-fit.js": ["vendor/addon-fit.js", "text/javascript; charset=utf-8"],
	"/vendor/xterm.css": ["vendor/xterm.css", "text/css; charset=utf-8"],
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

const compactingNow = (ctx: { compaction?: { state?: string } } | undefined): boolean => ctx?.compaction?.state === "queued" || ctx?.compaction?.state === "compacting";
// Every 30 s: a conversation (main, a conversation session or a session) resting with plan tasks left and nothing to wait for is told to go on
// (runstate.ts stallNudge); `nudge` delivers the prompt into that conversation's own session.
export function startStallSweep(nudge: (conversation: string, r: RunState) => void): void {
	const told = new Map<string, { at: number[]; since?: string }>();
	const timer = setInterval(() => {
		try {
			const runs = stateRuns(), now = Date.now();
			// sessions too: kdb-loss-review on the Mac mini (2026-10-29 01:53Z) ended a turn with a [run] report and 13 tasks open, and
			// nothing woke it (a [run] report stays on disk)
			const keys = ["main", ...convs.conversations().filter(c => convs.live(c)).map(c => c.primary), ...[...lanes.values()].filter(l => !!l.proc).map(l => `lane:${l.name}`)];
			for (const k of keys) {
				const r = runs[k], seen = told.get(k) ?? { at: [] };
				if (!r || !stallNudge(r, now, seen.at, seen.since)) continue;
				told.set(k, { at: [...seen.at.filter(at => now - at < 3_600_000), now], since: r.since });
				log(`stall: ${k} rested with ${r.todos ?? 0} task(s) left since ${r.since}; told to go on`);
				nudge(k, r);
			}
		} catch (e) {
			log(`stall sweep failed: ${e}`);
		}
	}, 30_000);
	timer.unref();
}
// The run state of every conversation (/api/state `runs`): what each session is doing, and when it is idle with plan tasks left, why.
function stateRuns(): Record<string, RunState> {
	const nowMs = Date.now();
	const works = bgWork.list();
	const running = works.filter(w => w.status === "running");
	const deferred = queue.deferredOpen();
	const asks = listNotices(NOTICE_CAP).items
		.filter(n => n.kind === "decision" && n.decision?.state === "open")
		.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
	const askFor = (target: string) => {
		const n = asks.find(x => { const to = x.decision!.to; return to === target || (target === "main" && to.startsWith("auth:")); });
		return n ? { text: n.text || n.title, at: n.at } : undefined;
	};
	const turnStart = (source: string, fallback: string) => lastTurnStart(activityItems(source)) ?? fallback;
	const mainItems = activityItems("orchestrator");
	const main = runState({
		status: orch.status,
		since: (orch.status === "stopped" ? orch.stoppedAt || orch.startedAt : turnStart("orchestrator", orch.startedAt)) || undefined,
		intent: runIntent(mainItems),
		rateLimitedUntil: orch.rateLimitedUntil,
		pauseKind: orch.pauseKind,
		stoppedBy: orch.stoppedBy || undefined,
		error: orch.error ? { text: orch.error.text, since: orch.error.since } : undefined,
		ask: askFor("main"),
		work: running.filter(w => mainWork(w.target)),
		// a failure a later turn took up (bgwork.ts handled) is over: the line no longer shows it
		failed: (w => (w && !w.handled ? w : undefined))(works.find(w => w.status !== "running" && mainWork(w.target))),
		children: runningChildren("orchestrator"),
		later: deferred.filter(d => d.target === "web" || d.target === "terminal").length,
		lastTurnEnd: lastTurnEnd(mainItems),
		compacting: compactingNow(orch.ctx),
		watching: openMonitor(orch.sessionFile),
		todos: openTodos(readTodo(orch.sessionFile)),
		now: nowMs,
	});
	const lanesOut: Record<string, RunState> = {};
	for (const lane of lanes.values()) {
		const source = `lane:${lane.name}`, items = activityItems(source), workers = runningOmoWork(lane.sessionFile);
		lanesOut[source] = runState({
			status: lane.status,
			since: turnStart(source, lane.startedAt),
			intent: runIntent(items),
			ask: lane.pendingAsk ? { text: lane.pendingAsk.text, at: lane.pendingAsk.at } : undefined,
			work: workers,
			children: runningChildren(source),
			later: deferred.filter(d => d.target === source).length,
			capacity: lane.waiting,
			lastTurnEnd: lastTurnEnd(items),
			compacting: compactingNow(lane.ctx),
			watching: openMonitor(lane.sessionFile),
			todos: openTodos(readTodo(lane.sessionFile)),
			now: nowMs,
		});
	}
	// A conversation with a session of its own (hub/convsessions.ts) shows that session's line, so its window shows its turn, its
	// waiting worker and its own 중단; its state wins over the worker-only line below.
	const convOut: Record<string, RunState> = {};
	for (const c of convs.conversations()) {
		if (!convs.live(c)) continue;
		const source = `conv:${c.key}`, items = activityItems(source), own = c.bg.list();
		convOut[c.primary] = runState({
			status: c.o.orch.status,
			since: (c.o.orch.status === "stopped" ? c.o.orch.stoppedAt || c.o.orch.startedAt : turnStart(source, c.o.orch.startedAt)) || undefined,
			intent: runIntent(items),
			rateLimitedUntil: c.o.orch.rateLimitedUntil,
			pauseKind: c.o.orch.pauseKind,
			stoppedBy: c.o.orch.stoppedBy || undefined,
			error: c.o.orch.error ? { text: c.o.orch.error.text, since: c.o.orch.error.since } : undefined,
			ask: askFor(c.primary),
			work: own.filter(w => w.status === "running"),
			failed: (w => (w && !w.handled ? w : undefined))(own.find(w => w.status !== "running")),
			children: runningChildren(source),
			later: c.queue.deferredOpen().length,
			lastTurnEnd: lastTurnEnd(items),
			compacting: compactingNow(c.o.orch.ctx),
			watching: openMonitor(c.o.orch.sessionFile),
			todos: openTodos(readTodo(c.o.orch.sessionFile)),
			now: nowMs,
		});
	}
	// A mail conversation with no session of its own: the worker its owner message was deferred to is its run state (a thread target
	// and the mail key name the same conversation). Peer snapshots show the same lines, so the other computer's mail is not silent.
	const mailRuns = workConversationRuns(works, t => mailConversation(t, thread => mailByThread(thread)?.key));
	return { main, ...lanesOut, ...mailRuns, ...convOut };
}
const mainWork = (t: string | undefined) => t === "web" || t === "terminal" || !t;
const lastTurnStart = (items: ReturnType<typeof activityItems>): string | undefined => {
	for (let i = items.length - 1; i >= 0; i--) if (items[i]!.type === "turn_start") return items[i]!.ts;
	return undefined;
};
const runningChildren = (source: string) =>
	(subagentLists()[source] || []).filter(s => s.status === "running").map(s => ({ name: s.id, description: s.description || s.agent }));

type RestartHooks = { busyNow: () => string[]; restartGateway: () => string; restartGatewayNow: () => string; mailDeps?: () => MailDeps };
const isMailTarget = (t: string) => /^mail:[a-z0-9._-]+$/.test(t);
// Where a forwarded action came from (a machine name), as one short line; the event it makes carries it as `via`.
const viaOf = (v: unknown): string | undefined => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 40) || undefined : undefined);
// A card's answer to where its question came from (chat, session, project chat, mail or login request): the bot's turn.
async function deliverAnswer(a: Parameters<DecisionSend>[0] & { login: string; via?: ReturnType<typeof viaOf> }): Promise<void> {
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
	await sendWeb({ lane, project, mail, conv, channel: "web", text: a.text, mode: "default", login: a.login, replyTo: a.replyTo, decision: a.notice, picks: a.picks, files: a.files, via: a.via });
}

export function makeRoute({ busyNow, restartGateway, restartGatewayNow, mailDeps }: RestartHooks): (req: Request, srv?: Server<unknown>) => Promise<Response> {
	const route = async (req: Request, srv?: Server<unknown>): Promise<Response> => {
		const url = new URL(req.url);
		// The install files (manifest, service worker, icons) are public and secret-free, like any app store listing: a browser
		// or OS fetch that carries no tailnet identity (icon or manifest fetch, SW update check) must still get them, or the
		// phone falls back to a plain shortcut. Everything else stays behind the identity check.
		const appFile = req.method === "GET" || req.method === "HEAD" ? APP_FILES[url.pathname] : undefined;
		// The install name is the owner's assistant name, not the project's; `gateway` is what another computer recognises a gateway by (hub/peers.ts).
		if (appFile && url.pathname === "/manifest.webmanifest") {
			const m = JSON.parse(committedText(appFile[0]) ?? readFileSync(join(import.meta.dir, "..", "web", appFile[0]), "utf8"));
			const body = JSON.stringify({ ...m, name: NAME, short_name: NAME, description: `${NAME} · 항상 켜져 있는 개인 비서`, gateway: "dotz" });
			return new Response(req.method === "HEAD" ? null : body, { headers: { "Content-Type": appFile[1], "Cache-Control": "no-cache" } });
		}
		if (appFile) return new Response(req.method === "HEAD" ? null : committedText(appFile[0]) ?? Bun.file(join(import.meta.dir, "..", "web", appFile[0])), { headers: { "Content-Type": appFile[1], "Cache-Control": url.pathname === "/sw.js" || url.pathname.endsWith(".webmanifest") ? "no-cache" : "public, max-age=86400" } });
		// The other gateways read this computer's chosen name here (hub/peers.ts); it is a display name, no secret, so it is public like the manifest.
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/peer-info") return json({ name: resolveName(cfg.web?.machine_name, machineHost()) });
		// Pairing gates itself: only a request from this node's own tailscale login gets a token (hub/peer-pair.ts), so it needs no owner check first.
		if (req.method === "POST" && url.pathname === PAIR_PATH) return handlePair(req, { ownLogin });
		// A request with the peer header gets only the peer paths (hub/peer-auth.ts); a good one skips the owner check, a bad one never reaches it.
		const peer = checkPeer(req);
		if (peer === "denied") return new Response("forbidden", { status: 403 });
		if (peer === "none" && !authorized(req)) return new Response("forbidden", { status: 403 });
		const peerResponse = await peers.route(req, url);
		if (peerResponse) return peerResponse;
		// A user app's own web UI (hub/user-apps.ts, hub/app-proxy.ts): /apps/<id>/… -> its loopback server, same gate as the API.
		const proxied = proxyMatch(url.pathname);
		if (proxied) {
			const app = userApp(DATA_DIR, proxied.id, INTEGRATIONS.map(i => i.key));
			if (!app) return new Response("not found", { status: 404 });
			if (app.off) return new Response("이 앱은 꺼 두었어요", { status: 409 });
			return (await proxyRequest(req, url, app, proxied, srv)) as Response;
		}
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
			// No file is an empty script, not a 404: the service worker caches it with the shell, and one failed file would stop the whole cache.
			const body = req.method === "HEAD" ? null : (await file.exists()) ? file : "";
			return new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
		}
		const pushResponse = await pushRoute(req, url);
		if (pushResponse) return pushResponse;
		const updateResponse = await updateRoute(req, url, { boot: BOOT_ID, busy: busyNow, restartIdle: restartGateway, restartNow: restartGatewayNow });
		if (updateResponse) return updateResponse;
		// Settings → 업데이트 → 실행 하네스 (hub/harness-update.ts): the harness binary itself, from the package registry.
		const harnessUpdateResponse = await harnessUpdateRoute(req, url, { busy: busyNow, restartIdle: restartGateway });
		if (harnessUpdateResponse) return harnessUpdateResponse;
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
		// Deleting a project (hub/projectdelete.ts): GET .../delete-plan lists what would go, DELETE {archive?: false} does it.
		const projectDelete = /^\/api\/projects\/([^/]+)(\/delete-plan)?$/.exec(url.pathname);
		if (projectDelete && ((projectDelete[2] && req.method === "GET") || (!projectDelete[2] && req.method === "DELETE"))) {
			const key = decodeURIComponent(projectDelete[1]!);
			try {
				if (projectDelete[2]) return json(planDelete(key));
				return json(await deleteProject(key, { archive: (await body(req)).archive !== false }));
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof ProjectDeleteError ? error.status : 400);
			}
		}
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
		// Send lease of another gateway (hub/send-lease.ts): claim, release or record a sent id before an app message goes out.
		if (req.method === "POST" && url.pathname === "/api/peer/lease") return json(handleLease((await body(req)) as LeaseReq, Date.now()));
		// This computer's name for the settings screen: the one in use, the one the owner set (empty = none), and the hostname default.
		if (url.pathname === "/api/machine" && req.method === "GET") return json({ name: resolveName(cfg.web?.machine_name, machineHost()), custom: cleanName(cfg.web?.machine_name), default: friendlyName(machineHost()) });
		if (url.pathname === "/api/machine" && req.method === "PUT") {
			const name = cleanName((await body(req)).name);
			setMachineName(name);
			return json({ name: resolveName(name, machineHost()), custom: name, default: friendlyName(machineHost()) });
		}
		if (req.method === "GET" && url.pathname === "/api/workers") return json({ items: bgWork.list() });
		// 중단 (the worker's process ends; a lane's worker too) and 다시 맡기기 (its request goes to the orchestrator again, in its own conversation).
		const workerAct = req.method === "POST" ? /^\/api\/workers\/([\w.-]{1,80})\/(cancel|retry)$/.exec(url.pathname) : null;
		if (workerAct) {
			const id = workerAct[1]!;
			if (workerAct[2] === "cancel") {
				let r = await bgWork.cancel(id);
				for (const lane of lanes.values()) if (!r.ok && r.status === 404) r = await cancelOmoWorker(id, lane.sessionFile);
				return r.ok ? json({ ok: true, item: bgWork.list().find(w => w.id === id) }) : json({ error: r.error }, r.status);
			}
			const w = bgWork.list().find(x => x.id === id);
			if (!w) return json({ error: "이 작업을 찾을 수 없어요" }, 404);
			if (w.status !== "failed") return json({ error: w.status === "running" ? "아직 하고 있는 작업이에요" : "이미 끝난 작업이에요" }, 409);
			const to = workConversation(w.target, thread => mailByThread(thread)?.key);
			const mail = to.startsWith("mail:") ? mailByKey(to.slice(5)) : undefined;
			try {
				const project = to.startsWith("ch:") ? projectTarget(to, discord.channels.work) : undefined;
				await sendWeb({ mail, project, settings: to.startsWith("settings:") ? to.slice(9) : undefined, channel: "web", text: retryText(w, w.reply_to ? ownerMessage(w.reply_to)?.text : undefined), mode: "default", login: req.headers.get("tailscale-user-login") ?? "local" });
			} catch (error) {
				return json({ error: (error as Error).message }, 409);
			}
			return json({ ok: true, to });
		}
		if (req.method === "POST" && url.pathname === "/api/gateway/restart") return json({ ok: true, output: restartGateway() });
		if (url.pathname === "/api/state")
			return json({ name: NAME, address: ADDRESS, discord: discord.status, channels: discord.channels, orchestrator: { ...orch, lastText: orch.lastText.slice(0, 600), key_fallback: keyedSelector(orch.activeModel) }, terminals: Object.fromEntries(terminals), lanes: withHomes(laneSummary(), discord.channels), runs: stateRuns(), capacity: laneCapacity(), schedules: listSchedules(), auth: pendingAuth(), events: recentEvents(Number(url.searchParams.get("limit") ?? 100)), notices_unread: unreadCount(), work: bgWork.list(), work_now: Date.now(), web_build: webBuild() });
		if (req.method === "GET" && url.pathname === "/api/notices") return json({ ...listNotices(Number(url.searchParams.get("limit") ?? 100)), gone: dismissedAlertAts() });
		if (req.method === "GET" && url.pathname === "/api/monitors") return json({ items: listMonitors() });
		// Run one watch now (the web's 지금 확인 / 지금 다시 확인): the same runner the timer uses, awaited so the answer carries the new result.
		const watchRun = req.method === "POST" ? /^\/api\/watches\/([a-z0-9-]{1,40})\/run$/.exec(url.pathname) : null;
		if (watchRun) {
			const name = watchRun[1]!;
			const w = allWatches().find(x => x.name === name || x.id === name);
			if (!w) return json({ error: `no watch ${name}` }, 404);
			// A disconnected watch behind an approval gate (a login that sends a push to the owner's phone) reconnects only with his yes; the tap
			// on 다시 연결 is that yes, so it is approved (approveWatch runs it) instead of a plain run that would only report it still waits.
			if (w.approval_minutes && watchConnection(w).state === "disconnected") {
				approveWatch(w.id);
				const item = listMonitors().find(m => m.kind === "watch" && m.watch === name);
				return json({ ok: true, approved: true, ...(item ? { item } : {}) });
			}
			await runWatch(name);
			const item = listMonitors().find(m => m.kind === "watch" && m.watch === name);
			return json({ ok: true, ...(item ? { item } : {}) });
		}
		const sentMailRefs = () => sentReplyRefs(listDrafts());
		// The pending reply drafts of one mail are dropped (the same store step as 보내지 않기) and their approval cards settled at once.
		const dropMailDrafts = async (key: string) => {
			const pending = listDrafts().filter(d => d.ref === key && (d.status === "pending" || d.status === "held"));
			if (pending.length) {
				const { dropDraft } = await import("../features/reply-drafts/lib/flow.ts");
				for (const d of pending) { const r = dropDraft(d.id); if (!r.ok) log(`draft ${d.id}: not dropped with its mail: ${r.text}`); }
			}
			await settleHandledDrafts().catch(e => log(`mail ${key}: handled-draft settle failed: ${(e as Error).message}`));
		};
		const unrepliedMailList = () => unrepliedMails(sentMailRefs());
		// A draft a send-approval notice already shows (its `> 참조:` ref) is that notice's card; the store's own list leaves it out, so nothing counts twice.
		const noticeDraftRefs = (): Set<string> => new Set(listNotices(NOTICE_CAP).items.flatMap(n => (n.decision?.state === "open" && !n.ignored && typeof n.decision.draft?.ref === "string" ? [n.decision.draft.ref] : [])));
		// The KakaoTalk reply drafts waiting in watched rooms count as the kakao app's drafts beside the comment apps' (hub/integrations.ts needs.drafts).
		const draftNeeds = () => withStoreDrafts(commentNeeds(), "kakao", kakaoPendingCount(noticeDraftRefs()));
		const integrationView = () => {
			const convUnread = Object.fromEntries(mailTargets().map(t => [t, unreadOf(t)]));
			const ctx = integrationContext(DATA_DIR, (cfg as { zele?: { enabled?: boolean } }).zele?.enabled !== false && Bun.which("zele") ? ["zele", ...commentFlags()] : commentFlags());
			const own = ownedWatches(DATA_DIR, allWatches());
			const items = integrationItems(ctx, listNotices(NOTICE_CAP).items, convUnread, 100, undefined, mailSuggests(), Date.now(), draftNeeds(), { targets: unrepliedMailList().map(m => mailTarget(m.key)), apps: { kakao: kakaoUnreplied() } }).map(i => withConnection({ ...i, own: own.get(i.key) ?? [] }, allWatches()));
			return { items, available: integrationAvailable(items, ctx) };
		};
		if (req.method === "GET" && url.pathname === "/api/integrations") return json(integrationView());
		// 답장 확인 (web/js/30-replies.js): the reply drafts the apps keep in their own stores (KakaoTalk rooms, comment sources), newest first. A mail
		// draft is a send-approval notice and is read from the notices; a store draft such a notice already shows is left out.
		if (req.method === "GET" && url.pathname === "/api/replies") {
			const skip = noticeDraftRefs();
			const kakao = (await kakaoPendingDrafts(skip).catch(() => [])).map(d => ({ kind: "kakao", app: "kakao", conv: `kakao:${d.chatId}`, at: Date.parse(d.created) || 0, ...d }));
			const comments = commentPending().filter(d => !skip.has(d.code)).map(d => ({ ...d, kind: "comment", via: d.kind, at: d.created }));
			// The model a draft of that app uses (the app instance's 답장 모델, else the reply default) goes on the card's head when known.
			const models = new Map<string, string>();
			const withModel = async <T extends { app: string; conv?: string }>(item: T) => {
				const key = `${item.app}|${item.conv ?? ""}`;
				if (!models.has(key)) models.set(key, await replyModel(item.app, item.conv).then(replyModelLabel).catch(() => ""));
				return models.get(key) ? { ...item, model: models.get(key) } : item;
			};
			const items = await Promise.all([...kakao, ...comments].map(withModel));
			return json({ items: items.sort((a, b) => b.at - a.at) });
		}
		// The 앱 list (hub/user-apps.ts): the 모니터링 apps this install has on, then the owner's own manifests (with their health).
		if (req.method === "GET" && url.pathname === "/api/apps") {
			const view = integrationView();
			const { apps, errors } = loadUserApps(DATA_DIR, INTEGRATIONS.map(i => i.key));
			const items = [
				...view.items.map(i => ({ id: i.key, label: i.label, kind: "monitor", source: "registry", icon: i.icon, ...(i.iconPath ? { iconPath: i.iconPath } : {}), status: i.state === "disconnected" ? "unreachable" : "running", ...(i.state === "disconnected" && i.hint ? { hint: i.hint } : {}) })),
				...await Promise.all(apps.map(async a => {
					const h = a.off ? { status: "unknown" as const } : await appHealth(a);
					return { id: a.id, label: a.label, kind: a.kind, source: "manifest", icon: a.icon ?? "file", ...(a.iconPath ? { iconPath: a.iconPath } : {}), off: a.off, status: a.off ? "off" : h.status, ...(!a.off && h.reason ? { reason: h.reason } : {}), ...(!a.off && h.checkedAt ? { checkedAt: h.checkedAt } : {}), health: a.health, watches: a.watches, settings: a.settings, ...(a.web ? { web: { url: a.web.url, path: a.web.path, mode: a.web.mode, href: `${PROXY_ROOT}/${a.id}/` } } : {}), ...(a.start ? { start: a.start } : {}) };
				})),
			];
			return json({ items, errors });
		}
		// A manifest app's switch and removal (끄기/켜기, 제거); an id that is not a manifest falls through to the app instances below.
		const userAppRoute = /^\/api\/apps\/([a-z0-9-]+)$/.exec(url.pathname);
		if (userAppRoute && req.method === "PATCH") {
			if (!userApp(DATA_DIR, userAppRoute[1]!, INTEGRATIONS.map(i => i.key))) return json({ error: "알 수 없는 앱이에요" }, 404);
			setUserAppOff(DATA_DIR, userAppRoute[1]!, (await body(req)).off !== false);
			return json({ ok: true });
		}
		// The 새로 추가하기 prompts (hub/app-templates.ts): shipped ones, replaced or extended by custom/app-templates.json.
		if (req.method === "GET" && url.pathname === "/api/app-templates") return json({ items: readAppTemplates(DATA_DIR) });
		// 제거 / 앱 추가 on this install only (hub/app-off.ts): GET remove = what will be removed, POST remove = do it ({deleteData}), POST add = switch it back on.
		const appLife = /^\/api\/integrations\/([a-z0-9-]+)\/(remove|add)$/.exec(url.pathname);
		if (appLife) {
			const [, app, op] = appLife;
			try {
				if (!appEntries(DATA_DIR).some(e => e.key === app && !e.gone)) throw new SettingsError(`${app}: 알 수 없는 앱이에요`, 404);
				const names = () => allWatches().map(w => w.name);
				if (op === "remove" && req.method === "GET") return json(removalPlan(DATA_DIR, app!, names()));
				if (op === "remove" && req.method === "POST") return json({ ok: true, removed: removeApp(DATA_DIR, app!, { deleteStored: (await body(req)).deleteData === true }, { watchNames: names, removeWatch }) });
				if (op === "add" && req.method === "POST") {
					writeSettings(DATA_DIR, app!, { use_here: true });
					return json({ ok: true, ready: integrationView().items.some(i => i.key === app) });
				}
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof SettingsError ? error.status : 400);
			}
		}
		// App instances (hub/app-off.ts): POST /api/apps {app, label?, filter?, id?} registers another instance of an app (the orchestrator or a feature's onboard
		// script calls it), DELETE /api/apps/<id>[?data=1] deletes an OFF instance for good (data=1 also deletes its stored data).
		const appDel = /^\/api\/apps\/([a-z0-9-]+)$/.exec(url.pathname);
		if (url.pathname === "/api/apps" && req.method === "POST" || appDel && req.method === "DELETE") {
			try {
				if (appDel) {
				const own = removeUserApp(DATA_DIR, appDel[1]!, INTEGRATIONS.map(i => i.key));
				if (own) return json({ ok: true, removed: own.kept });
				return json({ ok: true, removed: deleteApp(DATA_DIR, appDel[1]!, { deleteStored: url.searchParams.get("data") === "1" }, { watchNames: () => allWatches().map(w => w.name), removeWatch }) });
			}
				return json({ ok: true, ...createApp(DATA_DIR, await body(req)) });
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof SettingsError ? error.status : 400);
			}
		}
		// An app's features, internal functions (login keeper, sync) and approvals (hub/app-features.ts); 다시 시도 runs one owned watch now.
		const appFeat = /^\/api\/integrations\/([a-z0-9-]+)\/(features|retry)$/.exec(url.pathname);
		if (appFeat) {
			const [, app, op] = appFeat;
			try {
				if (op === "features" && req.method === "PATCH") {
					const b = await body(req);
					setFeature(DATA_DIR, app!, b.id, b.on);
				}
				if (op === "retry" && req.method === "POST") await retryInternal(DATA_DIR, app!, (await body(req)).watch, allWatches(), runWatch, approveWatch);
				else if (op === "retry" || (req.method !== "GET" && req.method !== "PATCH")) return json({ error: "not found" }, 404);
				return json(featuresOf(DATA_DIR, app!, allWatches(), listNotices(NOTICE_CAP).items));
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof SettingsError ? error.status : 400);
			}
		}
		// Per-app settings (hub/app-settings.ts): GET reads, PATCH is the one write path (the web's switches and a change card's 적용 both call it).
		const appSettings = /^\/api\/integrations\/([a-z0-9-]+)\/settings$/.exec(url.pathname);
		if (appSettings && (req.method === "GET" || req.method === "PATCH")) {
			const app = appSettings[1]!;
			try {
				await refreshReplyModelChoices();
				if (!fieldsOf(app).length || !appEntries(DATA_DIR).some(e => e.key === app && !e.gone)) throw new SettingsError(`${app}: 바꿀 수 있는 설정이 없어요`, 404);
				return json({ key: app, fields: req.method === "GET" ? readSettings(DATA_DIR, app) : writeSettings(DATA_DIR, app, (await body(req)).values) });
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof SettingsError ? error.status : 400);
			}
		}
		if (req.method === "POST" && url.pathname === "/api/notices/read") return json(markNoticesRead(await body(req)));
		// The bot closes the questions whose matter is over (ids, match text, conv or all): they are answered, read and off 답변 필요.
		if (req.method === "POST" && url.pathname === "/api/notices/resolve") return json(resolveNotices(await body(req)));
		// 되돌리기 after 보내지 않기 also puts the mail reply draft back in its store (the peer act notice reopen lands here too).
		if (req.method === "POST" && url.pathname === "/api/notices/reopen") {
			const ids = (await body(req)).ids, refs = droppedDraftRefs(listNotices(NOTICE_CAP).items, ids);
			const r = reopenNotices(ids);
			await restoreReopenedDrafts(refs, r.reopened, log);
			return json(r);
		}
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
		// The waiting send-approval cards of a conversation, their batch answer and the owner's own edit of a draft (hub/approval-wire.ts).
		if (url.pathname === "/api/approvals" || /^\/api\/drafts\/[^/]+\/body$/.test(url.pathname)) {
			const login = req.headers.get("tailscale-user-login") ?? "local";
			const res = await approvalRoute(req, url, { login, triageMin: cfg.web.triage_min ?? TRIAGE_MIN_DEFAULT, deliver: (to, text, picks, decision) => deliverAnswer({ to, text, picks, notice: decision ?? "", login }) });
			if (res) return res;
		}
		// A button of a decision notice: the answer goes where the question came from (chat, session, project chat or login request).
		const decide = req.method === "POST" ? /^\/api\/notices\/([^/]+)\/answer$/.exec(url.pathname) : null;
		if (decide) {
			const login = req.headers.get("tailscale-user-login") ?? "local";
			const answer = await body(req);
			const via = viaOf(answer.via);
			let files: ReturnType<typeof ownerFiles>;
			try {
				files = ownerFiles(answer.files);
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof FileError ? error.status : 400);
			}
			// 보내기 on a draft the gateway sends itself takes its path (hub/approval-wire.ts webAnswer); every other answer goes to the bot.
			const r = await webAnswer(decodeURIComponent(decide[1]!), { ...answer, files }, login, a => deliverAnswer({ ...a, login, via }));
			// 보내지 않기 on a mail reply draft drops it in the reply-drafts store at once (not only when the bot gets to it), so every count and
			// list, here and on the other computer, sees it gone.
			if (r.status === 200 && !r.body.already) await dropAnsweredMailDraft(r.body.item as Notice | undefined, Number(answer.n), log);
			return json(r.body, r.status);
		}
		if (req.method === "POST" && url.pathname === "/api/read") {
			const r = markRead(await body(req));
			// Reading a conversation also reads its bell items up to there (whether or not the position moved), so the two never disagree.
			if (r.ok) readConversationNotices(r.target, r.ts);
			return json(r, r.ok ? 200 : 400);
		}
		if (req.method === "GET" && url.pathname === "/api/conversations") {
			settleMailDrafts(listDrafts());   // a dropped draft takes its 초안 있음 off before the rows are drawn
			const owed = new Set(unrepliedMailList().map(m => m.key));
			const sent = sentMailRefs();
			// Ended sessions are listed too: their unread count and 답변 필요 stay on their row in the folded 끝난 세션 group (web/js/04-state.js endedGroup).
			// A mail conversation is listed only while its mail is: a deleted mail (mail-deleted.json) keeps its messages in the log, but it leaves
			// this list, so it leaves every list and count here and on the other computer (its snapshot is this list, hub/peer-monitor.ts).
			const lv = liveLanes();
			const items = conversationList([...[...lv.live, ...lv.ended].map(n => `lane:${n}`), ...Object.keys(discord.channels.work).map(id => `ch:${id}`), ...mailTargets()]).flatMap(c => {
				if (!c.target.startsWith("mail:")) return [c];
				const m = mailByKey(c.target.slice(5));
				return m ? [{ ...c, mail: mailCard(m, owed.has(m.key), sent.has(m.key)) }] : [];
			});
			return json({ items });
		}
		// One attached file of a mail: only files the mail's own record names, only inside the mail files folder (hub/mail.ts).
		const mailFile = (req.method === "GET" || req.method === "HEAD") && /^\/api\/mail\/([a-z0-9._-]+)\/files\/(\d+)$/.exec(url.pathname);
		if (mailFile) return mailFileRoute(req, url, mailFile[1]!, mailFile[2]!);
		// One file a draft sends along (the `> 첨부:` lines of a send approval): only files staged for that draft (hub/draft-files.ts).
		const draftFile = (req.method === "GET" || req.method === "HEAD") && /^\/api\/drafts\/([A-Za-z0-9._-]+)\/files\/(\d+)$/.exec(url.pathname);
		if (draftFile) return draftFileRoute(req, url, draftFile[1]!, draftFile[2]!, undefined, askedFile);
		// Add or remove a file of a mail reply draft, and the 첨부 파일 폴더 listing (hub/draft-attach.ts).
		const draftAttach = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/(files|library|original)$/.exec(url.pathname);
		if (draftAttach) return draftAttachRoute(req, url, draftAttach[1]!, draftAttach[2]!);
		// 답장 | 전체 답장 and the 받는 사람·참조 of a waiting mail draft (hub/draft-recipients.ts).
		const draftRecipients = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/recipients$/.exec(url.pathname);
		if (draftRecipients) return draftRecipientsRoute(req, draftRecipients[1]!);
		// 답장 안 함 (no-reply = skipped, fyi; one label to the owner) on a mail (POST) or 답장 필요로 표시 (DELETE): the owner's mark that this mail needs no reply (hub/mail-state.ts).
		// Its reply draft waiting for approval is held in the drafts store (not dropped) and its card leaves 확인 대기 before the answer; taking the
		// mark back restores the newest held draft and reopens its card. A peer's 되돌리기 arrives here too (hub/peer-monitor.ts act fyi / no-reply).
		const mailNoReply = (req.method === "POST" || req.method === "DELETE") && /^\/api\/mail\/([a-z0-9._-]+)\/(no-reply|fyi)$/.exec(url.pathname);
		if (mailNoReply) {
			const key = mailNoReply[1]!;
			if (!(mailNoReply[2] === "fyi" ? setMailFyi : setMailNoReply)(key, req.method === "POST")) return json({ error: "이 메일을 찾지 못했어요" }, 404);
			if (req.method === "POST") {
				holdDrafts(key);
				await settleHandledDrafts().catch(e => log(`mail ${key}: handled-draft settle failed: ${(e as Error).message}`));
			} else {
				const back = restoreDrafts(key);
				if (back) reopenDraftNotices([back]);
			}
			broadcast({ kind: "mail_unreplied", target: mailTarget(key) });
			return json({ ok: true });
		}
		// 삭제 on a mail card: the mail leaves dotz (record, list entry, counts, its notices and pending drafts); the real mailbox is not touched.
		const mailDelete = req.method === "DELETE" && /^\/api\/mail\/([a-z0-9._-]+)$/.exec(url.pathname);
		if (mailDelete) {
			const key = mailDelete[1]!;
			if (!deleteMail(key)) return json({ error: "이 메일을 찾지 못했어요" }, 404);
			await dropMailDrafts(key);
			readConversationNotices(mailTarget(key), new Date().toISOString());
			broadcast({ kind: "mail_unreplied", target: mailTarget(key) });
			return json({ ok: true });
		}
		// 초안 작성 on a mail: the owner asks for a reply draft himself. It is made behind the request (a model call takes a while, and a peer's
		// forwarded act has a short timeout); the draft lands as the send-approval card in the mail's conversation, a failure as a line there.
		const mailDraft = req.method === "POST" && /^\/api\/mail\/([a-z0-9._-]+)\/draft$/.exec(url.pathname);
		if (mailDraft) {
			const key = mailDraft[1]!, r = mailByKey(key), deps = mailDeps?.();
			if (!r || r.dir === "out") return json({ error: "이 메일을 찾지 못했어요" }, 404);
			if (!deps?.requestDraft) return json({ error: "이 설치에는 답장 초안 기능이 없어요" }, 503);
			const target = mailTarget(key);
			// What the owner typed in the 초안 작성 box (empty: the draft is made on its own).
			const instruction = String((await body(req).catch(() => ({})) as { instruction?: unknown }).instruction ?? "").trim().slice(0, 500);
			void deps.requestDraft({ key, ...(instruction ? { instruction } : {}), target, ...(r.thread ? { thread: r.thread } : {}), ...(r.msg ? { messageId: r.msg } : {}), source: r.source, id: r.id, subject: r.subject, from: r.from, ...(r.to ? { to: r.to } : {}), ...(r.cc ? { cc: r.cc } : {}), ...(r.summary ? { summary: r.summary } : {}), ...(r.attachments?.some(a => !a.inline) ? { attachments: r.attachments.filter(a => !a.inline).map(a => ({ name: a.name, size: a.size })) } : {}) })
				.then(res => { if (res !== "offered") return deps.send(target, "답장 초안을 만들지 못했어요. 잠시 뒤 다시 눌러 주세요"); })
				.catch(e => log(`mail ${key}: requested draft failed: ${(e as Error).message}`));
			return json({ ok: true, started: true }, 202);
		}
		const mailBody = req.method === "GET" && /^\/api\/mail\/([a-z0-9._-]+)\/body$/.exec(url.pathname);
		if (mailBody) return mailBodyRoute(mailBody[1]!);
		// A mail from an outside poster (a webmail watcher, a custom plugin): one conversation per mail (hub/mail.ts, docs/custom-plugins.md).
		// The reply and KakaoTalk CLIs report an approved send here; the gateway wakes the bot once when that app has a 이어서 할 일 rule (hub/followup.ts).
		if (req.method === "POST" && url.pathname === "/api/followup") {
			const input = parseFollowup(await body(req));
			// The approved reply went out: the mail is 답장함 (hub/mail-state.ts), whether or not the app has a 이어서 할 일 rule.
			if (input?.kind === "mail" && input.ids.mail && setMailReply(input.ids.mail, "sent")) broadcast({ kind: "mail_unreplied", target: mailTarget(input.ids.mail) });
			return input ? json({ ok: true, result: triggerFollowup(input) }) : json({ error: "app, kind (comment|mail|kakao), key required" }, 400);
		}
		if (req.method === "POST" && url.pathname === "/api/mail/compose") {
			if (!mailDeps) return json({ error: "mail is not wired in this process" }, 503);
			try {
				return json(composeMail(await body(req), mailDeps()));
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof MailError ? error.status : 500);
			}
		}
		if (req.method === "POST" && url.pathname === "/api/mail") {
			if (!mailDeps) return json({ error: "mail is not wired in this process" }, 503);
			if (readAppOff(DATA_DIR).has("mail")) return json({ error: "mail is off on this install" }, 409);
			try {
				return json(await postMail(await body(req), mailDeps()));
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof MailError ? error.status : 500);
			}
		}
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (req.method === "GET" && url.pathname === "/api/history") {
			const target = url.searchParams.get("target") ?? "main";
			if (target !== "main" && target !== "alert" && target !== "worklog" && !target.startsWith("lane:") && !isProjectTarget(target) && !isMailTarget(target) && !isSettingsTarget(target)) return json({ error: "target must be main, alert, worklog, lane:<name>, ch:<id>, mail:<key> or settings:<app>" }, 400);
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
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/canvas") {
			return canvasRoute(req, url, fileRoots(), sentFiles());
		}
		// A file of a conversation of this computer, opened from the other one: an upload the owner attached (the chip in the sent bubble),
		// or a result file the bot posted or wrote ([file] lines, paths), under the same rules as this computer's own /api/file.
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/peer/file") {
			const [f] = messageFiles([{ path: url.searchParams.get("path") ?? "" }]);
			if (!f) return fileRoute(req, url, fileRoots(), sentFiles());
			const res = serveFile(f.path, req, url.searchParams.get("download") === "1");
			return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
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
			let files: ReturnType<typeof ownerFiles>;
			try {
				files = ownerFiles(b.files);
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof FileError ? error.status : 400);
			}
			const elements = ownerElements(b.elements);
			if (!b.text && !files.length && !elements.length) return json({ error: "text required" }, 400);
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
			if (mode === "queue" && !project && !mail && !conv && (lane ? lanes.has(lane) : !parseCommand(text) && !looksLikeCommand(text)) && (lane ? lanes.get(lane)?.status === "working" : orch.status === "working")) {
				const item = enqueue(lane ? `lane:${lane}` : "main", [reply ? replyLine(reply) : "", text, files.length ? attachmentLines(files) : "", elements.length ? pickedLines(elements) : ""].filter(Boolean).join("\n"), login);
				return json({ ok: true, queued: item });
			}
			try {
				// A decision answer from the chat card: the asking message (its ts) and the chosen option per block (intake.ts decisionLines).
				const picks = Array.isArray(b.picks) ? b.picks.slice(0, 10).flatMap((p: any) => (p && Number.isFinite(Number(p.n)) ? [{ q: String(p.q ?? "").slice(0, 200), n: Number(p.n), label: String(p.label ?? "").slice(0, 120), ...(typeof p.note === "string" && p.note.trim() ? { note: p.note.replace(/\s+/g, " ").trim().slice(0, 500) } : {}) }] : [])) : [];
				await sendWeb({ lane, project, mail, settings, conv: lane || project || mail || settings ? undefined : conv, channel, text, mode: mode === "queue" ? "default" : mode, login, files, ...(elements.length ? { elements } : {}), ...(typeof b.reply_to === "string" && b.reply_to ? { replyTo: b.reply_to.slice(0, 40) } : {}), ...(reply ? { reply } : {}), ...(picks.length ? { picks } : {}), via: viaOf(b.via) });
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
				if (cur && !cur.done && cur.text.startsWith(MAIN === from ? "[conversation " : "[main session] ")) return json({ error: "handed work: answer it here, do not pass it on" }, 409);
				const toMain = from !== MAIN;
				if (!toMain && !convs.get(key)) return json({ error: `no conversation session ${key}` }, 404);
				// Into main: its answer goes to the conversation that asked, where its own window shows it.
				if (toMain) {
					queue.deliver(`[conversation ${from}] ${text}`, { target: sender.primary, replyTo: cur?.replyTo });
					return json({ ok: true, to: MAIN, answers_in: sender.primary });
				}
				const c = convs.get(key)!;
				// Main's request goes in as that conversation's next turn with no reply_to: its answer is posted into the conversation.
				convs.deliverTo(key, `[main session] ${text}`, undefined);
				return json({ ok: true, to: key, answers_in: c.primary });
			}
		}
		if (req.method === "POST" && url.pathname === "/api/send") {
			const b = await body(req);
			const target = String(b.target ?? "chat");
			// A conversation's own session answers only there (hub/convsessions.ts): a post of it anywhere else, an early text, a
			// progress note or a send with no reply_to alike, is refused, so another window's answer never lands in this one.
			const session = typeof b.session === "string" && b.session ? b.session : MAIN;
			if (session !== MAIN && convs.keyOf(target) !== session) return json({ delivered: false, reason: `this session answers only ${primaryTarget(session)}; hand other work to main with dotz_conv send main` }, 403);
			const sender = convs.get(session)?.queue ?? queue;
			// `resolves` (text in the title / text of the open questions it settles, or "*" for all): this post says their matter is over.
			if (typeof b.resolves === "string" && b.resolves.trim()) resolveNotices(b.resolves.trim() === "*" ? { all: true } : { match: b.resolves });
			if (b.update_key) {
				try {
					return json(await progress(target, String(b.update_key), String(b.text ?? ""), b.reply_to));
				} catch (error) {
					return json({ delivered: false, reason: (error as Error).message }, 502);
				}
			}
			// Answer only when it is ready: an early text to the asking channel waits for the turn's final answer. Meanwhile the owner
			// sees it at once on that conversation's progress line (owner 2026-10-28: 중간 말을 바로 보여 주기), which the answer replaces.
			if (sender.holdEarly(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined)) {
				void progress(target, "progress", String(b.text ?? ""), b.reply_to).catch(e => log(`early text not shown on the progress line: ${(e as Error).message}`));
				return json({ delivered: true, held: true, note: "held: it is shown on the progress line now and goes out together with your final answer for this request; do not send it again" });
			}
			sender.sent(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined);
			try {
				return json(await out(target, String(b.text ?? ""), b.reply_to));
			} catch (error) {
				return json({ delivered: false, reason: (error as Error).message }, 502);
			}
		}
		const commentsResponse = await commentsRoute(req, url, parts);
		if (commentsResponse) return commentsResponse;
		const igDmResponse = await igDmRoute(req, url, parts);
		if (igDmResponse) return igDmResponse;
		const kakaoResponse = await kakaoRoute(req, url, parts);
		if (kakaoResponse) return kakaoResponse;
		const settingsResponse = await routeSettings(req, url, parts);
		if (settingsResponse) return settingsResponse;
		const laneResponse = await routeLanes(req, url, parts);
		if (laneResponse) return laneResponse;
		return new Response("not found", { status: 404 });
	};
	const peers = createPeerMonitor({ name: () => resolveName(cfg.web?.machine_name, machineHost()), bot: () => NAME, local: route, localHeaders: { "x-dotz-token": HUB_TOKEN }, orchestrator: () => ({ status: orch.status, pauseKind: orch.pauseKind }), runs: () => Object.fromEntries(Object.entries(stateRuns()).filter(([k]) => k.startsWith("mail:"))) });
	activatePeerMonitor(peers);
	return route;
}
