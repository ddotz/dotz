// HTTP routing of the hub: the install files, the identity check and the first part of the route chain; the rest is routes-settings.ts and routes-lanes.ts.
// Split out of main.ts; the restart hooks come from main as plumbing, so this module never imports it.
import { readFileSync } from "node:fs";
import { dropAnsweredMailDraft } from "./draft-drop.ts";
import { approvalRoute, webAnswer } from "./approval-wire.ts";
import { replies, setReplyBot } from "./reply-wire.ts";
import { replyRoute } from "./reply-route.ts";
import { join } from "node:path";
import { cloudflareGate } from "./devices.ts";
import { type Confirm, nativeConfirm } from "./local-login-dialog.ts";
import { createLocalLogin } from "./local-login.ts";
import { createWebAccess, localBrowser, WebAccessError, webAccessRoute } from "./web-access.ts";
import type { Server } from "bun";
import { ADDRESS, cfg, DATA_DIR, HUB_TOKEN, log, NAME, now, PORT, setMachineName } from "./config.ts";
import { lang } from "./i18n.ts";
import { limitWaits } from "./limitwait.ts";
import { buildWaitlist } from "./waitlist.ts";
import { keyedSelector } from "./fallback.ts";
import { changeTarget, ControlError, targetView, ForceRequired } from "./control.ts";
import * as discord from "./discord.ts";
import { authRoute, pendingAuth } from "./auth.ts";
import { pushRoute } from "./push.ts";
import { INTEGRATIONS } from "./integrations.ts";
import { allWatches, approveWatch, runWatch } from "./watch.ts";
import { watchConnection } from "./watch-status.ts";
import { isSettingsTarget } from "./app-settings.ts";
import { markRead } from "./reads.ts";
import { shownEvent } from "./owner-text.ts";
import { activityItems, historyEvents, historyPage, locateMessage, ownerMessage, recentEvents, sentFiles, sseResponse } from "./events.ts";
import { subagentLists } from "./activity.ts";
import { cancelOmoWorker, retryText, runningOmoWork, workConversation } from "./bgwork.ts";
import { lastTurnActed, lastTurnEnd, lastTurnFailed, mailConversation, openTodos, runIntent, runState, stallStep, workConversationRuns, type RunState, type StallMemo } from "./runstate.ts";
import { isProjectTarget, projectTarget } from "./projectchat.ts";
import { isMailTarget } from "./conv-model.ts";
import { syncCardFiles } from "./draft-attach.ts";
import { mailOpened, mailByKey, mailByThread, sentMailEvent, type MailDeps } from "./mail.ts";
import { canvasRoute, FileError, messageFiles, ownerFiles, serveFile, UPLOAD_MAX_BYTES, uploadsFrom } from "./files.ts";
import { laneCapacity, laneClosed, lanes, laneSummary } from "./lanes.ts";
import { withHomes } from "./laneviews.ts";
import { main as mainOrch, orch } from "./orchestrator.ts";
import { listMonitors } from "./monitors.ts";
import { type DecisionSend, type Notice, allNotices, listNotices, dismissedAlertAts, readConversationNotices, unreadCount } from "./notices.ts";
import { loadProjects, saveProject } from "./projects.ts";
import { deleteProject, planDelete, ProjectDeleteError } from "./projectdelete.ts";
import { listSchedules } from "./schedule.ts";
import { laneTodo, openMonitor, readTodo } from "./todo.ts";
import { customRoute, ownFolders } from "./custom.ts";
import { activateFleetLaunch, activeFleetLaunch, createFleetLaunch } from "./fleet-launch.ts";
import { deliverToSession } from "./lanewire.ts";
import { deleteKey, importOmoKey, keysView, saveKey } from "./apikey-store.ts";
import { updateRoute } from "./selfupdate.ts";
import { updateNow } from "./update-now.ts";
import { harnessUpdateRoute } from "./harness-update.ts";
import { appAsset, committedText, indexPage, manifestI18n, setAppLang, setAppName, swScript, webBuild } from "./webapp.ts";
import { forgetRoute, listPeers, ownLogin } from "./peers.ts";
import { AGENT_AUTHOR, ambientWrite, entryHost, ownTailnetName, refuse, tokenOk } from "./entry-check.ts";
import { peerProjects } from "./peer-projects.ts";
import { relayRoute, relayRows } from "./relay-route.ts";
import { handlePair, PAIR_PATH } from "./peer-pair.ts";
import { checkPeer } from "./peer-auth.ts";
import { activatePeerMonitor, createPeerMonitor } from "./peer-monitor.ts";
import { activateFleet, createFleet, loadCore } from "./fleet.ts";
import { peerLimitNotice } from "./limit-peer.ts";
import { handleLease, type LeaseReq } from "./send-lease.ts";
import { cleanName, friendlyName, resolveName } from "./machine-name.ts";
import { machineHost } from "./hostname.ts";
import { queue, bgWork, workRows, out, fileRoots } from "./outbound.ts";
import { convs, maxLiveView } from "./convsessions.ts";
import { QUICK } from "./session-key.ts";
import { sendWeb } from "./intake.ts";
import { json, body, terminals, BodyError } from "./routes-util.ts";
import { ptyRoute } from "./pty.ts";
import { desk } from "./remote-desktop.ts";
import { listedFileRoute } from "./listed-files.ts";
import { routeApps } from "./routes-apps.ts";
import { routeLanes } from "./routes-lanes.ts";
import { escalations } from "./escalate.ts";
import { routeNotices } from "./routes-notices.ts";
import { addInputDiag } from "./input-diag.ts";
import { routeSettings } from "./routes-settings.ts";
import { routeMail, unrepliedMailList } from "./routes-mail.ts";
import { routeSend, viaOf } from "./routes-send.ts";
import { commentsRoute } from "./comments/gateway.ts";
import { userApp } from "./user-apps.ts";
import { proxyMatch, proxyRequest } from "./app-proxy.ts";
import { igDmRoute } from "./ig-dm-gateway.ts";
import { kakaoRoute } from "./kakao/gateway.ts";
import { defaultOnboardDeps, onboardingService, setOnboardDeps } from "./onboarding.ts";
import { saveWebAccessInput } from "./onboarding-web-access.ts";
import { createSetupGate } from "../firstrun/setup-gate.ts";
import { chartRoute } from "./chart.ts";

const BOOT_ID = Date.now().toString(36);
setAppName(NAME); setAppLang(lang());
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
export const ALLOW = new Set((cfg.web?.allow_logins ?? []).map(s => s.toLowerCase()));

// Runtime web access (hub/web-access.ts, 설정 → 웹 접속): web.access = "cloudflare" is switched on and off live, so the gates below are read through it per request.
// In that mode a valid Cloudflare Access token (hub/cf-access.ts) is checked once at the route entry (it needs the key fetch), then passed in as cfOk,
// and only paired devices (hub/devices.ts) get in; Access, when set up, is required on top of the device session.
// The Tailscale-User-Login header is trusted only in "tailscale" mode: elsewhere nothing vouches for it, so whoever reaches the port could write it.
// In "local" (이 컴퓨터만) a browser on this computer logs in once: a button on the login page makes the gateway ask on the owner's screen (or the bot hands out a
// link, hub/web-login-cli.ts). In every mode the `dotz` command logs a browser on this computer in with that same link; changing the mode voids such sessions (hub/local-login.ts).
let confirmLogin: Confirm = nativeConfirm;
/** Tests replace the native confirmation dialog of the login page (hub/local-login-dialog.ts) with a fake whose answer they control. */
export const setLoginConfirm = (c: Confirm): void => { confirmLogin = c; };
export const localLogin = createLocalLogin({ dir: DATA_DIR, confirm: number => confirmLogin(number) });
export const webAccess = createWebAccess({ dir: DATA_DIR, allow: ALLOW, notify: text => out("alert", text, undefined, { source: "gateway" }), onModeChange: () => localLogin.clear() });
localLogin.keepMode(webAccess.mode());

function authorized(req: Request, cfOk = false, devOk = false, peerIp?: string, tailnet = false): boolean {
	if (tokenOk(req)) return true;
	if (localBrowser(req, peerIp) && localLogin.verify(req, webAccess.mode())) return true;
	if (webAccess.devices() ? cloudflareGate({ device: devOk, accessConfigured: !!webAccess.cfAccess(), access: cfOk }) : cfOk) return true;
	const login = (req.headers.get("tailscale-user-login") ?? "").toLowerCase();
	if (login && tailnet && ALLOW.has(login) && webAccess.mode() === "tailscale") return true;
	const seen = [...req.headers.keys()].filter(k => k.startsWith("tailscale-")).map(k => `${k}=${req.headers.get(k)}`).join(" ");
	log(`denied ${new URL(req.url).pathname} ${seen || "(no tailscale identity headers)"} from ${req.headers.get("x-forwarded-for") ?? "unknown"}`);
	return false;
}

const compactingNow = (ctx: { compaction?: { state?: string } } | undefined): boolean => ctx?.compaction?.state === "queued" || ctx?.compaction?.state === "compacting";
// Every 30 s: a conversation (main, a conversation session or a session) resting with plan tasks left and nothing to wait for is told to go on
// (runstate.ts stallStep); `nudge` delivers the prompt into that conversation's own session.
export function startStallSweep(nudge: (conversation: string, r: RunState) => void): void {
	const told = new Map<string, StallMemo>();
	const timer = setInterval(() => {
		try {
			const runs = stateRuns(), now = Date.now();
			// sessions too: acme-loss-review on the Mac mini (2026-10-29 01:53Z) ended a turn with a [run] report and 13 tasks open, and
			// nothing woke it (a [run] report stays on disk)
			const keys = ["main", ...convs.conversations().filter(c => convs.live(c)).map(c => c.primary), ...[...lanes.values()].filter(l => !!l.proc && !laneClosed(l)).map(l => `lane:${l.name}`)];
			for (const k of keys) {
				const r = runs[k], step = r && stallStep(r, now, told.get(k) ?? { at: [] });
				if (step) told.set(k, step.memo);
				if (!r || !step?.nudge) continue;
				log(`stall: ${k} rested (${r.todos ? `${r.todos} task(s) left` : "promised work not done"}) since ${r.since}; told to go on`);
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
	const asks = allNotices()
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
		turnFailed: lastTurnFailed(mainItems),
		resuming: orch.resuming,
		lastAnswer: orch.lastText, acted: lastTurnActed(mainItems),
		compacting: compactingNow(orch.ctx),
		queued: mainOrch.heldCount(),
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
			capacity: lane.waiting, resumeDue: lane.resumeDue,
			lastTurnEnd: lastTurnEnd(items),
			turnFailed: lastTurnFailed(items),
			resuming: lane.resuming,
			lastAnswer: lane.lastText, acted: lastTurnActed(items),
			compacting: compactingNow(lane.ctx),
			watching: openMonitor(lane.sessionFile),
			todos: openTodos(laneTodo(lane)),
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
			turnFailed: lastTurnFailed(items),
			resuming: c.o.orch.resuming,
			lastAnswer: c.o.orch.lastText, acted: lastTurnActed(items),
			compacting: compactingNow(c.o.orch.ctx),
			queued: c.o.heldCount(),
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
// The app conversations whose own session runs (/api/state `convs`, 홈 지금 진행 중 in 08-home.js): the mail's subject as its title
// (the page may not have loaded the mail list) and the background workers that session runs now, listed under its row.
function stateConvs(): { target: string; name?: string; work: ReturnType<typeof bgWork.list> }[] {
	return convs.conversations().filter(c => convs.live(c)).map(c => {
		const mail = c.primary.startsWith("mail:") ? mailByKey(c.primary.slice(5)) : undefined;
		return { target: c.primary, ...(mail?.subject ? { name: mail.subject } : {}), work: c.bg.list().filter(w => w.status === "running").map(w => ({ ...w, target: c.primary })) };
	});
}
export const stateWaitlist = () => buildWaitlist({
	deferred: limitWaits(join(DATA_DIR, "state.json")),
	lanes: laneSummary(),
	work: [...bgWork.queuedWork(), ...convs.conversations().filter(c => convs.live(c)).flatMap(c => c.bg.queuedWork().map(w => ({ ...w, target: c.primary })))],
});
// Fleet (hub/fleet.ts): this computer's load for its peers, and GET /api/fleet for the computer sheet.
const fleet = createFleet({ name: () => resolveName(cfg.web?.machine_name, machineHost()), sent: () => activeFleetLaunch()?.sent() ?? [], local: () => loadCore({ sessions: maxLiveView(), capacity: laneCapacity(), waitlist: stateWaitlist().length, orchestrator: orch.status, lanes: laneSummary(), convs: convs.conversations().filter(c => convs.live(c)).map(c => ({ status: c.o.orch.status })) }) });
activateFleet(fleet);
const machine = () => resolveName(cfg.web?.machine_name, machineHost());
// A session started on another paired computer (hub/fleet-launch.ts, docs/fleet.md).
const fleetLaunch = createFleetLaunch({ name: machine, autoOn: () => cfg.fleet?.auto_place === true, fleet: () => fleet.fleet(), folders: () => ownFolders({ lanes: () => withHomes(laneSummary(), discord.channels), channels: () => discord.channels, machine }), deliver: deliverToSession });
activateFleetLaunch(fleetLaunch);
const mainWork = (t: string | undefined) => t === "web" || t === "terminal" || !t;
const lastTurnStart = (items: ReturnType<typeof activityItems>): string | undefined => {
	for (let i = items.length - 1; i >= 0; i--) if (items[i]!.type === "turn_start") return items[i]!.ts;
	return undefined;
};
const runningChildren = (source: string) =>
	(subagentLists()[source] || []).filter(s => s.status === "running").map(s => ({ name: s.id, description: s.description || s.agent }));

type RestartHooks = { /** This node's tailnet name (tests); default `tailscale status`. */ tailnetName?: () => Promise<string | undefined>; busyNow: () => string[]; restartGateway: () => string; restartGatewayNow: () => string; mailDeps?: () => MailDeps; /** One mail reconcile round of at most `limit` mails (hub/mail-reconcile.ts); absent = not wired in this process. */ mailReconcile?: (limit: number) => Promise<{ checked: number; replied: number; notChecked: number; skipped: number }> };
// A card's answer to where its question came from (chat, session, project chat, mail or login request): the bot's turn.
export async function deliverAnswer(a: Parameters<DecisionSend>[0] & { login: string; via?: ReturnType<typeof viaOf> }): Promise<void> {
	if (a.to.startsWith("auth:")) {
		const path = `/api/auth/${a.to.slice(5)}`;
		const res = await authRoute(new Request(`http://local${path}`, { method: "POST", body: JSON.stringify({ action: a.action }) }), new URL(`http://local${path}`));
		if (!res?.ok) throw new Error("로그인 요청을 처리하지 못했어요");
		return;
	}
	const lane = a.to.startsWith("lane:") ? a.to.slice(5) : undefined;
	const project = a.to.startsWith("ch:") ? projectTarget(a.to, discord.channels.work) : undefined;
	const conv = a.to === "alert" || a.to === "worklog" || a.to === "quick" ? a.to : undefined;
	const mail = a.to.startsWith("mail:") ? mailByKey(a.to.slice(5)) : undefined;
	if (a.to.startsWith("mail:") && !mail) throw new Error("이 메일 대화를 찾을 수 없어요");
	// The owner's answer to a stronger-model card (hub/escalate.ts) is acted on here, then reaches the asking session like any answer.
	if (a.picks?.length === 1) await escalations()?.answer({ to: a.to, label: a.picks[0]!.label }).catch(e => log(`stronger-model answer failed: ${(e as Error).message}`));
	await sendWeb({ lane, project, mail, conv, channel: "web", text: a.text, mode: "default", login: a.login, replyTo: a.replyTo, decision: a.notice, picks: a.picks, files: a.files, via: a.via });
}

export { applyMailStates, mailOriginal, mailSyncDeps } from "./routes-mail.ts";

// A hand-written card's answer (kind `card`) is one owner message to the bot, as its own numbered answer would be.
setReplyBot((to, text) => deliverAnswer({ to, text, picks: [], notice: "", login: "local" }));

export function makeRoute({ tailnetName = ownTailnetName, busyNow, restartGateway, restartGatewayNow, mailDeps, mailReconcile }: RestartHooks): (req: Request, srv?: Server<unknown>) => Promise<Response> {
	const setupGate = createSetupGate({ dir: DATA_DIR, localHeaders: () => localLogin.sessionHeaders(), restart: () => void restartGatewayNow(), providers: routeSettings, log });
	// Before any onboarding route can run: the real browser/exec, a gateway restart only after a flow changed config, and the live web-access switch.
	setOnboardDeps(
		defaultOnboardDeps(DATA_DIR, {
			restart: async () => void restartGateway(),
			applyWebAccess: async input => {
				await webAccess.change(input);
			},
		}),
	);
	const handle = async (req: Request, srv?: Server<unknown>): Promise<Response> => {
		const url = new URL(req.url);
		const tailnet = await entryHost(req, srv?.port ?? PORT, tailnetName, webAccess.hostname()); if (tailnet instanceof Response) return tailnet; // entry check (hub/entry-check.ts); true: this came through tailscale serve, so a tailnet login counts
		// The install files (manifest, service worker, icons) are public and secret-free, like any app store listing: a browser
		// or OS fetch that carries no tailnet identity (icon or manifest fetch, SW update check) must still get them, or the
		// phone falls back to a plain shortcut. Everything else stays behind the identity check.
		const appFile = req.method === "GET" || req.method === "HEAD" ? APP_FILES[url.pathname] : undefined;
		// The install name is the owner's assistant name, not the project's; `gateway` is what another computer recognises a gateway by (hub/peers.ts).
		if (appFile && url.pathname === "/manifest.webmanifest") {
			const m = JSON.parse(committedText(appFile[0]) ?? readFileSync(join(import.meta.dir, "..", "web", appFile[0]), "utf8"));
			const body = JSON.stringify({ ...m, name: NAME, short_name: NAME, ...manifestI18n(NAME), gateway: "dotz" });
			return new Response(req.method === "HEAD" ? null : body, { headers: { "Content-Type": appFile[1], "Cache-Control": "no-cache" } });
		}
		if (appFile) return new Response(req.method === "HEAD" ? null : url.pathname === "/sw.js" ? swScript(committedText(appFile[0]) ?? readFileSync(join(import.meta.dir, "..", "web", appFile[0]), "utf8")) : committedText(appFile[0]) ?? Bun.file(join(import.meta.dir, "..", "web", appFile[0])), { headers: { "Content-Type": appFile[1], "Cache-Control": url.pathname === "/sw.js" || url.pathname.endsWith(".webmanifest") ? "no-cache" : "public, max-age=86400" } });
		// The other gateways read this computer's chosen name here (hub/peers.ts); it is a display name, no secret, so it is public like the manifest.
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/peer-info") return json({ name: resolveName(cfg.web?.machine_name, machineHost()) });
		// Pairing gates itself (only this node's own tailscale login gets a token, hub/peer-pair.ts) but still passes the write check first (another site's page, a non-JSON body).
		if (req.method === "POST" && url.pathname === PAIR_PATH) return tailnet ? (ambientWrite(req, url.pathname) ?? handlePair(req, { ownLogin })) : refuse("pairing outside the tailnet", req);
		// A request with the peer header gets only the peer paths (hub/peer-auth.ts); a good one skips the owner check, a bad one never reaches it.
		const devices = webAccess.devices();
		const cfAccess = webAccess.cfAccess();
		const pairing = await devices?.pairRoute(req, url, cfAccess ? r => cfAccess.verifyRequest(r) : undefined);
		if (pairing) return pairing;
		const peer = checkPeer(req, undefined, tailnet);
		if (peer === "denied") return new Response("forbidden", { status: 403 });
		// The login link and the login page's request are answered before the owner check (they are how a browser becomes the owner); a peer request never gets here (checkPeer above).
		if (peer === "none" && req.method === "GET" && url.pathname === "/local-login") return localLogin.page(req, url, webAccess.mode(), srv?.requestIP(req)?.address);
		if (peer === "none" && req.method === "POST" && url.pathname === "/local-login/request") return localLogin.request(req, url, webAccess.mode(), srv?.requestIP(req)?.address);
		if (peer === "none" && req.method === "GET" && url.pathname === "/local-login/status") return localLogin.status(req, url, webAccess.mode(), srv?.requestIP(req)?.address);
		if (peer === "none") { const r = await setupGate.route(req, url, srv?.requestIP(req)?.address); if (r) return r; }
		if (peer === "none" && !authorized(req, !!cfAccess && (await cfAccess.verifyRequest(req)), !!devices && (await devices.verifySession(req)), srv?.requestIP(req)?.address, tailnet)) return devices ? devices.denied(req, url) : webAccess.mode() === "local" ? localLogin.hint(req, srv?.requestIP(req)?.address) : new Response("forbidden", { status: 403 });
		if (peer === "none") { const r = ambientWrite(req, url.pathname); if (r) return r; } // a cookie or tailnet login writes only from its own page
		const deviceApi = peer === "none" ? await devices?.apiRoute(req, url) : undefined;
		if (deviceApi) return deviceApi;
		const accessApi = peer === "none" ? await webAccessRoute(req, url, webAccess) : undefined;
		if (accessApi) return accessApi;
		const loginLink = peer === "none" ? localLogin.loginLink(req, url, { port: PORT, tokenOk: tokenOk(req), local: localBrowser(req, srv?.requestIP(req)?.address) }) : undefined;
		if (loginLink) return loginLink;
		// 설정 → 웹 접속: Cloudflare starts the onboarding flow, 이 컴퓨터만 records the mode and is done at once. Neither answer carries a secret.
		if (peer === "none" && url.pathname === "/api/web-access/onboard") {
			if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
			const b = await body(req);
			if (b.mode === "local") {
				try {
					await webAccess.change({ mode: "local" });
				} catch (error) {
					if (error instanceof WebAccessError) return json({ error: error.message }, 400);
					throw error;
				}
				return json(onboardingService().markDone("web-access"));
			}
			if (b.mode !== "cloudflare") return json({ error: "mode must be cloudflare or local" }, 400);
			const hostname = typeof b.hostname === "string" ? b.hostname.trim() : "";
			if (hostname) saveWebAccessInput(DATA_DIR, { hostname });
			return json(onboardingService().start("web-access"));
		}
		const peerResponse = (await peers.route(req, url)) ?? (await fleet.route(req, url));
		if (peerResponse) return peerResponse;
		// 화면 공유 (hub/remote-desktop.ts): /desk/, /api/desk/*, the peer's Chrome opener; null = upgraded to a websocket.
		const deskResponse = await desk.route(req, url, srv, webAccess.mode());
		if (deskResponse !== undefined) return deskResponse as Response;
		// A computer reached only through a messenger (the adapter's relay): its chat JSON and the old chat page's redirect, behind the same gate (hub/relay-route.ts).
		const relayed = peer === "none" ? await relayRoute(req, url) : undefined;
		if (relayed) return relayed;
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
		const updateResponse = await updateRoute(req, url, { boot: BOOT_ID, busy: busyNow, restartIdle: restartGateway, restartNow: restartGatewayNow, now: updateNow() });
		if (updateResponse) return updateResponse;
		// Settings → 업데이트 → 실행 하네스 (hub/harness-update.ts): the harness binary itself, from the package registry.
		const harnessUpdateResponse = await harnessUpdateRoute(req, url, { busy: busyNow, restartIdle: restartGateway });
		if (harnessUpdateResponse) return harnessUpdateResponse;
		const customResponse = await customRoute(req, url, { lanes: () => withHomes(laneSummary(), discord.channels), channels: () => discord.channels, work: () => bgWork.list(), send: (target, text, login) => sendWeb({ ...(target === "main" ? {} : { lane: target.slice(5) }), channel: "web", text, mode: "default", login }), machine: () => resolveName(cfg.web?.machine_name, machineHost()), peerProjects });
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
			if (target !== "main" && target !== QUICK && !target.startsWith("lane:") && !isProjectTarget(target)) return json({ error: "target must be main, quick, lane:<name> or ch:<id>" }, 400);
			const lane = target.startsWith("lane:") ? lanes.get(target.slice(5)) : undefined;
			if (target.startsWith("lane:") && !lane) return json({ error: `no lane ${target.slice(5)}` }, 404);
			return json(lane ? laneTodo(lane) : readTodo(target === QUICK ? convs.get(QUICK)?.o.orch.sessionFile : orch.sessionFile));
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
		if (req.method === "POST" && url.pathname === "/api/chart") return chartRoute(req);
		if (url.pathname === "/api/peers" && (req.method === "GET" || req.method === "DELETE")) return req.method === "GET" ? json([...(await listPeers()), ...(await relayRows())]) : forgetRoute(url);
		// Send lease of another gateway (hub/send-lease.ts): claim, release or record a sent id before an app message goes out.
		if (req.method === "POST" && url.pathname === "/api/peer/lease") return json(handleLease((await body(req)) as LeaseReq, Date.now()));
		// Another gateway spent a 리셋권 (hub/limit-peer.ts): this one checks its own usage now and lifts only when that read agrees.
		if (req.method === "POST" && url.pathname === "/api/peer/limit-lift") return json(await peerLimitNotice());
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
				if (r.ok) workRows.stopped(id);
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
			return json({ name: NAME, address: ADDRESS, upload_max: UPLOAD_MAX_BYTES, discord: discord.status, channels: discord.channels, orchestrator: { ...orch, lastText: orch.lastText.slice(0, 600), key_fallback: keyedSelector(orch.activeModel) }, terminals: Object.fromEntries(terminals), lanes: withHomes(laneSummary(), discord.channels), runs: stateRuns(), capacity: laneCapacity(), schedules: listSchedules(), auth: pendingAuth(), events: recentEvents(Number(url.searchParams.get("limit") ?? 100)).map(shownEvent), notices_unread: unreadCount(), work: bgWork.list(), convs: stateConvs(), waitlist: stateWaitlist(), work_now: Date.now(), web_build: webBuild(), desk: desk.summary() });
		if (req.method === "GET" && url.pathname === "/api/notices") syncCardFiles();
		if (req.method === "GET" && url.pathname === "/api/notices") return json({ ...listNotices(Number(url.searchParams.get("limit") ?? 100), true), gone: dismissedAlertAts() });
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
		const appsResponse = await routeApps(req, url, unrepliedMailList);
		if (appsResponse) return appsResponse;
		const noticesResponse = await routeNotices(req, url);
		if (noticesResponse) return noticesResponse;
		// The phone's input diagnostic reports itself here (web/js/34-input-diag.js): known fields only, into a capped file under the data dir.
		if (req.method === "POST" && url.pathname === "/api/input-diag") return json({ ok: true, kept: addInputDiag(await body(req)) }, 201);
		// The one reply flow (hub/reply-route.ts) and a session CLI's failed-send report (hub/approval-wire.ts).
		if (url.pathname.startsWith("/api/reply/") || url.pathname === "/api/approvals/failed") {
			const login = peer === "none" && tokenOk(req) ? AGENT_AUTHOR : (req.headers.get("tailscale-user-login") ?? "local"); // an agent's own call is never the owner's word (hub/routes-send.ts)
			const res = (await replyRoute(req, url, { replies, login, agent: login === AGENT_AUTHOR, triageMin: 1, undoSec: cfg.web.send_undo_sec ?? 10, surface: peer === "none" ? "web" : "peer" })) ?? (await approvalRoute(req, url));
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
			// Reading a conversation reads its unread answer up to there (and a mail's new-mail notice), whether or not the position moved; every other
			// notice is read by the owner's tap, ✕ or read-all (/api/notices/read).
			if (r.ok) readConversationNotices(r.target, r.ts, "viewed");
			// A mail he opened here is read in its mailbox too, where that is one cheap call (hub/mail.ts mailOpened).
			if (r.ok && r.moved) mailOpened(r.target);
			return json(r, r.ok ? 200 : 400);
		}
		const mailResponse = await routeMail(req, url, { peer, mailDeps, mailReconcile });
		if (mailResponse) return mailResponse;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"), req.signal);
		if (req.method === "GET" && url.pathname === "/api/history") {
			const target = url.searchParams.get("target") ?? "main", locate = url.searchParams.get("locate"); if (locate) return json({ convs: locateMessage(locate) });
			if (target !== "main" && target !== "alert" && target !== "worklog" && target !== "quick" && !target.startsWith("lane:") && !isProjectTarget(target) && !isMailTarget(target) && !isSettingsTarget(target)) return json({ error: "target must be main, alert, worklog, quick, lane:<name>, ch:<id>, mail:<key> or settings:<app>" }, 400);
			const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 150) || 150, 500));
			const around = url.searchParams.get("around"), after = url.searchParams.get("after");
			// A quote's original outside what the page holds (web/js/39-reply.js rpJump), and the messages of the gap that leaves.
			if (around || after) {
				const page = historyPage(target, limit, around ? { around } : { after: after as string });
				return json({ target, ...page, events: workRows.stamp(page.events) });
			}
			const before = url.searchParams.get("before") ?? undefined, events: unknown[] = workRows.stamp(historyEvents(target, limit, before));
			// A sent mail has no conversation event of its own: its conversation opens on the mail itself (hub/mail.ts sentMailEvent).
			const sent = !before && isMailTarget(target) && !events.some(e => (e as { kind?: string }).kind === "mail") ? sentMailEvent(target.slice(5)) : undefined;
			return json({ target, events: sent ? [sent, ...events] : events });
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
			return listedFileRoute(req, url, fileRoots(), () => bgWork.list());
		}
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/canvas") {
			return canvasRoute(req, url, fileRoots(), sentFiles());
		}
		// A file of a conversation of this computer, opened from the other one: an upload the owner attached (the chip in the sent bubble),
		// or a result file the bot posted or wrote ([file] lines, paths), under the same rules as this computer's own /api/file.
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/peer/file") {
			const [f] = messageFiles([{ path: url.searchParams.get("path") ?? "" }]);
			if (!f) return listedFileRoute(req, url, fileRoots(), () => bgWork.list());
			const res = serveFile(f.path, req, url.searchParams.get("download") === "1");
			return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
		}
		if (url.pathname === "/api/target") {
			const fail = (error: unknown) => json({ error: (error as Error).message, ...(error instanceof ForceRequired ? { requires_force: true, context_tokens: error.contextTokens } : {}) }, error instanceof ControlError ? error.status : 400);
			try {
				if (req.method === "GET") return json(await targetView(url.searchParams.get("target") ?? "main"));
				if (req.method === "PUT") {
					const b = await body(req);
					return json(await changeTarget(String(b.target ?? "main"), { req, ownerMessage: b.owner_message, model: b.model ? String(b.model) : undefined, thinking: b.thinking ? String(b.thinking) : undefined, compact: b.compact === true, force: b.force === true, inherit: b.inherit === true, workerModel: b.worker_model ? String(b.worker_model) : undefined, byLane: b.by === "lane" }));
				}
			} catch (error) {
				return fail(error);
			}
		}
		const sendResponse = await routeSend(req, url, parts, { peer });
		if (sendResponse) return sendResponse;
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
	// A body that is not JSON is refused here, whichever route read it (hub/routes-util.ts body).
	const route = (req: Request, srv?: Server<unknown>): Promise<Response> => handle(req, srv).catch(error => { if (error instanceof BodyError) return json({ error: error.message }, 400); throw error; });
	const peers = createPeerMonitor({ launch: fleetLaunch, name: () => resolveName(cfg.web?.machine_name, machineHost()), bot: () => NAME, local: route, localHeaders: { "x-dotz-token": HUB_TOKEN }, orchestrator: () => ({ status: orch.status, pauseKind: orch.pauseKind }), runs: () => Object.fromEntries(Object.entries(stateRuns()).filter(([k]) => k.startsWith("mail:"))) });
	activatePeerMonitor(peers);
	return route;
}
