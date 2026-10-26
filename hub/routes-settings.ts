// HTTP routes of models, runtimes, accounts, providers, activity and commands (the middle part of the route chain). Split out of main.ts.
import { log } from "./config.ts";
import { compactTarget, ControlError, contextView, ForceRequired, modelsView, providersView, runCommand, setFallback, setModel } from "./control.ts";
import { subagentDetail, subagentLists, transcriptPage } from "./activity.ts";
import { activityItems } from "./events.ts";
import { lanes } from "./lanes.ts";
import { checkNow as checkAccountNow } from "./account-rules.ts";
import { accountsRoute } from "./accounts-api.ts";
import { abort as abortOrchestrator, orch, restart as restartOrchestrator } from "./orchestrator.ts";
import { cancelLogin, completeLogin, loginStatus, logoutProvider, quota, saveProviderKey, startLogin } from "./providers.ts";
import { featureCatalog } from "./features.ts";
import { harnessGraph, readHarnessFile } from "./harness.ts";
import { lastReport, RUNTIME_IDS, runtimesView, startVerify, UseRefused, useRuntime, verifyState, type UseRole } from "./runtime/verify.ts";
import { json, body, terminals } from "./routes-util.ts";
import { budgetSettings, deleteAdminKey, monthlyLimitOf, saveAdminKey, saveMonthlyLimit } from "./api-budget.ts";
import { postSettings, savePostSettings } from "./discord-post.ts";

export async function routeSettings(req: Request, url: URL, parts: string[]): Promise<Response | undefined> {
	const fail = (error: unknown) =>
		error instanceof ForceRequired
			? json({ error: error.message, requires_force: true, context_tokens: error.contextTokens }, error.status)
			: json({ error: (error as Error).message }, error instanceof ControlError ? error.status : 400);
	if (req.method === "GET" && parts[0] === "api" && parts[1] === "harness") {
		try {
			if (parts.length === 2) return json(await harnessGraph({ terminals: terminals.size }));
			if (parts[2] === "file" && parts.length > 3) return json(readHarnessFile(decodeURIComponent(parts.slice(3).join("/"))));
		} catch (error) {
			return fail(error);
		}
	}
	if (req.method === "GET" && parts[0] === "api" && parts[1] === "features" && parts.length === 2) {
		try {
			return json(await featureCatalog());
		} catch (error) {
			return fail(error);
		}
	}
	if (req.method === "GET" && url.pathname === "/api/models") return json(await modelsView());
	if (req.method === "PUT" && url.pathname === "/api/models") {
		const b = await body(req);
		// One body for the whole target: model and/or thinking, and/or its ordered fallback chain (`fallback`).
		try {
			const target = String(b.target ?? "");
			const changed = b.model || b.thinking ? await setModel(target, b.model ? String(b.model) : undefined, b.thinking ? String(b.thinking) : undefined, b.force === true) : undefined;
			const fb = Array.isArray(b.fallback) ? await setFallback(target, b.fallback) : undefined;
			if (!changed && !fb) return fail(new ControlError("model, thinking or fallback required"));
			return json({ ...(changed ?? { ok: true, target, applied: fb!.applied, note: fb!.note }), ...(fb ? { fallback: fb.chain } : {}) });
		} catch (error) {
			return fail(error);
		}
	}
	// Older clients: the chain alone (same as PUT /api/models {target, fallback}).
	if (req.method === "PUT" && url.pathname === "/api/fallbacks") {
		const b = await body(req);
		try {
			return json(await setFallback(String(b.target ?? ""), Array.isArray(b.chain) ? b.chain : []));
		} catch (error) {
			return fail(error);
		}
	}
	if (parts[0] === "api" && parts[1] === "runtimes") {
		if (req.method === "GET" && parts.length === 2) return json(await runtimesView(url.searchParams.get("refresh") === "1"));
		const id = parts[2];
		if (!RUNTIME_IDS.includes(id as never)) return json({ error: `알 수 없는 실행 하네스예요: ${id}` }, 404);
		if (req.method === "GET" && parts.length === 3) return json({ id, report: lastReport(id) ?? null, state: verifyState(id) ?? null });
		if (req.method === "POST" && parts[3] === "verify" && parts.length === 4) {
			const b = await body(req);
			// Each check starts ~14 paid OmO sessions: only on an explicit {real: true} (the web check button sends it).
			if (b.real !== true) return json({ error: "a runtime check starts real paid sessions: send {\"real\": true} to run it", report: lastReport(id) ?? null }, 400);
			return json({ ok: true, state: startVerify(id as never, { real: true, ...(b.model ? { model: String(b.model) } : {}) }) }, 202);
		}
		if (req.method === "POST" && parts[3] === "use" && parts.length === 4) {
			const b = await body(req);
			const roles = (Array.isArray(b.roles) ? b.roles : ["orchestrator", "lanes"]).map(String) as UseRole[];
			try {
				const done = await useRuntime(id, roles);
				log(`runtime ${id} selected for ${done.join(", ")}`);
				return json({ ok: true, runtime: id, roles: done, applies: "어시스턴트와 세션을 다시 시작하면 적용돼요. 실행 중인 프로세스는 그대로예요." });
			} catch (error) {
				if (error instanceof UseRefused) return json({ error: error.message, runtime: id }, 409);
				throw error;
			}
		}
	}
	if (req.method === "GET" && url.pathname === "/api/context") return json(contextView());
	if (req.method === "POST" && url.pathname === "/api/compact") {
		try {
			const r = compactTarget(String((await body(req)).target ?? ""));
			return json({ ok: true, target: r.target, state: r.compaction.state, message: r.message });
		} catch (error) {
			return fail(error);
		}
	}
	// The dotz extension asks at the start of every turn which account to pin in its own process (extension/index.ts followAccount).
	const accountsResponse = await accountsRoute(req, url);
	if (accountsResponse) return accountsResponse;
	if (req.method === "POST" && url.pathname === "/api/accounts/check") {
		try {
			return json({ ok: true, ...(await checkAccountNow()) });
		} catch (error) {
			return fail(error);
		}
	}
	if (req.method === "GET" && url.pathname === "/api/subagents") return json({ sources: subagentLists() });
	if (req.method === "GET" && parts[0] === "api" && parts[1] === "subagents" && parts.length === 3) {
		const detail = await subagentDetail(url.searchParams.get("source") ?? "orchestrator", decodeURIComponent(parts[2]));
		return detail ? json(detail) : json({ error: "no such subagent (finished ones are kept 10 minutes)" }, 404);
	}
	if (req.method === "GET" && url.pathname === "/api/activity") {
		const source = url.searchParams.get("source") ?? "orchestrator";
		if (source !== "orchestrator" && !source.startsWith("lane:")) return json({ error: "source must be orchestrator or lane:<name>" }, 400);
		const limit = Number(url.searchParams.get("limit") ?? 300) || 300;
		const before = url.searchParams.get("before") || undefined;
		const lane = source.startsWith("lane:") ? lanes.get(source.slice(5)) : undefined;
		const file = source === "orchestrator" ? orch.sessionFile : lane?.sessionFile;
		// Older pages ("load more" in the terminal view) come from the saved session transcript.
		if (before) return json({ source, history: true, ...(await transcriptPage(file, limit, before)) });
		// The live buffer is memory only (300 items, empty after a gateway restart): the transcript fills in everything
		// older than it, for the orchestrator and lanes alike, so the view survives restarts and can page back with `before`.
		const live = activityItems(source, limit);
		if (!file) return json({ source, items: live, more: false });
		if (live.length >= limit) return json({ source, items: live, more: true });
		const page = await transcriptPage(file, limit - live.length, live[0]?.ts);
		return json({ source, history: page.items.length > 0, items: [...page.items, ...live], more: page.more });
	}
	if (req.method === "GET" && url.pathname === "/api/quota") return json(await quota());
	// The monthly API limit and the admin key behind the usage screen's spend figure (hub/api-budget.ts): the key is never returned, only its mask.
	if (url.pathname === "/api/api-budget" && (req.method === "GET" || req.method === "PUT")) {
		try {
			if (req.method === "PUT") {
				const b = await body(req);
				// All or nothing: the limit is checked first and written only after the key is accepted, so an error never leaves half a save.
				if ("monthly_usd" in b) monthlyLimitOf(b.monthly_usd);
				if (b.clear_admin_key === true) deleteAdminKey();
				else if (typeof b.admin_key === "string" && b.admin_key.trim()) await saveAdminKey(b.admin_key);
				if ("monthly_usd" in b) saveMonthlyLimit(b.monthly_usd);
			}
			return json(budgetSettings());
		} catch (error) {
			return fail(error);
		}
	}
	// Which conversations also go to Discord (hub/discord-post.ts); the web always gets everything.
	if (url.pathname === "/api/discord/post" && (req.method === "GET" || req.method === "PUT")) {
		if (req.method === "GET") return json(postSettings());
		try {
			return json(savePostSettings((await body(req)) as Record<string, unknown>));
		} catch (error) {
			return json({ error: String((error as Error).message ?? error) }, 400);
		}
	}
	if (req.method === "POST" && url.pathname === "/api/command") {
		const text = String((await body(req)).text ?? "").trim();
		if (!text) return json({ error: "text required" }, 400);
		try {
			const card = await runCommand(/^[/!]/.test(text) ? text : `/${text}`);
			return card.tone === "err" ? json({ error: card.note ?? card.title, output: card.text, card }, 400) : json({ ok: true, output: card.text, card });
		} catch (error) {
			return fail(error);
		}
	}
	if (parts[0] === "api" && parts[1] === "providers") {
		try {
			if (req.method === "GET" && parts.length === 2) return json(await providersView());
			if (req.method === "POST" && parts.length === 2) {
				const b = await body(req);
				const provider = String(b.provider ?? "").trim();
				return json({ ok: true, provider, masked: await saveProviderKey(provider, String(b.key ?? "")) });
			}
			if (req.method === "DELETE" && parts.length === 3) {
				await logoutProvider(decodeURIComponent(parts[2]));
				return json({ ok: true });
			}
			if (parts.length >= 4 && parts[3] === "login") {
				const provider = decodeURIComponent(parts[2]);
				if (req.method === "POST" && parts.length === 4) return json({ ok: true, ...(await startLogin(provider)) });
				if (req.method === "POST" && parts.length === 5 && parts[4] === "complete") {
					const b = await body(req);
					return json({ ok: true, ...(await completeLogin(provider, String(b.login_id ?? ""), String(b.code ?? ""))) });
				}
				if (req.method === "GET" && parts.length === 4) return json(loginStatus(provider, url.searchParams.get("login_id") ?? ""));
				if (req.method === "DELETE" && parts.length === 4) {
					await cancelLogin(provider);
					return json({ ok: true });
				}
			}
			if (req.method === "POST" && parts.length === 4 && parts[3] === "logout") {
				await logoutProvider(decodeURIComponent(parts[2]));
				return json({ ok: true });
			}
		} catch (error) {
			return fail(error);
		}
	}
	if (req.method === "POST" && parts[0] === "api" && parts[1] === "orchestrator" && (parts[2] === "restart" || parts[2] === "abort")) {
		try {
			if (parts[2] === "restart") restartOrchestrator();
			else abortOrchestrator();
			return json({ ok: true });
		} catch (error) {
			return fail(error);
		}
	}
}
