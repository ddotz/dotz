import { afterAll, expect, test } from "bun:test";
import { advanceTimers, fakeHub, json, on, type View } from "./test-web.ts";

const NOW = Date.now();
const item = (ref: string, draft: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: "확인해 보고 말씀드릴게요.", hash: "h1", ...draft }, original: { who: "김팀장", text: "자료 금요일까지 되나요?" }, ...o });
const posts: Record<string, unknown>[] = [];
const uploads: (() => void)[] = [];
let uploadArrived = (): void => undefined;
const nextUpload = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	uploadArrived = resolve;
	return promise;
};
let files: Record<string, string[]> = { RFILE02: ["견적서.pdf"], RUPLD01: [], RWRIT01: [] };
const writes: Record<string, unknown>[] = [];
let hangWrite = false;
let firstRead: { release: PromiseWithResolvers<void>; arrived: PromiseWithResolvers<void> } | null = null;
let wrote = (): void => undefined;
const nextWrite = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	wrote = resolve;
	return promise;
};
const queue = [item("RWAIT01"), item("RHANG01"), item("RUPLD01"), item("RSENT01", { state: "sent" })];
let hang = false;
const hub = fakeHub({
	stream: "fake",
	slowTimers: true,
	api: async (req, url) => {
		const fl = /^\/api\/drafts\/(\w+)\/files$/.exec(url.pathname);
		if (fl) {
			if (req.method === "POST") {
				writes.push((await req.json()) as Record<string, unknown>);
				wrote();
				if (hangWrite) await Promise.withResolvers<void>().promise;
			}
			const list = (files[fl[1]!] ?? []).map(name => ({ name, size: "1KB" }));
			const gate = req.method === "GET" && fl[1] === "RSTALE01" ? firstRead : null;
			if (gate) {
				firstRead = null;
				gate.arrived.resolve();
				await gate.release.promise;
			}
			return json({ files: list, canAttach: true, library: false, editable: true, tracked: true, original: true, attachIssues: [] });
		}
		if (url.pathname === "/api/upload") {
			const gate = Promise.withResolvers<void>();
			uploads.push(gate.resolve);
			uploadArrived();
			await gate.promise;
			return json({ files: [{ path: "/tmp/x", name: "a.pdf" }] });
		}
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: { waiting: 3, failed: 0, unsure: 0, sending: 0, sentToday: 1 }, triageMin: 1, undoSec: 10 });
		if (url.pathname === "/api/reply/act" && req.method === "POST") {
			posts.push((await req.json()) as Record<string, unknown>);
			if (hang) await Promise.withResolvers<void>().promise;
			return json({ ok: true });
		}
	},
});
afterAll(() => hub.stop());
const page = async (width: number): Promise<View> => {
	const v = await hub.view({ width, height: 800 });
	await v.navigate(`${hub.origin}/`);
	await on(v).waitFor(`typeof rqItemCard === "function" && RA.loaded`);
	return v;
};
const view = await page(1280);
const { waitFor, ev, run } = on(view);
const mount = (code: string) => run(`const box = document.getElementById("ra-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "ra-test" })); box.replaceChildren(); ${code}`);
const within = (expr: string, ms = 2000) => view.evaluate(`new Promise(res => { const end = Date.now() + ${ms}; const tick = () => { const ok = !!(${expr}); if (ok || Date.now() > end) res(ok); else requestAnimationFrame(tick); }; tick(); })`);

test("the card says who gets it, who is copied and the account it goes out from, on one line that fits a 360px phone", async () => {
	const v = await page(360);
	const it = item("RRCPT01", { to: "alice.long.address@example-company-name.com, bob@example.com", cc: ["boss@example.com", "erin@example.com"], account: "me.second.account@school.example" });
	await on(v).run(`document.body.replaceChildren(); const b = document.createElement("div"); b.id = "t"; b.style.padding = "12px"; document.body.append(b); b.append(rqItemCard(${JSON.stringify(it)}, { lead: true }), rqItemCard(${JSON.stringify(item("RRCPT02"))}))`);
	const line = (ref: string) => on(v).ev<string[]>(`[...document.querySelectorAll('#t [data-ref=${ref}] [data-k=rcpt] .rq-rc')].map(s => s.textContent)`);
	expect(await line("RRCPT01")).toEqual(["받는이alice.long.address@example-company-name.com, bob@example.com", "참조boss@example.com, erin@example.com", "보내는 계정me.second.account@school.example"]);
	expect(await line("RRCPT02")).toEqual(["받는이kim@example.com", "참조없음", "보내는 계정기본 계정"]);
	expect(await on(v).ev(`document.documentElement.scrollWidth <= 360 && [...document.querySelectorAll("#t .rq-rcpt")].every(n => n.scrollWidth <= n.clientWidth)`)).toBe(true);
});

test("the files row follows the version the card shows: a card of a newer draft reads the files again instead of keeping the old list", async () => {
	await mount(`RA.items.set("RFILE02", ${JSON.stringify(item("RFILE02"))}); box.append(rqItemCard(RA.items.get("RFILE02")))`);
	await waitFor(`document.querySelector("#ra-test [data-ref=RFILE02] .dr-fn")`);
	files = { ...files, RFILE02: ["새견적서.pdf"] };
	await mount(`RA.items.set("RFILE02", ${JSON.stringify(item("RFILE02", { hash: "h2" }))}); box.append(rqItemCard(RA.items.get("RFILE02")))`);
	await within(`(document.querySelector("#ra-test [data-ref=RFILE02] .dr-fn") || {}).textContent === "새견적서.pdf"`);
	expect(await ev(`[...document.querySelectorAll("#ra-test [data-ref=RFILE02] .dr-fn")].map(n => n.textContent)`)).toEqual(["새견적서.pdf"]);
});

test("a send that never answers stops waiting after 15 s and takes the lost-answer recheck: the card says it did not go and its buttons are back", async () => {
	hang = true;
	await mount(`box.append(rqItemCard(RA.items.get("RHANG01"), { lead: true })); document.querySelector("#ra-test [data-k=send]").click()`);
	await waitFor(`RA.busy.get("RHANG01") === "send"`);
	await advanceTimers(view, 15_000);
	await within(`!RA.busy.has("RHANG01")`);
	expect(await ev(`({ busy: RA.busy.has("RHANG01"), fail: (RA.fail.get("RHANG01") || {}).text, off: document.querySelector("#ra-test [data-ref=RHANG01] [data-k=send]").disabled })`)).toEqual({ busy: false, fail: "연결이 끊겨서 못 보냈어요. 다시 눌러 주세요", off: false });
	hang = false;
});

test("while a file uploads 보내기 is held and says so; an upload with no progress for 30 s is cut off and offers 다시 올리기", async () => {
	posts.length = 0;
	await mount(`box.append(rqItemCard(RA.items.get("RUPLD01"), { lead: true }), draftFilesNode({ ref: "RUPLD01", toLabel: "받는이" }, { t: "mail:RUPLD01" }))`);
	await waitFor(`document.querySelector("#ra-test > .dr-files .dr-add")`);
	const first = nextUpload();
	await run(`const i = document.querySelector('#ra-test > .dr-files input[type=file]'), dt = new DataTransfer(); dt.items.add(new File(["%PDF"], "a.pdf", { type: "application/pdf" })); i.files = dt.files; i.dispatchEvent(new Event("change"))`);
	await first;
	const press = () => run(`document.querySelector("#ra-test [data-ref=RUPLD01] [data-k=send]").click()`);
	await press();
	await within(`document.querySelector("#ra-test [data-ref=RUPLD01] .rq-fail")`);
	expect(await ev(`(document.querySelector("#ra-test [data-ref=RUPLD01] .rq-fail") || { textContent: "" }).textContent`)).toBe("파일을 올리는 중이에요");
	await run(`window.__toasts = []; const t0 = toast; window.toast = (m, ...r) => { window.__toasts.push(String(m)); return t0(m, ...r); }; pickOption({ key: "up-sheet", t: "mail:RUPLD01", draft: { ref: "RUPLD01", toLabel: "받는이" }, blocks: [{ options: [] }] }, 0, { n: 1, label: "보내기" })`);
	expect(await ev(`({ toasts: window.__toasts, st: DC.st["up-sheet"] || null })`)).toEqual({ toasts: ["파일을 올리는 중이에요"], st: null });
	expect(posts).toEqual([]);

	await advanceTimers(view, 30_000);
	await within(`document.querySelector("#ra-test > .dr-files [data-k=upload-again]")`);
	expect(await ev(`[...document.querySelectorAll("#ra-test > .dr-files [data-k=upload-again]")].map(b => b.textContent)`)).toEqual(["다시 올리기"]);
	const again = nextUpload();
	await run(`document.querySelector("#ra-test > .dr-files [data-k=upload-again]").click()`);
	await again;
	expect(uploads.length).toBe(2);
	files = { ...files, RUPLD01: ["a.pdf"] };
	uploads[1]!();
	await waitFor(`!document.querySelector("#ra-test > .dr-files .dr-add").disabled`);
	await press();
	await waitFor(`!RA.busy.has("RUPLD01")`);
	expect(posts.map(p => [p.ref, p.action])).toEqual([["RUPLD01", "send"]]);
});

test("a 고치기 panel kept over a reload goes when its draft no longer waits, sent drafts now staying in the list; a waiting draft's panel stays", async () => {
	const v = await page(390);
	await on(v).run(`raFixOpen(RA.items.get("RSENT01")); raFixOpen(RA.items.get("RWAIT01"))`);
	await v.navigate(`${hub.origin}/`);
	await on(v).waitFor(`typeof RA !== "undefined" && RA.loaded`);
	expect(await on(v).ev(`[...RA.fix.keys()]`)).toEqual(["RWAIT01"]);
});

test("a card says the sending account is not chosen yet when the send is held for one, and a comment reply's mail shows the account it goes out from", async () => {
	const v = await page(360);
	const held = item("RHELD01", { accountHeld: true });
	const comment = item("RCMT0001", { toLabel: "대상", to: "팬 댓글", mail: { ref: "RCMTML1", to: "fan@example.com", account: "mail.account@school.example", subject: "자료", text: "보내드려요" } }, { kind: "comment", conv: "comment:youtube" });
	const commentHeld = item("RCMT0002", { toLabel: "대상", to: "팬 댓글", mail: { ref: "RCMTML2", to: "fan@example.com", accountHeld: true, text: "보내드려요" } }, { kind: "comment", conv: "comment:youtube" });
	await on(v).run(`document.body.replaceChildren(); const b = document.createElement("div"); b.id = "t"; document.body.append(b); b.append(rqItemCard(${JSON.stringify(held)}), rqItemCard(${JSON.stringify(comment)}), rqItemCard(${JSON.stringify(commentHeld)}))`);
	expect(await on(v).ev(`[...document.querySelectorAll('#t [data-ref=RHELD01] [data-k=rcpt] .rq-rc')].map(s => s.textContent).at(-1)`)).toBe("보내는 계정계정이 아직 정해지지 않았어요");
	const mailRows = (ref: string) => on(v).ev<string[]>(`[...document.querySelectorAll('#t [data-ref=${ref}] .dr-mailpart .dc-dr-h')].map(s => s.textContent)`);
	expect(await mailRows("RCMT0001")).toContain("보내는 계정mail.account@school.example");
	expect(await mailRows("RCMT0002")).toContain("보내는 계정계정이 아직 정해지지 않았어요");
});

test("다시 올리기 after a write that never answered does not write the file twice when the first write landed, and writes it when it did not", async () => {
	hangWrite = true;
	writes.length = 0;
	const drop = (name: string) => run(`const i = document.querySelector('#ra-test > .dr-files input[type=file]'), dt = new DataTransfer(); dt.items.add(new File(["x".repeat(1024)], ${JSON.stringify(name)}, { type: "application/pdf" })); i.files = dt.files; i.dispatchEvent(new Event("change"))`);
	const cut = async (landed: Promise<void>) => {
		await landed;
		await advanceTimers(view, 15_000);
		await within(`document.querySelector("#ra-test > .dr-files [data-k=upload-again]")`);
	};
	await mount(`box.append(draftFilesNode({ ref: "RWRIT01", toLabel: "받는이" }, { t: "mail:RWRIT01" }))`);
	await waitFor(`document.querySelector("#ra-test > .dr-files .dr-add")`);
	let up = nextUpload();
	let landed = nextWrite();
	await drop("w.pdf");
	await up;
	uploads.at(-1)!();
	await cut(landed);
	const sent = uploads.length;
	files = { ...files, RWRIT01: ["w.pdf"] };
	hangWrite = false;
	await run(`document.querySelector("#ra-test > .dr-files [data-k=upload-again]").click()`);
	await waitFor(`!document.querySelector("#ra-test > .dr-files [data-k=upload-again]") && !document.querySelector("#ra-test > .dr-files .dr-add").disabled`);
	expect({ writes: writes.length, uploads: uploads.length }).toEqual({ writes: 1, uploads: sent });

	files = { ...files, RWRIT01: [] };
	hangWrite = true;
	writes.length = 0;
	await mount(`box.append(draftFilesNode({ ref: "RWRIT01", toLabel: "받는이", hash: "h2" }, { t: "mail:RWRIT01" }))`);
	await waitFor(`document.querySelector("#ra-test > .dr-files .dr-add")`);
	up = nextUpload();
	landed = nextWrite();
	await drop("z.pdf");
	await up;
	uploads.at(-1)!();
	await cut(landed);
	hangWrite = false;
	up = nextUpload();
	await run(`document.querySelector("#ra-test > .dr-files [data-k=upload-again]").click()`);
	await up;
	uploads.at(-1)!();
	await waitFor(`!document.querySelector("#ra-test > .dr-files [data-k=upload-again]") && !document.querySelector("#ra-test > .dr-files .dr-add").disabled`);
	expect(writes.length).toBe(2);
});

test("a files read that started before the card's hash changed is not used after it: the newer card shows the newer list", async () => {
	files = { ...files, RSTALE01: ["옛.pdf"] };
	const gate = (firstRead = { release: Promise.withResolvers<void>(), arrived: Promise.withResolvers<void>() });
	await mount(`box.append(draftFilesNode({ ref: "RSTALE01", toLabel: "받는이", hash: "h1" }, { t: "mail:RSTALE01" }))`);
	await gate.arrived.promise;
	files = { ...files, RSTALE01: ["새.pdf"] };
	await mount(`box.append(draftFilesNode({ ref: "RSTALE01", toLabel: "받는이", hash: "h2" }, { t: "mail:RSTALE01" }))`);
	gate.release.resolve();
	await within(`(document.querySelector("#ra-test .dr-fn") || {}).textContent === "새.pdf"`);
	expect(await ev(`[...document.querySelectorAll("#ra-test .dr-fn")].map(n => n.textContent)`)).toEqual(["새.pdf"]);
});
