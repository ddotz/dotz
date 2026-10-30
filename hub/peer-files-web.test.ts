import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { emit, sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// A file attached to a mail conversation shows as a chip in the owner's sent bubble, right after sending and after a reload, on this
// computer's conversation and on the Mac mini's one opened here (owner 2026-10-27: "파일 첨부하고 메시지 보내니까 어떤 파일이 첨부되었는지 안뜸").
// The Mac mini's file is uploaded to the Mac mini (act "upload") and its message carries the Mac mini's paths; a failed upload sends nothing.
// Headless; both computers are fixtures, the local message reaches the page through the real event stream.
const SHOTS = process.env.PEER_FILES_SHOTS ?? "/tmp/peer-files-shots";
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const now = new Date(Date.now() - 5 * 60_000).toISOString();
const LOCAL_T = "mail:kdb-local", PEER_T = "mail:kdb-peer";
const NAME = "연결조정분개_흐름도.html", BODY = "<html><body>흐름도</body></html>";
const mail = (key: string) => ({ key, subject: "연결조정 분개", from: "Kim <kim@example.com>", source: "kdb", at: now, summary: "흐름도를 다시 보내 주세요.", reply: "draft", unreadplied: false });
const conv = (t: string) => ({ target: t, mail: mail(t.slice(5)), last: { ts: now, text: "연결조정 분개", via: "kdb" }, unread: 0 });
const MAIL_APP = { key: "mail", label: "메일", icon: "mail", kind: "app", unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 }, conv: ["mail:"] };

type Up = { path: string; name: string; type: string; size: number };
// Each computer's uploads (path -> bytes) and the owner messages its history holds.
const localUp = new Map<string, Uint8Array>(), peerUp = new Map<string, Uint8Array>();
const localHist: object[] = [], peerHist: object[] = [];
const acts: { action: string; args: Record<string, any> }[] = [];
// What the composer sent (opening a conversation also marks it read there: a "read" act, not part of a send).
const sends = () => acts.filter(a => a.action !== "read");
let peerUploadFails = false;
const store = (m: Map<string, Uint8Array>, root: string, name: string, bytes: Uint8Array, type: string): Up => {
	const path = `${root}/uploads/2026-10-27/${m.size}-${name}`;
	m.set(path, bytes);
	return { path, name, type, size: bytes.length };
};
const serve = (m: Map<string, Uint8Array>, path: string | null) => {
	const b = path ? m.get(path) : undefined;
	return b ? new Response(b, { headers: { "content-type": "text/plain; charset=utf-8" } }) : Response.json({ error: "열 수 없는 파일이에요" }, { status: 404 });
};
const json = (v: unknown, status = 200) => Response.json(v, { status });
const ownerFiles = (m: Map<string, Uint8Array>, files: Up[] | undefined) => (files ?? []).every(f => m.has(f.path));

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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, { name: "맥미니", url: MINI, self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/integrations") return json({ items: [MAIL_APP] });
		if (p === "/api/conversations") return json({ items: [conv(LOCAL_T)] });
		if (p === "/api/monitoring/peers") return json([{ name: "맥미니", url: MINI, online: true, stale: false, items: { name: "맥미니", rev: "r1", monitors: [], notices: [], integrations: [MAIL_APP], available: [], conversations: [conv(PEER_T)] } }]);
		// This computer: its own upload, file, message and history routes.
		if (p === "/api/upload" && req.method === "POST") {
			const files = (await req.formData()).getAll("file") as File[];
			return json({ ok: true, files: await Promise.all(files.map(async f => store(localUp, "/Users/mb/.dotz", f.name, new Uint8Array(await f.arrayBuffer()), f.type))) });
		}
		if (p === "/api/file") return serve(localUp, url.searchParams.get("path"));
		if (p === "/api/message" && req.method === "POST") {
			const b = (await req.json()) as { text: string; mail?: string; files?: Up[] };
			if (b.mail !== LOCAL_T.slice(5) || !ownerFiles(localUp, b.files)) return json({ error: "첨부파일을 찾지 못했어요" }, 400);
			const e = { ts: new Date().toISOString(), kind: "message", source: "web", channel: LOCAL_T, conv: LOCAL_T, author: "owner", text: b.text, mid: `m${localHist.length}`, ...(b.files?.length ? { files: b.files } : {}) };
			localHist.push(e);
			emit("inbox", e);
			return json({ ok: true });
		}
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === LOCAL_T ? localHist : [] });
		// The Mac mini, reached through this computer's peer proxy.
		if (p === "/api/peer/proxy") {
			const pp = new URL(url.searchParams.get("p") ?? "", MINI);
			if (req.method === "POST") {
				const a = (await req.json()) as (typeof acts)[number];
				acts.push(a);
				if (a.action === "upload") {
					if (peerUploadFails) return json({ error: "연결 안 됨" }, 502);
					return json({ ok: true, files: a.args.files.map((f: { name: string; type: string; data: string }) => store(peerUp, "/Users/mini/.dotz", f.name, new Uint8Array(Buffer.from(f.data, "base64")), f.type)) });
				}
				if (a.action === "message") {
					if (a.args.target !== PEER_T || !ownerFiles(peerUp, a.args.files)) return json({ error: "첨부파일을 찾지 못했어요" }, 400);
					peerHist.push({ ts: new Date().toISOString(), kind: "message", source: "web", channel: PEER_T, conv: PEER_T, author: "owner", text: a.args.text, via: "맥북", mid: `p${peerHist.length}`, ...(a.args.files?.length ? { files: a.args.files } : {}) });
				}
				return json({ ok: true });
			}
			if (pp.pathname === "/api/peer/file") return serve(peerUp, pp.searchParams.get("path"));
			if (pp.pathname === "/api/history") return json({ target: pp.searchParams.get("target"), events: pp.searchParams.get("target") === PEER_T ? peerHist : [] });
			return json({});
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`(async () => JSON.stringify(await (async () => { ${code} })()))()`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
// The conversation opened the way a mail opens from 모니터링 (its old chat address lands there); a peer's needs the merged list first.
const openConv = async (width: number, t: string) => {
	const v = new Bun.WebView({ width, height: width < 640 ? 844 : 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `S && PR.fresh`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && PQ.of.has(${JSON.stringify(PEER_T)})`);
	await run(v, `pushOpen("#chat/${t}")`);
	await waitFor(v, `current === "chat" && monCtx === ${JSON.stringify(t)} && ts(${JSON.stringify(t)}).hLoaded`);
	return v;
};
const attachAndSend = async (v: View, text: string) => {
	await run(v, `addFiles([new File([${JSON.stringify(BODY)}], ${JSON.stringify(NAME)}, { type: "text/html" })])`);
	await waitFor(v, `ATT.length === 1 && ATT[0].file`);
	await run(v, `ta.value = ${JSON.stringify(text)}; document.querySelector("#send-btn").click()`);
};
const CHIP = `[...document.querySelectorAll(".um .mfiles .fatt")].find(c => c.querySelector(".fi-n").textContent === ${JSON.stringify(NAME)})`;
// The chip's name and size, and what its link (open; none for an HTML file of this computer, which opens in the 캔버스) and the download button give back.
const chip = (v: View) => q<{ name: string; meta: string; href: string; open: string; dl: string }>(v, `
	const c = ${CHIP}, item = c.closest(".fitem"), dl = item.querySelector(".fdl").href;
	return { name: c.querySelector(".fi-n").textContent, meta: c.querySelector(".fi-m").textContent, href: c.getAttribute("href"), open: c.getAttribute("href") ? await (await fetch(c.href)).text() : "", dl: await (await fetch(dl)).text() };`);

const SIZE = `HTML · ${new TextEncoder().encode(BODY).length}B`;
describe.each([390, 1280])("the sent bubble shows the attached file at %ipx", width => {
	beforeEach(() => { localHist.length = 0; peerHist.length = 0; acts.length = 0; });
	test("this computer's mail conversation: the chip shows after sending and after a reload, and opens the file", async () => {
		const v = await openConv(width, LOCAL_T);
		await attachAndSend(v, `이걸로 다시 보내놔 ${width}`);
		await waitFor(v, CHIP);
		const c = await chip(v);
		expect(c).toMatchObject({ name: NAME, meta: SIZE, href: null, dl: BODY });
		await Bun.write(join(SHOTS, `local-bubble-${width}.png`), await v.screenshot());
		await run(v, `${CHIP}.click()`);
		await waitFor(v, `!document.querySelector("#canvas").hidden && document.querySelector("#canvas .apps-n").textContent === ${JSON.stringify(NAME)}`);
		const again = await openConv(width, LOCAL_T);
		await waitFor(again, CHIP);
		expect((await chip(again)).dl).toBe(BODY);
		expect(await q<number>(again, `return document.documentElement.scrollWidth`)).toBeLessThanOrEqual(width);
	}, 30_000);

	test("the Mac mini's mail conversation: the file is uploaded there, the message carries its paths, and the chip opens it from there", async () => {
		const v = await openConv(width, PEER_T);
		const before = localUp.size;
		await attachAndSend(v, `이걸로 다시 보내놔 ${width}`);
		await waitFor(v, `${CHIP} && ${CHIP}.getAttribute("href").startsWith("/api/peer/proxy")`);
		expect(sends().map(a => a.action)).toEqual(["upload", "message"]);
		const sent = sends()[1]!.args.files as Up[];
		expect(sent).toHaveLength(1);
		expect(sent[0]!.path).toStartWith("/Users/mini/.dotz/uploads/");
		expect(new TextDecoder().decode(peerUp.get(sent[0]!.path))).toBe(BODY);
		expect(localUp.size).toBe(before + 1);   // staged here on attach; never named in the message to the Mac mini
		expect(JSON.stringify(sends()[1])).not.toContain("/Users/mb/");
		const c = await chip(v);
		expect(c).toMatchObject({ name: NAME, meta: SIZE, open: BODY, dl: BODY });
		expect(decodeURIComponent(decodeURIComponent(c.href))).toContain("/api/peer/file?path=/Users/mini/");
		await Bun.write(join(SHOTS, `peer-bubble-${width}.png`), await v.screenshot());
		const again = await openConv(width, PEER_T);
		await waitFor(again, CHIP);
		expect((await chip(again)).open).toBe(BODY);
		expect(await q<number>(again, `return document.documentElement.scrollWidth`)).toBeLessThanOrEqual(width);
	}, 30_000);
});

test("an upload to the Mac mini that fails sends nothing and says so in Korean; the text and the file stay in the composer", async () => {
	const v = await openConv(1280, PEER_T);
	acts.length = 0;
	const msgs = peerHist.length;
	peerUploadFails = true;
	try {
		await attachAndSend(v, "보내지면 안 돼요");
		await waitFor(v, `document.querySelector(".snack.bad")`);
		const s = await q<{ toast: string; text: string; att: string[] }>(v, `return { toast: document.querySelector(".snack.bad").textContent, text: ta.value, att: ATT.map(a => a.name) }`);
		expect(s.toast).toContain(`맥미니에 ${NAME}을(를) 올리지 못해서 보내지 않았어요`);
		expect(s.text).toBe("보내지면 안 돼요");
		expect(s.att).toEqual([NAME]);
		expect(sends().map(a => a.action)).toEqual(["upload"]);
		expect(peerHist.length).toBe(msgs);
	} finally {
		peerUploadFails = false;
	}
}, 30_000);

// 2026-10-28: the Mac mini's answer in its mail conversation named its result files ([file] lines); opened on the MacBook, each chip asked
// the MacBook's own /api/file, found nothing there and read "파일이 지워졌어요". A result file of the other computer opens from there.
test("a result file the Mac mini's bot posted in its conversation opens here through the peer proxy, not as a deleted file", async () => {
	const RESULT = "/Users/mini/.dotz/projects/ifrs18/files/취합본.pdf", PDF = "%PDF-1.4 취합본";
	peerUp.set(RESULT, new TextEncoder().encode(PDF));
	peerHist.push({ ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: PEER_T, text: `취합본 보내 드려요.\n[file] ${RESULT}` });
	const v = await openConv(1280, PEER_T);
	const RCHIP = `[...document.querySelectorAll(".bm .mfiles .fatt")].find(c => c.querySelector(".fi-n").textContent === "취합본.pdf")`;
	// the HEAD check answered: the size fills in (a refused check would turn the chip into a disabled "파일이 지워졌어요" one)
	await waitFor(v, `${RCHIP} && ${RCHIP}.querySelector(".fi-m").textContent === "PDF · ${new TextEncoder().encode(PDF).length}B"`);
	const c = await q<{ off: boolean; href: string; open: string }>(v, `const c = ${RCHIP}; return { off: c.classList.contains("off"), href: c.getAttribute("href"), open: await (await fetch(c.href)).text() }`);
	expect(c.off).toBe(false);
	expect(decodeURIComponent(decodeURIComponent(c.href))).toContain(`/api/peer/file?path=${RESULT}`);
	expect(c.open).toBe(PDF);
	await Bun.write(join(SHOTS, "peer-result-file-1280.png"), await v.screenshot());
}, 30_000);
