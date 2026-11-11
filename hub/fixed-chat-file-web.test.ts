// A file row in a message of the 작업내역 / 알림 conversations (web/js/30-notices.js, the timeline's capture-phase click) in a headless
// Bun.WebView against the real /api/file route: the row opens the file in the reader, while a tap on the message's words still opens it
// like its notice does (the worklog row unfolds first: web/js/11-worklog.js). The file row is a plain element (15-attachments.js fileChipRow), so the tap used to land on the message instead.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileRoute } from "./files.ts";
import { appAsset, indexPage } from "./webapp.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "fixed-chat-file-web-")));
const DOC = join(ROOT, "omo-bug.md");
writeFileSync(DOC, "# 원인 정리\n\n응답이 멈춘 뒤 다시 시작될 때 열린 블록이 남아 있어요.\n");
const TS = new Date(Date.now() - 60_000).toISOString();
const HIST = [{ ts: TS, kind: "out", source: "orchestrator", target: "worklog", text: `✅ 멈추던 문제를 고쳐 main에 올렸어요.\n[file] ${DOC}` }];
const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/file") return fileRoute(req, url, [ROOT], new Set());
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {} });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === "worklog" ? HIST : [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/apps") return json({ items: [], errors: [] });
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); rmSync(ROOT, { recursive: true, force: true }); });
const waitOn = (v: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const MSG = `document.querySelector('#timeline .bm[data-ts="${TS}"]')`;
const ROW = `${MSG}.querySelector(".ans-files .fatt")`;

async function open(width: number, height: number) {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/#chat/worklog`);
	await waitOn(v, `typeof viewer === "function" && target === "worklog" && ${MSG}`);
	await v.evaluate(`(${MSG}.click(), 0)`);
	await waitOn(v, `${ROW} && !${ROW}.classList.contains("off")`);
	return v;
}

test.each([[1280, 900], [390, 844]])("작업내역 at %ipx: the file row opens the reader, the words still open the message's notice", async (w, h) => {
	const v = await open(w, h);
	await v.evaluate(`(${ROW}.click(), 0)`);
	await waitOn(v, `document.querySelector("dialog.tbox[open] .tv-body .md")`);
	expect(await v.evaluate(`document.querySelector("dialog.tbox[open] .tv-n").textContent`)).toBe("omo-bug.md");
	expect(await v.evaluate(`document.querySelector("dialog.tbox[open] .tv-body .md .h").textContent`)).toBe("원인 정리");
	expect(await v.evaluate(`${MSG}.classList.contains("nt-hl")`)).toBe(false);
	await v.evaluate(`(document.querySelector("dialog.tbox[open]").close(), 0)`);
	await waitOn(v, `!document.querySelector("dialog.tbox")`);
	await v.evaluate(`(${MSG}.querySelector(".md p").click(), 0)`);
	await waitOn(v, `${MSG}.classList.contains("nt-hl")`);
	expect(await v.evaluate(`!!document.querySelector("dialog.tbox")`)).toBe(false);
});
