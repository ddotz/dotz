// Marketing screenshots of the real web app (web/) against invented demo data, for site/img.
// No personal data, no real machine names, accounts or addresses: every string below is synthetic promo copy.
//   bun hub/site-shots.ts
// Writes site/img/web-desktop.png (light, 1440x900), site/img/web-dark.png (1440x900), site/img/web-phone.png (390x844 @2x) and
// site/img/og.png (1200x630). The page is the shipped index.html + app.js + app.css served by hub/webapp.ts; only /api/* is invented.
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const OUT = join(import.meta.dir, "..", "site", "img");
mkdirSync(OUT, { recursive: true });

type View = InstanceType<typeof Bun.WebView>;
const json = (v: unknown) => Response.json(v);
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

/* ---------- invented demo content ---------- */
const MAIN = [
	{ ts: ago(26), kind: "message", source: "web", channel: "web", target: "main", text: "이번 주 배포 전에 남은 일 정리해 줘" },
	{ ts: ago(25), kind: "out", source: "orchestrator", target: "main", text: "두 가지예요.\n\n- 릴리스 노트 초안 다듬기\n- 배포 공지 초안" },
	{ ts: ago(14), kind: "message", source: "web", channel: "web", target: "main", text: "공지 초안도 써 줘." },
	{ ts: ago(13), kind: "out", source: "gateway", target: "main", system: true, worker: "st_promo", text: "백그라운드 작업으로 맡겼어요: 배포 공지 초안" },
	{
		ts: ago(11), kind: "out", source: "orchestrator", target: "main", text: "보낼 초안을 확인해 주세요",
		card: { title: "보낼 초안: 이번 주 업데이트 안내", facts: [{ label: "대상", value: "사이드 프로젝트 공지" }], actions: [{ label: "보내기", send: "보내기" }, { label: "초안 고치기", send: "고치기" }] },
	},
];

const CONVERSATIONS = [
	{ target: "main", last: { ts: ago(11), text: "이번 주 업데이트 안내", from: "bot" }, unread: 0, read: ago(11) },
	{ target: "alert", last: { ts: ago(8), text: "새 공지 소식이 도착했어요", from: "bot" }, unread: 3, read: null },
	{ target: "worklog", last: { ts: ago(95), text: "밤 사이 정리 기록을 남겼어요", from: "bot" }, unread: 0, read: ago(95) },
	{ target: "ch:1", last: { ts: ago(12), text: "로그인 화면 문구를 반영했어요", from: "bot" }, unread: 0, read: ago(12) },
	{ target: "ch:2", last: { ts: ago(180), text: "두 번째 글 초안을 올려 뒀어요", from: "bot" }, unread: 0, read: ago(180) },
	{ target: "lane:deploy", last: { ts: ago(8), text: "확인 중", from: "session" }, unread: 0, read: ago(8) },
];

const STATE = () => ({
	name: "dotz",
	orchestrator: { status: "working" },
	lanes: [{ name: "deploy", title: "배포 준비", status: "working", live: true, home: "ch:1", startedAt: ago(18), lastText: "배포 전 점검 목록을 확인하고 있어요" }],
	terminals: {},
	channels: { work: { "1": "사이드 프로젝트", "2": "블로그 글" }, homes: { deploy: "1" }, lanes: {}, threads: {} },
	discord: {},
	notices_unread: 1,
	work: [{ id: "st_promo", description: "배포 공지 초안", status: "running", started_at: ago(24) }],
	runs: {
		main: { kind: "working", since: ago(3), detail: "릴리스 노트 마무리 중" },
		"lane:deploy": { kind: "working", since: ago(3), detail: "배포 전 점검 목록 확인 중" },
	},
	work_now: now,
});

const PROJECTS = [
	{ key: "ch:1", name: "사이드 프로젝트", pinned: true, recordKey: "ch:1", channel: { id: "1", name: "사이드 프로젝트" }, record: { title: "사이드 프로젝트", purpose: "작은 웹 앱 만들기", updated: ago(12) }, lanes: [] },
	{ key: "ch:2", name: "블로그 글", pinned: false, recordKey: "ch:2", channel: { id: "2", name: "블로그 글" }, record: { title: "블로그 글", purpose: "글 두 편 쓰기", updated: ago(180) }, lanes: [] },
];

const TODO = {
	phases: [{ name: "배포 준비", tasks: [
		{ content: "로그인 화면 문구 확인", status: "completed" },
		{ content: "릴리스 노트 초안 다듬기", status: "in_progress" },
		{ content: "배포 공지 초안 확인", status: "pending" },
	] }],
};

const NOTICES = {
	unread: 1,
	items: [{ id: "n-promo-1", kind: "notice", cls: "news", tone: "", src: "main", open: "main", at: ago(5), title: "이번 주 업데이트 안내", read: false }],
};

/* ---------- fixture server ---------- */
const unknown = new Map<string, number>();
const api = (req: Request, url: URL): Response | undefined => {
	const p = url.pathname;
	if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last") ?? "");
	if (p === "/api/state") return json(STATE());
	if (p === "/api/history") { const t = url.searchParams.get("target"); return json({ target: t, events: t === "main" ? MAIN : [] }); }
	if (p === "/api/conversations") return json({ items: CONVERSATIONS });
	if (p === "/api/todo") return json(TODO);
	if (p === "/api/notices") return json(NOTICES);
	if (p === "/api/custom") return json({ dir: "", cards: [], projects: PROJECTS, routines: [], links: [] });
	if (p === "/api/activity") return json({ items: [], more: false, history: false });
	if (p === "/api/models") return json({ targets: [] });
	if (p === "/api/monitors" || p === "/api/integrations" || p === "/api/workers" || p === "/api/queue") return json({ items: [] });
	if (p === "/api/peers" || p === "/api/monitoring/peers") return json([]);
	return undefined;
};

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		const own = api(req, url);
		if (own) return own;
		if (p.startsWith("/api/")) {
			unknown.set(`${req.method} ${p}`, (unknown.get(`${req.method} ${p}`) ?? 0) + 1);
			return json({});
		}
		return new Response("not found", { status: 404 });
	},
});
const origin = `http://127.0.0.1:${server.port}`;

/* ---------- page helpers (the waits hub/*-web.test.ts use) ---------- */
const waitFor = (v: View, expr: string, ms = 20_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
// Fonts loaded, every image complete, entrance animations done (a pulsing status dot runs forever and is not waited for), two frames painted.
const painted = (v: View) => v.evaluate(`new Promise(res => {
	const still = () => document.getAnimations().every(a => a.playState !== "running" || (a.effect && a.effect.getTiming().iterations === Infinity));
	const tick = () => { if (document.fonts.status === "loaded" && [...document.images].every(i => i.complete) && still()) requestAnimationFrame(() => requestAnimationFrame(() => res(true))); else requestAnimationFrame(tick); };
	document.fonts.ready.then(tick); tick();
})`);
const runtime = `typeof S !== "undefined" && S && typeof target === "string" && CV.loaded && NT.loaded`;

const open = async (opts: { width: number; height: number; scale?: number; dark?: boolean; phone?: boolean }): Promise<View> => {
	const v = new Bun.WebView({ width: opts.width, height: opts.height, ...(opts.scale && opts.scale > 1 ? { backend: "chrome" } : {}) } as ConstructorParameters<typeof Bun.WebView>[0]);
	const url = `${origin}/?shot=${Math.random().toString(36).slice(2)}`;
	await v.navigate(url);
	if (opts.scale && opts.scale > 1) {
		await v.cdp("Emulation.setDeviceMetricsOverride", { width: opts.width, height: opts.height, deviceScaleFactor: opts.scale, mobile: !!opts.phone });
		await v.navigate(url);
	}
	await waitFor(v, runtime);
	await v.evaluate(`(() => { localStorage.setItem("dotz-theme", ${JSON.stringify(opts.dark ? "dark" : "light")}); document.documentElement.dataset.theme = ${JSON.stringify(opts.dark ? "dark" : "light")}; return 0; })()`);
	if (opts.phone) await v.evaluate(`(go("chat", "main"), 0)`);
	else await v.evaluate(`(go("chat"), 0)`);
	await waitFor(v, `current === "chat" && target === "main" && CV.placed && tl.querySelectorAll(".um, .bm, .cv-sys").length >= 4`);
	await painted(v);
	await waitFor(v, `!document.querySelector(".toast")`);
	console.log("metrics", opts.width, await v.evaluate(`JSON.stringify({ ch: timeline.clientHeight, sh: tl.scrollHeight, top: timeline.scrollTop, jump: !document.querySelector("#chat-jump").hidden, kids: [...tl.children].map(n => [n.className, Math.round(n.getBoundingClientRect().height)]) })`));
	return v;
};

const save = async (v: View, name: string) => {
	const path = join(OUT, name);
	await Bun.write(path, await v.screenshot());
	const kb = Math.round(statSync(path).size / 1024);
	console.log(`${name}: ${kb} KB`);
};

/* ---------- shots ---------- */
try {
	const desktop = await open({ width: 1440, height: 900 });
	await save(desktop, "web-desktop.png");
	desktop.close();

	const dark = await open({ width: 1440, height: 900, dark: true });
	await save(dark, "web-dark.png");
	dark.close();

	const phone = await open({ width: 390, height: 844, scale: 2, phone: true });
	console.log("phone viewport:", await phone.evaluate(`JSON.stringify([innerWidth, innerHeight, devicePixelRatio])`));
	await save(phone, "web-phone.png");
	phone.close();

	const og = await open({ width: 1200, height: 630 });
	await save(og, "og.png");
	og.close();
} finally {
	server.stop(true);
	if (unknown.size) console.log("unanswered /api routes:", [...unknown].map(([k, n]) => `${k} x${n}`).join(", "));
}
process.exit(0);
