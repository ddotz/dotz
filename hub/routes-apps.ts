// HTTP routes of the apps and integrations (list, switches, features, settings). Split out of routes.ts, called there at the same place of the chain.
import { cfg, DATA_DIR } from "./config.ts";
import { convs } from "./convsessions.ts";
import { unreadOf } from "./conversations.ts";
import { appEntries, INTEGRATIONS, integrationAvailable, integrationContext, integrationItems, withConnection, withStoreDrafts } from "./integrations.ts";
import { createApp, deleteApp, removalPlan, removeApp } from "./app-off.ts";
import { readAppTemplates } from "./app-templates.ts";
import { allWatches, approveWatch, removeWatch, runWatch } from "./watch.ts";
import { featuresOf, ownedWatches, retryInternal, setFeature } from "./app-features.ts";
import { fieldsOf, readSettings, SettingsError, writeSettings } from "./app-settings.ts";
import { refreshReplyModelChoices } from "./reply-model-choices.ts";
import { mailSuggests, mailTarget, mailTargets, type unrepliedMails } from "./mail.ts";
import { withBoxes } from "./routes-mailbox.ts";
import { allNotices } from "./notices.ts";
import { json, body } from "./routes-util.ts";
import { commentFlags, commentNeeds } from "./comments/gateway.ts";
import { appHealth, loadUserApps, PROXY_ROOT, removeUserApp, setUserAppOff, userApp } from "./user-apps.ts";
import { kakaoPendingCount, kakaoUnreplied } from "./kakao/gateway.ts";

export async function routeApps(req: Request, url: URL, unrepliedMailList: () => ReturnType<typeof unrepliedMails>): Promise<Response | undefined> {
	// A draft a send-approval notice already shows (its `> 참조:` ref) is that notice's card; the store's own list leaves it out, so nothing counts twice.
	const noticeDraftRefs = (): Set<string> => new Set(allNotices().flatMap(n => (n.decision?.state === "open" && !n.ignored && typeof n.decision.draft?.ref === "string" ? [n.decision.draft.ref] : [])));
	// The KakaoTalk reply drafts waiting in watched rooms count as the kakao app's drafts beside the comment apps' (hub/integrations.ts needs.drafts).
	const draftNeeds = () => withStoreDrafts(commentNeeds(), "kakao", kakaoPendingCount(noticeDraftRefs()));
	const integrationView = () => {
		const convUnread = Object.fromEntries(mailTargets().map(t => [t, unreadOf(t)]));
		const ctx = integrationContext(DATA_DIR, (cfg as { zele?: { enabled?: boolean } }).zele?.enabled !== false && Bun.which("zele") ? ["zele", ...commentFlags()] : commentFlags());
		const own = ownedWatches(DATA_DIR, allWatches());
		const items = integrationItems({ ...ctx, own }, allNotices(), convUnread, 100, undefined, mailSuggests(), Date.now(), draftNeeds(), { targets: unrepliedMailList().map(m => mailTarget(m.key)), apps: { kakao: kakaoUnreplied() } }).map(i => withBoxes(withConnection({ ...i, own: own.get(i.key) ?? [] }, allWatches()), DATA_DIR));
		return { items, available: integrationAvailable(items, ctx) };
	};
	if (req.method === "GET" && url.pathname === "/api/integrations") return json(integrationView());
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
	// The 새로 추가하기 prompts (hub/app-templates.ts): shipped ones, replaced or extended by custom/app-templates.json; ?key= also finds an unlisted one.
	if (req.method === "GET" && url.pathname === "/api/app-templates") return json({ items: readAppTemplates(DATA_DIR, undefined, url.searchParams.get("key") || undefined) });
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
			return json(featuresOf(DATA_DIR, app!, allWatches(), allNotices()));
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
			const fields = req.method === "GET" ? readSettings(DATA_DIR, app) : writeSettings(DATA_DIR, app, (await body(req)).values);
			// The mail app's 이 메일에서 쓸 모델 changed: the mail conversations with no pick of their own move to it at their next turn (hub/convsessions.ts).
			if (req.method === "PATCH" && app.split("-")[0] === "mail") convs.followKind("mail");
			return json({ key: app, fields });
		} catch (error) {
			return json({ error: (error as Error).message }, error instanceof SettingsError ? error.status : 400);
		}
	}
	return undefined;
}
