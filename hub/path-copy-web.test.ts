import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// Paths under a file and in a project card show as ONE short line (shortPath), the full path in the title, and a tap copies the full
// path (pathCopy). Headless browser against a fixture history: a message with two attachments and a decision card below it.
// Set T1_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.T1_SHOTS ?? "";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const XLSX = "/Users/hyuns/.dotz/uploads/2026-10-26/mvoqivnd0r9j-2026년_9월_단신부임여비_신청.xlsx";
const PDF = "/Users/hyuns/.dotz/uploads/2026-10-26/1분기_정산_보고서.pdf";
const FILE_MSG = `첨부 두 개 보내 드려요.\n\n[file] ${XLSX}\n[file] ${PDF}`;
const SHORT_XLSX = "~/…/2026-10-26/mvoqivnd0…단신부임여비_신청.xlsx";
const SHORT_PDF = "~/…/2026-10-26/1분기_정산_보고서.pdf";
const ASK = "[ask] 확인\n결정: 어떻게 할까요?\n**1) 그대로 보내기** ← 추천\n바로 보내요\n**2) 고치기**\n내용을 고쳐요\n";
const history = [
	{ ts: "2026-10-26T01:10:00.000Z", kind: "message", source: "web", channel: "web", text: "첨부 좀 보내 줘" },
	{ ts: "2026-10-26T01:11:00.000Z", kind: "out", source: "orchestrator", target: "web", reply_to: "e0a1b2c3", text: FILE_MSG },
	{ ts: "2026-10-26T01:12:00.000Z", kind: "out", source: "orchestrator", target: "web", reply_to: "e0a1b2c4", text: ASK },
];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "main" ? history : [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/file") return new Response(null, { status: 200, headers: { "content-length": "48213", "content-type": "application/octet-stream" } });
		if (url.pathname === "/api/notices") return json({ items: [], unread: 0 });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

const waitFor = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(
		`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`,
	);

async function open(width: number, lang: string) {
	const v = new Bun.WebView({ width, height: lang === "390" ? 844 : 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`http://127.0.0.1:${server.port}/?light`);
	await waitFor(v, `typeof openTarget === "function" && S`);
	// A clipboard stub: copyText uses navigator.clipboard in a secure context (127.0.0.1 is one) and records what it wrote.
	await v.evaluate(`(Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async t => { (window.__copied ||= []).push(t); } } }), 0)`);
	await v.evaluate(`(openTarget("main", "chat"), 0)`);
	await waitFor(v, `document.querySelectorAll(".fitem .fpath").length === 2 && document.querySelector("#dcard .dc-row")`);
	return v;
}

type Paths = { text: string[]; title: string[]; oneLine: boolean[] };
const readPaths = async (v: InstanceType<typeof Bun.WebView>): Promise<Paths> =>
	JSON.parse(
		(await v.evaluate(`JSON.stringify((() => {
			const nodes = [...document.querySelectorAll(".fitem .fpath")];
			return { text: nodes.map(n => n.textContent), title: nodes.map(n => n.title),
				oneLine: nodes.map(n => n.scrollHeight <= parseFloat(getComputedStyle(n).lineHeight) * 1.5) };
		})())`)) as string,
	) as Paths;

for (const [name, width] of [["390", 390], ["1280", 1280]] as const) {
	test(`a file's path is one short line with the full path in the title at ${name}px`, async () => {
		const v = await open(width, name);
		const got = await readPaths(v);
		expect(got.title).toEqual([XLSX, PDF]);
		expect(got.text).toEqual([SHORT_XLSX, SHORT_PDF]);
		for (const t of got.text) expect(t.length).toBeLessThanOrEqual(40);
		expect(got.oneLine.every(Boolean)).toBe(true);
		expect(got.text.join(" ")).not.toContain("/Users/");
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await Bun.write(`${SHOTS}/paths-${name}.png`, await v.screenshot());
		}
		expect(await v.evaluate(`document.documentElement.scrollWidth > innerWidth`)).toBe(false);
	}, 30_000);
}

test("a tap copies the FULL path (not the short line) and says so", async () => {
	const v = await open(390, "390");
	await v.evaluate(`(document.querySelector(".fitem .fpath").click(), 0)`);
	const copied = (await v.evaluate(`JSON.stringify(window.__copied || [])`)) as string;
	expect(JSON.parse(copied)).toEqual([XLSX]);
	expect(await v.evaluate(`document.querySelector(".snack") && document.querySelector(".snack").textContent`)).toBe("경로를 복사했어요");
});

test("the decision card's buttons are the one button system: .dc-act, .dc-go and .dc-manual look like .btn", async () => {
	const v = await open(1280, "1280");
	const got = JSON.parse(
		(await v.evaluate(`JSON.stringify((() => {
			const mk = c => { const b = document.createElement("button"); b.className = c; b.textContent = "가"; document.body.append(b); const s = getComputedStyle(b), r = b.getBoundingClientRect(); const o = { h: Math.round(r.height), radius: s.borderRadius, font: s.fontSize, weight: s.fontWeight }; b.remove(); return o; };
			return { btn: mk("btn"), act: mk("dc-act"), back: mk("dc-back"), manual: mk("dc-manual"), secondary: mk("btn tonal"), quiet: mk("btn text"), rows: document.querySelectorAll("#dcard .dc-row").length };
		})())`)) as string,
	) as Record<string, { h: number; radius: string; font: string; weight: string } | number>;
	expect(got.rows).toBe(2);
	for (const k of ["act", "back", "secondary", "quiet"]) expect(got[k]).toEqual(got.btn);
	expect(got.manual).toMatchObject({ h: got.btn.h, radius: got.btn.radius, weight: got.btn.weight });
});
