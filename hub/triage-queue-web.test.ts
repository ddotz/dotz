// 빠른 처리 over the one reply queue (design 4.4, lane U3; reply clarity Amendments A and B): every waiting item of every channel, the same card, Enter sends and moves on,
// 진행 shows each item's state, and the one-card view names its keys (E opens the 고치기 panel, X drops; nothing sends while the panel is open). 목록 shows in each row what a
// 보내기 sends (the original, the draft, the mail that rides along and every file), posts only the picked sends, each with the hash its row showed, and 고치기 turns a row
// into its card with the panel open. Shots are written only when REPLY_SHOTS names a folder.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, json, on } from "./test-web.ts";

const SHOTS = process.env.REPLY_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = Date.now();
const item = (ref: string, at: number, o: Record<string, unknown> = {}, draft: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: `mail:${ref}`, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "kim@example.com", text: `초안 ${ref}`, hash: `${ref}-v1`, ...draft }, original: { who: `사람${ref.slice(-1)}`, text: "자료 되나요?" }, ...o });
const kakao = { kind: "kakao", app: "kakao", label: "카카오톡" };
const WITH_MAIL = { mail: { ref: "RMAILA1", to: "viewer@example.com", subject: "자료 보내드려요", text: "요청하신 자료를 붙였습니다.", attachments: [{ name: "자료.pdf", size: "88KB" }] } };
const queue = [item("RAAAAA1", NOW - 3000, { kind: "comment", app: "youtube", label: "유튜브" }, WITH_MAIL), item("RBBBBB2", NOW - 2000, kakao), item("RCCCCC3", NOW - 1000, {}, { attachments: [{ name: "견적서.pdf", size: "120KB" }] })];
const posts: Record<string, unknown>[] = [];
let posted: () => void = () => undefined;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 1, undoSec: 10 });
		if (req.method === "POST" && url.pathname === "/api/reply/act") {
			const b = (await req.json()) as Record<string, unknown>, ref = String(b.ref);
			posts.push(b);
			posted();
			if (b.action === "send" && ref.startsWith("RL")) return json({ ok: false, code: "changed", error: "초안이 바뀌었어요", item: item(ref, NOW, kakao, { text: `바뀐 초안 ${ref}`, hash: `${ref}-v2` }) }, 409);
			return json(b.action === "send" ? { ok: true, item: { ...(queue.find(i => i.ref === ref) ?? item(ref, NOW)), send: { state: "undo", at: NOW, until: Date.now() + 10_000, actions: [] } } } : { ok: true });
		}
	},
});
const view = await hub.view({ width: 1280, height: 900 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const nextPost = () => new Promise<void>(r => (posted = r));
const rowOf = (ref: string) => `.tq-row[data-ref=${ref}]`;

await view.navigate(`${hub.origin}/`);
await waitFor(`typeof tqOpen === "function" && RA.loaded`);
await run(`document.documentElement.dataset.theme = "light"`);
await run(`go("monitoring", "replies")`);
await waitFor(`document.querySelector(".rq-fast") && !document.querySelector(".rq-fast").hidden`);

test("빠른 처리 takes every waiting item of every channel, newest first, with the head count, a rail of all of them and the keys of the card", async () => {
	await run(`document.querySelector(".rq-fast").click()`);
	await waitFor(`TQ.h && document.querySelector(".tq-body .ra-card")`);
	expect(await ev(`TQ.items.map(i => i.ref)`)).toEqual(["RCCCCC3", "RBBBBB2", "RAAAAA1"]);
	expect(await ev(`document.querySelector(".tr-pos").textContent`)).toBe("빠른 처리 1 / 3");
	expect(await ev(`[...document.querySelectorAll(".tq-r")].map(r => r.dataset.ref)`)).toEqual(["RCCCCC3", "RBBBBB2", "RAAAAA1"]);
	expect(await ev(`document.querySelector(".tq-body .ra-card").dataset.ref`)).toBe("RCCCCC3");
	expect(await ev(`[...document.querySelectorAll(".tq-body .tq-keys .tq-key")].map(k => k.dataset.key || [...k.querySelectorAll("kbd")].map(b => b.textContent).join(""))`)).toEqual(["send", "fix", "drop", "←→", "L"]);
	if (SHOTS) {
		await waitFor(`document.getAnimations().every(a => a.playState !== "running")`);
		await Bun.write(join(SHOTS, "08-triage-one-1280.png"), await view.screenshot());
	}
});

test("Enter sends the item on screen once, with the hash of the version its card shows, and moves on; the rail shows its undo window", async () => {
	const p = nextPost();
	await run(`document.body.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "RCCCCC3", action: "send", hash: "RCCCCC3-v1" });
	await waitFor(`document.querySelector(".tr-pos").textContent === "빠른 처리 2 / 3"`);
	expect(await ev(`document.querySelector(".tq-r[data-ref=RCCCCC3] .tq-st").textContent`)).toMatch(/초 후 보내요$/);
	expect(posts).toHaveLength(1);
});

test("a list row shows what its 보내기 sends: the original, the draft, the mail that rides along and every file, or that there is none", async () => {
	await run(`document.querySelector(".tr-tog").click()`);
	await waitFor(`document.querySelectorAll(".tq-row").length === 3`);
	const row = (ref: string) => ev<{ keys: string[]; orig: string; text: string; mail: string; files: string[]; none: number }>(`(() => { const r = document.querySelector("${rowOf(ref)}"), t = s => (r.querySelector(s) || { textContent: "" }).textContent; return { keys: [...r.querySelectorAll(".rq-acts [data-k]")].map(b => b.dataset.k), orig: t("[data-k=orig]"), text: t(".tq-tx"), mail: t("[data-k=mail]"), files: [...r.querySelectorAll(".rq-att[data-k=files] .rq-af")].map(f => f.textContent), none: r.querySelectorAll(".rq-att[data-k=none]").length }; })()`);
	const withMail = await row("RAAAAA1");
	expect(withMail).toMatchObject({ keys: ["send", "fix", "skip"], orig: "자료 되나요?", text: "초안 RAAAAA1", files: ["자료.pdf88KB"], none: 1 });
	expect(withMail.mail).toContain("viewer@example.com");
	expect(withMail.mail).toContain("자료 보내드려요");
	expect(await row("RBBBBB2")).toEqual({ keys: ["send", "fix", "skip"], orig: "자료 되나요?", text: "초안 RBBBBB2", mail: "", files: [], none: 1 });
	if (SHOTS) {
		await waitFor(`document.getAnimations().every(a => a.playState !== "running")`);
		await Bun.write(join(SHOTS, "07-triage-list-1280.png"), await view.screenshot());
	}
});

test("the list posts only the picked sends, each with the hash its row showed", async () => {
	await run(`document.querySelector("${rowOf("RAAAAA1")} [data-k=send]").click()`);
	await waitFor(`!document.querySelector("[data-k=go-picked]").disabled`);
	await run(`document.querySelector("${rowOf("RBBBBB2")} [data-k=skip]").click()`);
	const p = nextPost();
	await run(`document.querySelector("[data-k=go-picked]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "RAAAAA1", action: "send", hash: "RAAAAA1-v1" });
	expect(posts.map(b => b.ref)).not.toContain("RBBBBB2");
});

test("고치기 on a list row turns the row into its card with the panel open; 반영 posts the change and the row is a row again", async () => {
	const r = rowOf("RBBBBB2");
	await run(`document.querySelector("${r} [data-k=fix]").click()`);
	await waitFor(`!!document.querySelector("${r} .ra-card [data-k=fix-text]")`);
	expect(await ev(`[document.querySelector("${r} [data-k=fix-text]").value, !!document.querySelector("${r} .tq-tx"), !!document.querySelector("${r} [data-k=send]"), document.querySelectorAll(".tq-row .ra-card").length]`)).toEqual(["초안 RBBBBB2", false, false, 1]);
	const p = nextPost();
	await run(`const f = document.querySelector("${r} [data-k=fix-text]"); f.value = "직접 고친 초안"; f.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("${r} [data-k=fix-apply]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "RBBBBB2", action: "edit", text: "직접 고친 초안", hash: "RBBBBB2-v1" });
	await waitFor(`!document.querySelector("${r} .ra-card") && !!document.querySelector("${r} .tq-tx")`);
	expect(await ev(`[...document.querySelectorAll("${r} .rq-acts [data-k]")].map(b => b.dataset.k)`)).toEqual(["send", "fix", "skip"]);
});

test("a long list scrolls inside the sheet to its last row, and a pick keeps the place", async () => {
	await run(`TQ.h.close(); for (let k = 0; k < 40; k++) RA.items.set("RL" + k, { ...RA.items.get("RBBBBB2"), ref: "RL" + k, item: "kakao:RL" + k, at: Date.now() - 100000 - k }); tqOpen(); TQ.list = true; tqPaint()`);
	await waitFor(`document.querySelectorAll(".tq-row").length > 40`);
	await run(`const b = document.querySelector(".tq-body"); b.scrollTop = b.scrollHeight`);
	const box = await ev<{ top: number; inView: boolean }>(`(() => { const b = document.querySelector(".tq-body"), r = b.getBoundingClientRect(), last = [...document.querySelectorAll(".tq-row")].at(-1).getBoundingClientRect(); return { top: b.scrollTop, inView: last.bottom <= r.bottom + 1 && last.top >= r.top - 1 }; })()`);
	expect(box.top).toBeGreaterThan(0);
	expect(box.inView).toBe(true);
	await run(`[...document.querySelectorAll(".tq-row")].at(-1).querySelector("[data-k=skip]").click()`);
	expect(await ev(`document.querySelector(".tq-body").scrollTop`)).toBe(box.top);
});

test("a picked send of a draft that changed since its row showed it is refused: the row shows the new version and says so, and nothing is picked", async () => {
	const r = rowOf("RL7");
	await run(`document.querySelector("${r} [data-k=send]").click()`);
	const p = nextPost();
	await run(`document.querySelector("[data-k=go-picked]").click()`);
	await p;
	expect(posts.at(-1)).toEqual({ ref: "RL7", action: "send", hash: "RBBBBB2-v1" });
	await waitFor(`!!document.querySelector("${r} .rq-fail[data-code=changed]")`);
	expect(await ev(`[document.querySelector("${r} .tq-tx").textContent, document.querySelector("${r} [data-k=send]").getAttribute("aria-pressed"), RA.items.get("RL7").draft.hash]`)).toEqual(["바뀐 초안 RL7", "false", "RL7-v2"]);
});

test("E opens the 고치기 panel, where no key sends and Esc only closes it, and Enter in its AI line posts revise; X drops the card; R does nothing", async () => {
	const press = (key: string) => run(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
	const cur = `.tq-body .ra-card[data-ref=RBBBBB2]`;
	await run(`TQ.h.close(); tqOpen("RBBBBB2")`);
	await waitFor(`TQ.h && !TQ.list && !!document.querySelector("${cur}")`);
	const before = posts.length;

	await press("r");
	expect(await ev(`[RA.fix.has("RBBBBB2"), RA.busy.has("RBBBBB2")]`)).toEqual([false, false]);
	await press("e");
	await waitFor(`document.activeElement.matches("${cur} [data-k=fix-text]")`);
	expect(await ev(`[document.activeElement.value, !!document.querySelector("${cur} [data-k=send]")]`)).toEqual(["초안 RBBBBB2", false]);
	await run(`document.activeElement.blur()`);
	await press("Enter");
	await press("x");
	expect(await ev(`RA.busy.has("RBBBBB2")`)).toBe(false);
	await run(`document.querySelector("${cur} [data-k=fix-text]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
	await waitFor(`!document.querySelector("${cur} [data-k=fix-text]") && !!document.querySelector("${cur} [data-k=send]")`);
	expect(await ev(`!!TQ.h`)).toBe(true);

	await press("e");
	await waitFor(`!!document.querySelector("${cur} [data-k=fix-note]")`);
	const revised = nextPost();
	await run(`const f = document.querySelector("${cur} [data-k=fix-note]"); f.value = "더 짧게"; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
	await revised;
	await waitFor(`!!document.querySelector("${cur} [data-k=send]")`);

	const dropped = nextPost();
	await press("x");
	await dropped;
	expect(posts.slice(before)).toEqual([{ ref: "RBBBBB2", action: "revise", change: "더 짧게" }, { ref: "RBBBBB2", action: "drop" }]);
});

test("on a phone the list rows fit the screen", async () => {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	const p = on(v);
	await p.waitFor(`typeof tqOpen === "function" && RA.loaded`);
	await p.run(`document.documentElement.dataset.theme = "light"; go("monitoring", "replies"); tqOpen(); TQ.list = true; tqPaint()`);
	await p.waitFor(`document.querySelectorAll(".tq-row").length === 3`);
	expect(await p.ev(`[...document.querySelectorAll(".tq-row")].every(r => r.scrollWidth <= r.clientWidth && r.getBoundingClientRect().right <= innerWidth)`)).toBe(true);
	if (SHOTS) {
		await p.waitFor(`document.getAnimations().every(a => a.playState !== "running")`);
		await Bun.write(join(SHOTS, "07-triage-list-390.png"), await v.screenshot());
	}
});
