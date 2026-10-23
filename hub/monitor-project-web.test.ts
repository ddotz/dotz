import { afterAll, describe, expect, test } from "bun:test";
import { viewOf } from "./app-settings.ts";
import { sseResponse } from "./events.ts";
import { WATCH_FIELDS } from "./watch-settings.ts";
import { appAsset, indexPage } from "./webapp.ts";

// A monitor a project created (its channel is ch:<id>) is not tied to the project: its gear opens its own settings:w:<watch> conversation, the
// chips and messages go there as `settings: "w:<watch>"` with no `project`, the change card applies to the watch, and a peer's is the same through
// the proxy; 지금 확인 runs a watch now; a home progress row opens the settings conversation; the model's English thinking shows as a Korean label.
// Headless; the peer is a fixture.
const MINI = "http://mini.test";
const CH = "1562723146669490227", PCH = "1562723146669490228";
const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 3, min)).toISOString();
const failing = (name: string, label: string, channel?: string) => ({ name: label, watch: name, kind: "watch", last_run: at(32), last_result: "fail", next_run: at(62), every: "30분마다", fails: 3, last_ok: at(2), last_output: "로그인이 풀렸어요", keeper: true, ...(channel ? { channel: `ch:${channel}` } : {}) });
const fields = () => WATCH_FIELDS.map(f => viewOf(f, f.key === "enabled" ? true : f.key === "every_minutes" ? 30 : f.key === "to" ? "alert" : "라벨"));
const CARD = "원인은 확인 간격이에요.\n\n```dotz-settings\n{\"app\":\"w:login-local\",\"changes\":{\"every_minutes\":15}}\n```";

const sent: Record<string, unknown>[] = [];
const acts: { action: string; args: Record<string, unknown> }[] = [];
const runs: string[] = [];
const patches: { name: string; values: unknown }[] = [];
const json = (v: unknown, status = 200) => Response.json(v, { status });
const history: Record<string, Record<string, unknown>[]> = {
	"settings:w:login-local": [{ ts: at(40), kind: "message", source: "web", channel: "settings:w:login-local", author: "local", text: "지난번 질문" }, { ts: at(41), kind: "out", source: "orchestrator", target: "settings:w:login-local", text: CARD }],
	"settings:w:login-cartier-com": [{ ts: at(40), kind: "out", source: "orchestrator", target: "settings:w:login-cartier-com", text: "맥미니 감시 대화에서 보낸 답이에요" }],
};
const peers = [{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [failing("login-cartier-com", "까르띠에 로그인 유지", PCH)], notices: [], integrations: [], conversations: [] } }];

async function proxy(req: Request, url: URL): Promise<Response> {
	const p = url.searchParams.get("p") ?? "";
	if (req.method === "POST") {
		acts.push((await req.json()) as (typeof acts)[number]);
		return json({ ok: true });
	}
	if (p === "/api/watches/login-cartier-com/settings") return json({ key: "login-cartier-com", fields: fields() });
	if (p.startsWith("/api/history")) {
		const target = new URL(p, "http://x").searchParams.get("target") ?? "";
		return json({ target, events: history[target] ?? [] });
	}
	return json({});
}
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: { [CH]: "까르띠에-재고-구매" } }, discord: {}, notices_unread: 0, work: [{ id: "w1", description: "로그인 원인 조사", status: "running", started_at: Date.now() - 60_000, target: "settings:w:login-local" }] });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, ...peers.map(x => ({ name: x.name, url: x.url, self: false, online: x.online }))]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitors") return json({ items: [failing("login-local", "로컬 로그인 유지", CH)] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/integrations") return json({ items: [] });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/monitoring/peers") return json(peers);
		if (p === "/api/peer/proxy") return proxy(req, url);
		if (p.startsWith("/api/history")) {
			const target = url.searchParams.get("target") ?? "";
			return json({ target, events: history[target] ?? [] });
		}
		const run = /^\/api\/watches\/([a-z-]+)\/run$/.exec(p);
		if (run && req.method === "POST") { runs.push(run[1]!); return json({ ok: true }); }
		const st = /^\/api\/watches\/([a-z-]+)\/settings$/.exec(p);
		if (st && req.method === "PATCH") { patches.push({ name: st[1]!, values: ((await req.json()) as { values: unknown }).values }); return json({ key: st[1], fields: fields() }); }
		if (st) return json({ key: st[1], fields: fields() });
		if (p === "/api/message") { sent.push((await req.json()) as Record<string, unknown>); return json({ ok: true }); }
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const until = async (ok: () => boolean) => { const d = Date.now() + 5000; while (!ok() && Date.now() < d) await Bun.sleep(25); };
const LOCAL_KEY = "m:로컬 로그인 유지";
const PEER_KEY = `p:${MINI}|m:까르띠에 로그인 유지`;
const boot = async (key: string) => {
	const v = new Bun.WebView({ width: 1280, height: 800 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && PQ.list.length && monItems().some(i => i.key === ${JSON.stringify(key)})`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	return v;
};

describe("a monitor of a project", () => {
	test("the settings button opens the monitor's own settings conversation inside 모니터링 and a chip sends the message to it as the monitor's settings target, without the project", async () => {
		sent.length = 0;
		const v = await boot(LOCAL_KEY);
		await waitFor(v, `document.querySelector("#mon-head .as-hd") && document.querySelector("#mon-tl [data-chip]")`);
		await run(v, `document.querySelector("#mon-head .as-hd").click()`);
		await waitFor(v, `target === "settings:w:login-local" && monCtx === target && document.querySelector("#tl").textContent.includes("지난번 질문")`);
		expect(decodeURIComponent(await q(v, `return location.hash`))).toBe("#monitoring/c:settings:w:login-local");
		await waitFor(v, `document.querySelector("#mon-chips [data-chip]")`);
		await run(v, `document.querySelector('#mon-chips [data-chip="원인 찾아 줘"]').click()`);
		await until(() => sent.length > 0);
		expect(sent[0]).toMatchObject({ text: "원인 찾아 줘", settings: "w:login-local" });
		expect(sent[0]).not.toHaveProperty("project");
		expect(await q(v, `return ta.value`)).toBe("");
	});

	test("a chip of the detail card goes to the monitor's settings conversation, and a plain message carries the monitor's note only while that conversation is open", async () => {
		sent.length = 0;
		const v = await boot(LOCAL_KEY);
		await waitFor(v, `document.querySelector("#mon-tl [data-chip]")`);
		await run(v, `document.querySelector('#mon-tl [data-chip="다시 로그인해 줘"]').click()`);
		await until(() => sent.length > 0);
		expect(sent[0]).toMatchObject({ text: "다시 로그인해 줘", settings: "w:login-local" });
		expect(sent[0]).not.toHaveProperty("project");
		await run(v, `setTarget("main"); go("chat"); ta.value = "다른 일"; sendChat()`);
		await until(() => sent.length > 1);
		expect(sent[1]).toMatchObject({ text: "다른 일" });
		expect(sent[1]).not.toHaveProperty("settings");
		expect(sent[1]).not.toHaveProperty("project");
	});

	test("the change card inside the settings conversation applies to that watch", async () => {
		patches.length = 0;
		const v = await boot(LOCAL_KEY);
		await waitFor(v, `document.querySelector("#mon-head .as-hd")`);
		await run(v, `document.querySelector("#mon-head .as-hd").click()`);
		await waitFor(v, `target === "settings:w:login-local" && document.querySelector('#tl .as-card [data-as="apply"]')`);
		await run(v, `document.querySelector('#tl .as-card [data-as="apply"]').click()`);
		await until(() => patches.length > 0);
		expect(patches[0]).toEqual({ name: "login-local", values: { every_minutes: 15 } });
	});

	test("지금 확인 runs the watch on this gateway", async () => {
		runs.length = 0;
		const v = await boot(LOCAL_KEY);
		await waitFor(v, `document.querySelector("#mon-tl [data-run]")`);
		await run(v, `document.querySelector("#mon-tl [data-run]").click()`);
		await until(() => runs.length > 0);
		expect(runs).toEqual(["login-local"]);
	});
});

describe("a peer's monitor of a project", () => {
	test("its conversation is the monitor's own settings conversation on that computer: read through the proxy, the message forwarded to it, 지금 확인 forwarded as the watch run", async () => {
		sent.length = 0; acts.length = 0;
		const v = await boot(PEER_KEY);
		await waitFor(v, `document.querySelector("#mon-head .as-hd") && document.querySelector("#mon-tl [data-chip]")`);
		await run(v, `document.querySelector("#mon-head .as-hd").click()`);
		await waitFor(v, `target === "settings:w:login-cartier-com" && monCtx === target && document.querySelector("#tl").textContent.includes("맥미니 감시 대화에서 보낸 답이에요")`);
		await waitFor(v, `document.querySelector("#mon-chips [data-chip]")`);
		await run(v, `document.querySelector('#mon-chips [data-chip="일시정지"]').click()`);
		await until(() => acts.some(a => a.action === "message"));
		expect(acts.find(a => a.action === "message")).toMatchObject({ args: { target: "settings:w:login-cartier-com", text: "일시정지" } });
		expect(acts.find(a => a.action === "message")!.args).not.toHaveProperty("project");
		expect(acts.find(a => a.action === "message")!.args).not.toHaveProperty("settings");
		expect(sent).toEqual([]);
		await run(v, `go("monitoring", ${JSON.stringify(PEER_KEY)})`);
		await waitFor(v, `document.querySelector("#mon-tl [data-run]")`);
		await run(v, `document.querySelector("#mon-tl [data-run]").click()`);
		await until(() => acts.some(a => a.action === "watch"));
		expect(acts.find(a => a.action === "watch")).toEqual({ action: "watch", args: { op: "run", name: "login-cartier-com" } });
		expect(runs).not.toContain("login-cartier-com");
	});
});

describe("settings conversations on the home and in the log", () => {
	test("a progress row of work for a settings conversation opens that conversation even when its message is not known", async () => {
		const v = new Bun.WebView({ width: 1280, height: 800 });
		views.push(v);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await waitFor(v, `S && S.work && S.work.length && NM.loaded`);
		await run(v, `go("home")`);
		await waitFor(v, `[...document.querySelectorAll("#home-now .hr")].some(r => r.textContent.includes("로그인 원인 조사"))`);
		await run(v, `[...document.querySelectorAll("#home-now .hr")].find(r => r.textContent.includes("로그인 원인 조사")).click()`);
		await waitFor(v, `current === "chat" && target === "settings:w:login-local" && monCtx === target`);
	});

	test("the thinking line shows Korean text as it is and English text as a Korean label", async () => {
		const v = new Bun.WebView({ width: 1280, height: 800 });
		views.push(v);
		await v.navigate(`http://127.0.0.1:${server.port}/`);
		await waitFor(v, `S && NM.loaded`);
		const sum = (text: string) => q<string>(v, `return actNode({ type: "thinking", ts: "2026-10-23T03:00:00Z", text: ${JSON.stringify(text)} }, { calls: new Map() }).querySelector("summary").textContent.replace(/오[전후] \\d+:\\d+:\\d+$/, "")`);
		expect(await sum("I should check why the login keeper failed, then retry.")).toBe("생각· 생각을 정리하는 중");
		expect(await sum("로그인 화면이 바뀌었는지 먼저 볼게요.")).toBe("생각· 로그인 화면이 바뀌었는지 먼저 볼게요.");
		expect(await q<string>(v, `return thinkLine("Let me look at the DOM", 120)`)).toBe("생각을 정리하는 중");
	});
});
