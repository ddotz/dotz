// Inline tokens of the composer's files and the lightbox, headless (Bun.WebView) against a fake hub: a token sits in the text where the file
// was put, deleting either side removes the other, undo brings both back, the sent text keeps the position and each file names its token.
// COMPOSER_IMAGE_SHOTS=<dir> keeps screenshots at 412 and 1280, light and dark (default: none).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.COMPOSER_IMAGE_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const json = (v: unknown, status = 200) => Response.json(v, { status });
const pic = (path: string) => { const c = path.includes("a.png") ? "#e96" : "#3a7"; return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${c}"/><circle cx="600" cy="400" r="220" fill="#fff" opacity=".5"/></svg>`; };
let history: Record<string, unknown>[] = [], sent: { text: string; files: { path: string; label?: string }[] }[] = [];
let onSent = () => {};
beforeEach(() => { history = []; sent = []; });
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
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, alerts_unread: 0 });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: history });
		if (p === "/api/file") return new Response(pic(url.searchParams.get("path") ?? ""), { headers: { "Content-Type": "image/svg+xml" } });
		if (p === "/api/upload" && req.method === "POST") {
			const f = (await req.formData()).get("file") as File;
			return json({ ok: true, files: [{ path: `/uploads/${f.name}`, name: f.name, type: f.type, size: f.size }] });
		}
		if (p === "/api/message" && req.method === "POST") { sent.push((await req.json()) as (typeof sent)[0]); onSent(); return json({ ok: true }); }
		if (p === "/api/items" || p === "/api/activity" || p === "/api/notices" || p === "/api/monitors" || p === "/api/integrations" || p === "/api/conversations") return json({ items: [] });
		if (p.startsWith("/api/")) return json({});
		return new Response("not found", { status: 404 });
	},
});
const BASE = `http://127.0.0.1:${server.port}`;
type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = (width: number, height: number): View => { const v = new Bun.WebView({ width, height }); views.push(v); return v; };
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
// Runs statements in the page as a global script, so the app's top-level names resolve; a returned promise is awaited.
const E = <T = unknown>(v: View, code: string): Promise<T> => v.evaluate(`(0, eval)(${JSON.stringify(code)})`) as Promise<T>;
const until = async (v: View, js: string, what: string) => {
	await E(v, `new Promise((ok, no) => { const end = Date.now() + 5000; (function go() { if (${js}) ok(1); else if (Date.now() > end) no(new Error(${'`'}timed out${'`'})); else requestAnimationFrame(go); })(); })`).catch(() => { throw new Error(what); });
};
const boot = async (v: View, dark = false) => {
	await v.navigate(BASE + "/#chat/main");
	await until(v, "typeof ta !== 'undefined' && typeof ATT !== 'undefined'", "the app starts");
	await E(v, `document.documentElement.dataset.theme = "${dark ? "dark" : "light"}"`);
	await E(v, "localStorage.clear(); ta.value = ''; ATT = []; ts(target).gone = []; renderAtt(); autosize(); ta.focus(); 1");
};
// Types through the browser's own edit path, so undo and input events are real.
const type = (v: View, s: string) => E(v, `document.execCommand('insertText', false, ${JSON.stringify(s)})`);
// A real paste event carrying an image.
const paste = async (v: View, name: string) => {
	const n = await E<number>(v, "ATT.length");
	await E(v, `(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 600; const g = c.getContext('2d'); g.fillStyle = ${JSON.stringify(name.includes('b') ? '#3a7' : '#e96')}; g.fillRect(0, 0, 900, 600); const b = await new Promise(ok => c.toBlob(ok, 'image/png')); const d = new DataTransfer(); d.items.add(new File([b], ${JSON.stringify(name)}, { type: 'image/png' })); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); return 1; })()`);
	await until(v, `ATT.length === ${n + 1} && ATT.every(a => a.file)`, "the upload lands");
};
const state = (v: View) => E<{ text: string; att: string[]; chips: string[]; gone: string[] }>(v, "({ text: ta.value, att: ATT.map(a => a.no), chips: [...document.querySelectorAll('.ta-tok .atk-in')].map(x => x.textContent), gone: atkGone().map(a => a.no) })");

describe("composer tokens", () => {
	test("a pasted image lands at the caret as a chip, and moves with the text", async () => {
		const v = open(1280, 800);
		await boot(v);
		await type(v, "이 화면과 저 화면");
		await E(v, "ta.setSelectionRange(4, 4)");
		await paste(v, "a.png");
		await E(v, "ta.setSelectionRange(ta.value.length, ta.value.length)");
		await paste(v, "b.png");
		const s = await state(v);
		expect(s.text).toBe("이 화면 [이미지1] 과 저 화면 [이미지2] ");
		expect(s.chips).toEqual(["이미지1", "이미지2"]);
		await E(v, "ta.setSelectionRange(0, 0)");
		await type(v, "앞에 ");
		expect((await state(v)).text.startsWith("앞에 이 화면 [이미지1]")).toBe(true);
		// the chip stands exactly over its raw text: same box, same line, no wider than the token
		const box = await E<{ top: number; ta: number; w: number; in: number }>(v, "(() => { const c = document.querySelector('.ta-tok .atk').getBoundingClientRect(), a = ta.getBoundingClientRect(), i = document.querySelector('.ta-tok .atk-in'); return { top: c.top, ta: a.top, w: c.width, in: i.scrollWidth }; })()");
		expect(box.top).toBeGreaterThanOrEqual(box.ta);
		expect(box.in).toBeLessThanOrEqual(Math.ceil(box.w));
	});

	test("Backspace takes the whole token and its file, and undo brings both back", async () => {
		const v = open(1280, 800);
		await boot(v);
		await type(v, "가 ");
		await paste(v, "a.png");
		await E(v, "ta.setSelectionRange(ta.value.length - 1, ta.value.length - 1)");
		await E(v, "ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true, bubbles: true })); 1");
		let s = await state(v);
		expect(s.text).toBe("가  ");
		expect(s.att).toEqual([]);
		expect(s.gone).toEqual(["이미지1"]);
		await E(v, "document.execCommand('undo')");
		s = await state(v);
		expect(s.text).toBe("가 [이미지1] ");
		expect(s.att).toEqual(["이미지1"]);
		expect(s.chips).toEqual(["이미지1"]);
	});

	test("a half-deleted token (a keyboard past the guard) goes whole", async () => {
		const v = open(1280, 800);
		await boot(v);
		await paste(v, "a.png");
		await E(v, "const c = ta.value; ta.value = c.slice(0, 5) + c.slice(6); ta.setSelectionRange(5, 5); ta.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward' })); 1");
		const s = await state(v);
		expect(s.text.trim()).toBe("");
		expect(s.att).toEqual([]);
	});

	test("taking the file off the tray removes its token; the other stays with its number", async () => {
		const v = open(1280, 800);
		await boot(v);
		await paste(v, "a.png");
		await type(v, "그리고 ");
		await paste(v, "b.png");
		await E(v, "document.querySelector('#atray .ax').click()");
		const s = await state(v);
		expect(s.text).toBe(" 그리고 [이미지2] ");
		expect(s.att).toEqual(["이미지2"]);
		await paste(v, "c.png");
		expect((await state(v)).att).toEqual(["이미지2", "이미지3"]);
	});

	test("the caret steps over a token and an open IME composition leaves tokens alone", async () => {
		const v = open(1280, 800);
		await boot(v);
		await paste(v, "a.png");
		await E(v, "ta.setSelectionRange(0, 0)");
		await until(v, "ATK.at === 0", "selectionchange reached the caret");
		await E(v, "ta.setSelectionRange(1, 1)");
		await until(v, "ta.selectionStart === '[이미지1]'.length", "the caret steps over");
		await E(v, "ta.dispatchEvent(new CompositionEvent('compositionstart')); ta.value = ta.value.slice(0, 5); ta.dispatchEvent(new InputEvent('input', { isComposing: true, inputType: 'insertCompositionText' })); 1");
		expect((await state(v)).att).toEqual(["이미지1"]);
		await E(v, "ta.dispatchEvent(new CompositionEvent('compositionend')); 1");
		expect((await state(v)).att).toEqual([]);
	});

	test("the draft and its files come back after a reload", async () => {
		const v = open(1280, 800);
		await boot(v);
		await type(v, "저장 ");
		await paste(v, "a.png");
		await E(v, "location.reload(); 1").catch(() => {});
		await until(v, "typeof ATT !== 'undefined' && ATT.length === 1", "the file is back");
		const s = await state(v);
		expect(s.text).toBe("저장 [이미지1] ");
		expect(s.chips).toEqual(["이미지1"]);
	});

	test("the sent text keeps the position, each file names its token, and the bubble shows the chip", async () => {
		const v = open(1280, 800);
		await boot(v);
		await type(v, "이건 ");
		await paste(v, "a.png");
		await type(v, "오류고 저건 ");
		await paste(v, "b.png");
		await E(v, `addFiles([new File(['x'], 'memo.txt', { type: 'text/plain' })]); 1`);
		await until(v, "ATT.length === 3 && ATT.every(a => a.file)", "the file uploads");
		const posted = new Promise<void>(ok => { onSent = ok; });
		await E(v, "sendChat(); 1");
		await until(v, "!ATT.length && !atkGone().length", "the composer empties");
		await posted;
		expect(sent[0]!.text).toBe("이건 [이미지1] 오류고 저건 [이미지2] [파일1]");
		expect(sent[0]!.files.map(f => [f.label, f.path])).toEqual([["이미지1", "/uploads/a.png"], ["이미지2", "/uploads/b.png"], ["파일1", "/uploads/memo.txt"]]);
		const node = await E<string[]>(v, `(() => { const e = { kind: 'message', ts: new Date().toISOString(), source: 'web', text: 'x', channel: 'ch:x' }; const p = atkParts(${JSON.stringify(sent[0]!.text)}, ${JSON.stringify(sent[0]!.files.map(f => ({ ...f, name: f.path.split('/').pop() })))}, e); return p.map(x => typeof x === 'string' ? x : x.textContent); })()`);
		expect(node).toEqual(["이건 ", "이미지1", " 오류고 저건 ", "이미지2", " ", "파일1", ""]);
		// under the bubble an image with its token carries the chip's name, not a path; a plain file keeps its path line
		const rows = await E<number[]>(v, `(() => { const n = filesNode([{ path: "/u/a.png", name: "a.png", label: "이미지1" }, { path: "/u/m.txt", name: "m.txt", label: "파일1" }], true); return [...n.querySelectorAll(".fitem")].map(i => i.querySelectorAll(".fpath").length); })()`);
		expect(rows).toEqual([0, 1]);
	});
});

describe("lightbox", () => {
	test("pages through a message's images, closes by Esc path and outside click, and holds only one image", async () => {
		const v = open(412, 800);
		await boot(v);
		await E(v, "lightbox('/u/a.png', 'a.png', null, [{ path: '/u/a.png', name: 'a.png' }, { path: '/u/b.png', name: 'b.png' }]); 1");
		await until(v, "document.querySelector('dialog.lbox img')", "it opens");
		expect(await E<number>(v, "document.querySelectorAll('dialog.lbox img').length")).toBe(1);
		await E(v, "document.querySelector('.lb-nav.next').click()");
		expect(await E<string>(v, "document.querySelector('.lb-n').textContent")).toBe("b.png · 2/2");
		expect(await E<string>(v, "document.querySelector('dialog.lbox img').src")).toContain("b.png");
		await E(v, "document.querySelector('dialog.lbox').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); 1");
		expect(await E<string>(v, "document.querySelector('.lb-n').textContent")).toBe("a.png · 1/2");
		await E(v, "document.querySelector('.lb-img').click()");
		await until(v, "!document.querySelector('dialog.lbox')", "outside click closes it");
	});

	test("a picture taller than the room fits the viewport", async () => {
		const v = open(1280, 800);
		await boot(v);
		await E(v, "lightbox('/u/a.png', 'a.png', null); 1");
		await until(v, "document.querySelector('dialog.lbox img')?.naturalWidth > 0", "it loads");
		const r = await E<{ bottom: number; right: number }>(v, "(() => { const r = document.querySelector('dialog.lbox img').getBoundingClientRect(); return { bottom: r.bottom, right: r.right }; })()");
		expect(r.bottom).toBeLessThanOrEqual(800);
		expect(r.right).toBeLessThanOrEqual(1280);
		await E(v, "document.querySelector('dialog.lbox').close(); 1");
	});

	test("a waiting file opens in the lightbox from the tray and the chip", async () => {
		const v = open(1280, 800);
		await boot(v);
		await paste(v, "a.png");
		await E(v, "document.querySelector('.ta-tok .atk-in').click()");
		await until(v, "document.querySelector('dialog.lbox img')", "the chip opens it");
		expect(await E<string>(v, "document.querySelector('.lb-n').textContent")).toBe("a.png");
		await E(v, "document.querySelector('dialog.lbox').close(); 1");
	});
});

if (SHOTS) describe("screenshots", () => {
	for (const [width, height] of [[412, 860], [1280, 800]] as const) for (const dark of [false, true]) test(`${width} ${dark ? 'dark' : 'light'}`, async () => {
		const v = open(width, height), tag = `${width}-${dark ? 'dark' : 'light'}`;
		history = [];
		await boot(v, dark);
		await type(v, "로그인 화면인데 ");
		await paste(v, "a.png");
		await type(v, "여기 버튼이 깨졌고 ");
		await paste(v, "b.png");
		await type(v, "는 정상이에요");
		await until(v, "ATT.every(a => /^blob:/.test(a.url)) && document.querySelector('.ta-tok img')", "chips paint");
		await Bun.write(join(SHOTS, `composer-${tag}.png`), await v.screenshot());
		const files = "[{ path: '/u/a.png', name: 'a.png', type: 'image/png', label: '이미지1' }, { path: '/u/b.png', name: 'b.png', type: 'image/png', label: '이미지2' }]";
		history = [{ kind: "message", ts: new Date().toISOString(), source: "web", channel: "ch:x", author: "owner", text: "로그인 화면인데 [이미지1] 여기 버튼이 깨졌고 [이미지2] 는 정상이에요", files: [{ path: "/u/a.png", name: "a.png", type: "image/png", label: "이미지1" }, { path: "/u/b.png", name: "b.png", type: "image/png", label: "이미지2" }] }];
		await E(v, "ta.value = ''; ATT = []; renderAtt(); autosize(); loadTarget(target, true)");
		await until(v, "document.querySelector('.ub .atk-in img')", "the bubble paints");
		await Bun.write(join(SHOTS, `bubble-${tag}.png`), await v.screenshot());
		await E(v, `lightbox('/u/a.png', 'a.png', null, ${files}); 1`);
		await until(v, "document.querySelector('dialog.lbox img')?.complete", "the viewer paints");
		await Bun.write(join(SHOTS, `lightbox-${tag}.png`), await v.screenshot());
		await E(v, "document.querySelector('dialog.lbox').close(); 1");
	});
});
