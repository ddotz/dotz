import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, on } from "./test-web.ts";

const hub = fakeHub();
const view = await hub.view({ width: 1100, height: 800 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const boot = async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof mbCompose === "function" && S && current`);
};
const HOUR = 3_600_000;
beforeEach(async () => {
	await view.evaluate(`(() => { try { for (const w of [window, document.getElementById("tab2")?.contentWindow]) if (w) w.eval("for (const k of Object.keys(KEPT_HOLD)) delete KEPT_HOLD[k]"); localStorage.clear(); } catch {} return 0; })()`);
	await boot();
});

describe("one IME-aware Enter check", () => {
	const key = { key: "Enter", keyCode: 13, isComposing: false };
	const table: [string, object, boolean][] = [
		["a plain Enter", key, true],
		["an Enter inside a composition", { ...key, isComposing: true }, false],
		["Android's 229 while composing", { ...key, keyCode: 229 }, false],
		["Safari's Enter after compositionend, which carries keyCode 229", { ...key, keyCode: 229 }, false],
		["a letter key", { key: "a", keyCode: 65, isComposing: false }, false],
	];
	test.each(table)("%s", async (_name, init, plain) => {
		const got = await ev<{ plain: boolean; ime: boolean }>(`(() => { const e = ${JSON.stringify(init)}; return { plain: plainEnter(e), ime: imeKey(e) }; })()`);
		expect(got.plain).toBe(plain);
		if ((init as { key: string }).key === "Enter") expect(got.ime).toBe(!plain);
	});

	const acts = (target: string) =>
		ev<Record<string, boolean>>(`(() => {
			const t = ${target}, out = {};
			const fire = init => { const e = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...init }); t.dispatchEvent(e); return e.defaultPrevented; };
			out.composing = fire({ isComposing: true, keyCode: 229 });
			out.keyCode229 = fire({ keyCode: 229 });
			t.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
			out.safariAfterEnd = fire({ keyCode: 229 });
			out.chromeAfterEnd = fire({});
			return out;
		})()`);
	const rule = { composing: false, keyCode229: false, safariAfterEnd: false, chromeAfterEnd: true };
	const handlers: [string, string, string][] = [
		["the main composer", `ta.focus()`, `ta`],
		["the pane layout name", `paneLayoutAsk()`, `document.activeElement`],
		["the computer's own name", `MN.info = { custom: "", default: "dotz" }; mnDialog()`, `document.activeElement`],
		["an account alias", `ACC = { accounts: [{ name: "acc1" }], mode: "auto" }; accDialog({ name: "acc1", alias: "", label: "acc1" })`, `document.activeElement`],
	];
	test.each(handlers)("%s ignores the Enter that ends a composition and acts on the next one", async (_name, open, target) => {
		await run(open);
		await waitFor(`${target} && ${target}.matches("textarea, input")`);
		expect(await acts(target)).toEqual(rule);
	});

	test("the listed handlers use the one check and none of them tests isComposing on its own", () => {
		const own = /Enter[^\n]*\bisComposing\b|\bisComposing\b[^\n]*Enter/;
		for (const f of ["10-reply-actions", "10-decision-card", "21-providers", "25-settings-accounts", "33-peers", "43-panes-layouts", "30-mailboxes-set", "14-slash-commands", "32-app-settings"]) {
			const src = readFileSync(join(import.meta.dir, "..", "web", "js", `${f}.js`), "utf8");
			expect({ f, own: own.test(src), uses: /\b(plainEnter|imeKey)\(/.test(src) }).toEqual({ f, own: false, uses: true });
		}
	});
});

describe("the new-app box", () => {
	const enter = (extra = "{}") => ev<boolean>(`(() => { const b = document.querySelector('[data-k="new-app-text"]'); const e = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...${extra} }); b.dispatchEvent(e); return e.defaultPrevented; })()`);
	beforeEach(async () => {
		await run(`asAddSheet()`);
		await waitFor(`document.querySelector('[data-k="new-app-text"]')`);
	});
	test("on a desktop Enter sends and Shift+Enter or a composition's Enter does not", async () => {
		expect(await enter()).toBe(true);
		expect(await enter(`{ shiftKey: true }`)).toBe(false);
		expect(await enter(`{ isComposing: true }`)).toBe(false);
	});
	test("on a touch screen Enter is a new line", async () => {
		await run(`const real = window.matchMedia.bind(window); window.matchMedia = q => /pointer: coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(q)`);
		expect(await enter()).toBe(false);
	});
});

describe("a mail or reply in progress", () => {
	const reply = (body: string) => `MBOX.boxes.set("mail:x", { open: true, mode: "reply", st: { to: "a@example.org", cc: "", subject: "Re: 안부", body: ${JSON.stringify(body)}, files: [], up: [] } })`;
	test("the shell does not reload under an open new-mail box with text, an inline reply with text or an open revise panel", async () => {
		expect(await ev(`shellSafe()`)).toBe(true);
		await run(`mbCompose({})`);
		expect(await ev(`shellSafe()`)).toBe(true);
		await run(`MBOX.cs.st.body = "쓰던 글"`);
		expect(await ev(`shellSafe()`)).toBe(false);
		await run(`MBOX.cs.st.body = ""`);
		expect(await ev(`shellSafe()`)).toBe(true);
		await run(reply(""));
		expect(await ev(`shellSafe()`)).toBe(true);
		await run(reply("답장 쓰는 중"));
		expect(await ev(`shellSafe()`)).toBe(false);
		await run(`MBOX.boxes.clear()`);
		expect(await ev(`shellSafe()`)).toBe(true);
		await run(`RA.loaded = true; RA.items.set("R1", { ref: "R1" }); RA.fix.set("R1", raFixNew())`);
		expect(await ev(`shellSafe()`)).toBe(false);
		await run(`RA.fix.clear()`);
		expect(await ev(`shellSafe()`)).toBe(true);
	});

	test("a revise panel left open after its draft left the queue holds the reload only while it has unsaved text", async () => {
		const got = await ev<boolean[]>(`(() => {
			RA.loaded = true; RA.items = new Map();
			const at = fix => { RA.fix.clear(); RA.fix.set("R1", { ...raFixNew(), ...fix }); return shellSafe(); };
			const out = [
				at({}),
				at({ note: "더 짧게" }),
				at({ was: { text: { reply: "안녕" }, subject: {} }, text: { reply: "안녕" } }),
				at({ was: { text: { reply: "안녕" }, subject: {} }, text: { reply: "안녕하세요" } }),
				at({}),
			];
			RA.items.set("R1", { ref: "R1" });
			out.push(at({}));
			RA.items = new Map(); RA.loaded = false;
			out.push(at({}));
			return out;
		})()`);
		expect(got).toEqual([true, false, true, false, true, false, false]);
	});

	test("the new-mail box and an inline reply come back with their text after a reload", async () => {
		await run(`mbCompose({ to: "a@example.org", subject: "안부", body: "쓰던 글" }); ${reply("답장 쓰는 중")}`);
		await boot();
		await waitFor(`document.querySelector(".mbox-sheet .mbox-ta")`);
		expect(await ev(`({ to: document.querySelector('.mbox-sheet [data-k="mail-to"]').value, subject: document.querySelector('.mbox-sheet [data-k="mail-subject"]').value, body: document.querySelector(".mbox-sheet .mbox-ta").value })`)).toEqual({ to: "a@example.org", subject: "안부", body: "쓰던 글" });
		expect(await ev(`(({ open, mode, st }) => ({ open, mode, body: st.body, to: st.to }))(MBOX.boxes.get("mail:x"))`)).toEqual({ open: true, mode: "reply", body: "답장 쓰는 중", to: "a@example.org" });
	});

	describe("a second tab (a second page of the same origin, in a frame)", () => {
		const mine = { to: "a@example.org", cc: "", subject: "안부", files: [], showCc: false };
		const T2 = (code: string) => `document.getElementById("tab2").contentWindow.eval(${JSON.stringify(code)})`;
		const b = <T>(code: string) => ev<T>(T2(code));
		const keptKeys = () => ev<string[]>(`Object.keys(localStorage).filter(k => k.startsWith("dotz.kept.")).sort()`);
		const csField = (body: string, extra = {}) => JSON.stringify({ ...mine, body, ...extra });
		const entry = (key: string) => ev<{ text: string; at: number } | null>(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}) || "null")`);
		const openTab2 = async (expr = "true") => {
			await run(`sessionStorage.setItem("dotz.tab", "tsecondtab01"); const f = document.createElement("iframe"); f.id = "tab2"; f.src = "/"; f.style.cssText = "position:fixed;left:0;top:0;width:500px;height:300px;opacity:0;pointer-events:none"; document.body.append(f)`);
			await waitFor(`${T2(`typeof mbCompose === "function" && !!MBOX && !!current && (${expr})`)}`);
			await run(`sessionStorage.setItem("dotz.tab", KEPT_TAB)`);
			expect(await b<string>(`KEPT_TAB`)).toBe("tsecondtab01");
		};
		const seed = (tab: string, field: string, age: number, value: unknown, now: number) =>
			`localStorage.setItem("dotz.kept.${tab}.${field}", JSON.stringify({ text: ${JSON.stringify(JSON.stringify(value))}, at: ${now - age} }))`;
		const alive = (tab: string, age: number, now: number) => `localStorage.setItem("dotz.alive.${tab}", String(${now - age}))`;

		test("two live tabs keep separate compose text, and sending in one leaves the other's text where it is", async () => {
			await openTab2();
			const a = await ev<string>(`KEPT_TAB`);
			await run(`mbCompose(${csField("이 탭의 글")}); keptSave()`);
			await run(T2(`mbCompose(${csField("저 탭의 글")}); keptSave()`));
			expect(await keptKeys()).toEqual([`dotz.kept.${a}.mail-write.cs`, "dotz.kept.tsecondtab01.mail-write.cs"].sort());
			expect(JSON.parse((await entry(`dotz.kept.${a}.mail-write.cs`))!.text).body).toBe("이 탭의 글");
			expect(JSON.parse((await entry("dotz.kept.tsecondtab01.mail-write.cs"))!.text).body).toBe("저 탭의 글");
			await run(`mbSave = async () => ({ ok: true }); document.querySelector(".mbox-save").click()`);
			await waitFor(`!MBOX.cs`);
			expect(await keptKeys()).toEqual(["dotz.kept.tsecondtab01.mail-write.cs"]);
			expect(await b<string>(`MBOX.cs.st.body`)).toBe("저 탭의 글");
			expect(await b<boolean>(`!!document.querySelector(".mbox-sheet")`)).toBe(true);
			expect(JSON.parse((await entry("dotz.kept.tsecondtab01.mail-write.cs"))!.text).body).toBe("저 탭의 글");
		});

		test("discarding in one tab removes only that tab's entry", async () => {
			await openTab2();
			const a = await ev<string>(`KEPT_TAB`);
			await run(`mbCompose(${csField("이 탭의 글")}); keptSave()`);
			await run(T2(`mbCompose(${csField("저 탭의 글")}); keptSave()`));
			await run(`ask = async () => true; document.querySelector(".mbox-close").click()`);
			await waitFor(`!MBOX.cs`);
			expect(await keptKeys()).toEqual(["dotz.kept.tsecondtab01.mail-write.cs"]);
			expect(await ev<string>(`JSON.stringify([localStorage, sessionStorage])`)).not.toContain("이 탭의 글");
			expect(a).not.toBe("tsecondtab01");
		});

		test("each tab's inline reply and compose box have their own entries, so a box sent in one tab is not removed from the other", async () => {
			const put = (body: string) => `MBOX.boxes.set("mail:x", { open: true, mode: "reply", st: { to: "a@example.org", cc: "", subject: "Re: 안부", body: ${JSON.stringify(body)}, files: [], up: [] } }); keptSave()`;
			await openTab2();
			const a = await ev<string>(`KEPT_TAB`);
			await run(put("이 탭의 답장"));
			await run(T2(put("저 탭의 답장")));
			await run(`MBOX.boxes.delete("mail:x"); keptSave()`);
			expect(await keptKeys()).toEqual(["dotz.kept.tsecondtab01.mail-write.box:mail:x"]);
			expect(JSON.parse((await entry("dotz.kept.tsecondtab01.mail-write.box:mail:x"))!.text).body).toBe("저 탭의 답장");
			expect(a).not.toBe("tsecondtab01");
		});

		test("a tab that is gone is restored by exactly one new tab, and a live tab's entries are not touched", async () => {
			const now = await ev<number>(`Date.now()`);
			const cs = { ...mine, body: "죽은 탭의 글", min: false };
			await run([
				seed("tdeadtab0001", "mail-write.cs", 3 * HOUR, cs, now), seed("tdeadtab0001", "dc", 2 * HOUR, { edit: { R1: "죽은 탭의 수정" }, note: {} }, now), alive("tdeadtab0001", 120_000, now),
				seed("tlivetab0001", "mail-write.cs", HOUR, { ...cs, body: "산 탭의 글" }, now), alive("tlivetab0001", 10_000, now),
			].join("; "));
			await boot();
			await waitFor(`MBOX.cs && MBOX.cs.st.body === "죽은 탭의 글"`);
			expect(await ev(`DC.edit.R1`)).toBe("죽은 탭의 수정");
			const a = await ev<string>(`KEPT_TAB`);
			expect(await keptKeys()).toEqual([`dotz.kept.${a}.dc`, `dotz.kept.${a}.mail-write.cs`, "dotz.kept.tlivetab0001.mail-write.cs"].sort());
			expect((await entry(`dotz.kept.${a}.mail-write.cs`))?.at).toBe(now - 3 * HOUR);
			expect(await ev(`localStorage.getItem("dotz.alive.tdeadtab0001")`)).toBeNull();
			await openTab2();
			expect(await b(`({ cs: !!MBOX.cs, dc: DC.edit.R1 ?? null })`)).toEqual({ cs: false, dc: null });
			expect(JSON.parse((await entry("dotz.kept.tlivetab0001.mail-write.cs"))!.text).body).toBe("산 탭의 글");
			expect((await keptKeys()).length).toBe(3);
		});

		test("a tab that is gone for less than 90 seconds is still a live tab", async () => {
			const now = await ev<number>(`Date.now()`);
			await run([seed("tslowtab0001", "mail-write.cs", HOUR, { ...mine, body: "느린 탭의 글", min: false }, now), alive("tslowtab0001", 60_000, now)].join("; "));
			await boot();
			expect(await ev(`({ cs: !!MBOX.cs, keys: Object.keys(localStorage).filter(k => k.startsWith("dotz.kept.")) })`)).toEqual({ cs: false, keys: ["dotz.kept.tslowtab0001.mail-write.cs"] });
		});

		test("a tab that already has entries of its own adopts nothing", async () => {
			const now = await ev<number>(`Date.now()`);
			await run(`DC.edit.R1 = "내 글"; keptSave()`);
			await run([seed("tdeadtab0002", "mail-write.cs", HOUR, { ...mine, body: "죽은 탭의 글", min: false }, now), alive("tdeadtab0002", 200_000, now)].join("; "));
			await boot();
			expect(await ev(`({ cs: !!MBOX.cs, dc: DC.edit.R1 })`)).toEqual({ cs: false, dc: "내 글" });
			expect(await keptKeys()).toContain("dotz.kept.tdeadtab0002.mail-write.cs");
		});

		const frame = (id: string, stamp: string | null) =>
			`document.getElementById("tab2")?.remove(); ${stamp == null ? `localStorage.removeItem("dotz.alive.${id}")` : `localStorage.setItem("dotz.alive.${id}", ${stamp})`}; sessionStorage.setItem("dotz.tab", "${id}"); const f = document.createElement("iframe"); f.id = "tab2"; f.src = "/"; f.style.cssText = "position:fixed;left:0;top:0;width:500px;height:300px;opacity:0;pointer-events:none"; document.body.append(f)`;
		const loadFrame = async (id: string, stamp: string | null) => {
			await run(frame(id, stamp));
			await waitFor(T2(`typeof mbCompose === "function" && !!MBOX && !!current`));
			const got = await b<string>(`KEPT_TAB`);
			await run(`sessionStorage.setItem("dotz.tab", KEPT_TAB)`);
			return got;
		};

		test("a duplicated tab, which starts with its source's sessionStorage, takes a new id and keeps its own entries beside the source's", async () => {
			const a = await ev<string>(`KEPT_TAB`);
			await run(`mbCompose(${csField("원래 탭의 글")}); keptSave()`);
			await run(`document.getElementById("tab2")?.remove(); const f = document.createElement("iframe"); f.id = "tab2"; f.src = "/"; f.style.cssText = "position:fixed;left:0;top:0;width:500px;height:300px;opacity:0;pointer-events:none"; document.body.append(f)`);
			await waitFor(T2(`typeof mbCompose === "function" && !!MBOX && !!current`));
			const dup = await b<string>(`KEPT_TAB`);
			await run(`sessionStorage.setItem("dotz.tab", KEPT_TAB)`);
			expect(dup).not.toBe(a);
			expect(await b(`!!MBOX.cs`)).toBe(false);
			await run(T2(`mbCompose(${csField("복제한 탭의 글")}); keptSave()`));
			expect(await keptKeys()).toEqual([`dotz.kept.${a}.mail-write.cs`, `dotz.kept.${dup}.mail-write.cs`].sort());
			await run(`mbSave = async () => ({ ok: true }); document.querySelector(".mbox-save").click()`);
			await waitFor(`!MBOX.cs`);
			expect(await keptKeys()).toEqual([`dotz.kept.${dup}.mail-write.cs`]);
			expect(JSON.parse((await entry(`dotz.kept.${dup}.mail-write.cs`))!.text).body).toBe("복제한 탭의 글");
			expect(await b<string>(`MBOX.cs.st.body`)).toBe("복제한 탭의 글");
		});

		test("a tab keeps its stored id when the last stamp under it is closed or older than 45 seconds, and gets a new one when it is open and recent", async () => {
			const now = await ev<number>(`Date.now()`);
			expect(await loadFrame("tidclosed001", `"${now - 1000}:closed"`)).toBe("tidclosed001");
			expect(await loadFrame("tidstale0001", `String(${now - 60_000})`)).toBe("tidstale0001");
			expect(await loadFrame("tidnone00001", null)).toBe("tidnone00001");
			expect(await loadFrame("tidlive00001", `String(${now - 10_000})`)).not.toBe("tidlive00001");
		});

		test("a stored id whose stamp is hidden belongs to a tab in the background, however old the stamp, and a duplicate of it takes a new id", async () => {
			const now = await ev<number>(`Date.now()`);
			expect(await loadFrame("tidhidden001", `"${now - 10 * 60_000}:hidden"`)).not.toBe("tidhidden001");
			expect(await loadFrame("tidadopt0001", `"${now - 10 * 60_000}:adopted"`)).not.toBe("tidadopt0001");
		});

		test("a tab left by pagehide is closed, so its own reload keeps the id even when the leaving was a second ago", async () => {
			const id = await ev<string>(`KEPT_TAB`);
			await run(`dispatchEvent(new Event("pagehide"))`);
			expect(await ev<string>(`localStorage.getItem("dotz.alive." + KEPT_TAB)`)).toMatch(/^\d+:closed$/);
			await boot();
			expect(await ev<string>(`KEPT_TAB`)).toBe(id);
		});

		test("an app relaunched within 90 seconds of the old tab gets its text when the old tab's window has passed", async () => {
			const now = await ev<number>(`Date.now()`);
			const cs = { ...mine, body: "방금 닫은 탭의 글", min: false };
			await run([seed("tjustgone001", "mail-write.cs", HOUR, cs, now), alive("tjustgone001", 60_000, now)].join("; "));
			await boot();
			await run(`document.dispatchEvent(new Event("visibilitychange"))`);
			expect(await ev(`!!MBOX.cs`)).toBe(false);
			expect(await keptKeys()).toEqual(["dotz.kept.tjustgone001.mail-write.cs"]);
			await run(alive("tjustgone001", 120_000, await ev<number>(`Date.now()`)));
			await run(`document.dispatchEvent(new Event("visibilitychange"))`);
			await waitFor(`MBOX.cs && MBOX.cs.st.body === "방금 닫은 탭의 글"`);
			const a = await ev<string>(`KEPT_TAB`);
			expect(await keptKeys()).toEqual([`dotz.kept.${a}.mail-write.cs`]);
			expect((await entry(`dotz.kept.${a}.mail-write.cs`))?.at).toBe(now - HOUR);
			expect(await ev(`localStorage.getItem("dotz.alive.tjustgone001")`)).toBeNull();
		});

		test("a relaunched tab that already typed into a field keeps that text and leaves the old entry in place, while its other empty fields are filled", async () => {
			const now = await ev<number>(`Date.now()`);
			const box = { mode: "reply", to: "a@example.org", cc: "", subject: "Re: 안부", body: "죽은 탭의 답장", files: [], showCc: false };
			await run([
				seed("tjustgone002", "mail-write.cs", HOUR, { ...mine, body: "죽은 탭의 글", min: false }, now), seed("tjustgone002", "mail-write.box:mail:x", HOUR, box, now), alive("tjustgone002", 60_000, now),
			].join("; "));
			await boot();
			await run(`mbCompose(${csField("새로 쓰는 글")}); keptSave()`);
			await run(alive("tjustgone002", 120_000, await ev<number>(`Date.now()`)));
			await run(`document.dispatchEvent(new Event("visibilitychange"))`);
			await waitFor(`MBOX.boxes.get("mail:x")?.st.body === "죽은 탭의 답장"`);
			const a = await ev<string>(`KEPT_TAB`);
			expect(await ev<string>(`MBOX.cs.st.body`)).toBe("새로 쓰는 글");
			expect(JSON.parse((await entry(`dotz.kept.${a}.mail-write.cs`))!.text).body).toBe("새로 쓰는 글");
			expect(JSON.parse((await entry("dotz.kept.tjustgone002.mail-write.cs"))!.text).body).toBe("죽은 탭의 글");
			expect(await keptKeys()).toEqual([`dotz.kept.${a}.mail-write.box:mail:x`, `dotz.kept.${a}.mail-write.cs`, "dotz.kept.tjustgone002.mail-write.cs"].sort());
		});

		test("a field the tab typed into and emptied again before the old tab's window passed is not filled afterwards", async () => {
			const now = await ev<number>(`Date.now()`);
			await run([seed("tjustgone003", "mail-write.cs", HOUR, { ...mine, body: "죽은 탭의 글", min: false }, now), alive("tjustgone003", 60_000, now)].join("; "));
			await boot();
			await run(`mbCompose(${csField("썼다 지운 글")}); keptSave(); MBOX.cs.st.body = ""; MBOX.cs.st.to = ""; MBOX.cs.st.subject = ""; keptSave(); ask = async () => true; document.querySelector(".mbox-close").click()`);
			await waitFor(`!MBOX.cs`);
			await run(alive("tjustgone003", 120_000, await ev<number>(`Date.now()`)));
			await run(`document.dispatchEvent(new Event("visibilitychange"))`);
			expect(await ev(`!!MBOX.cs`)).toBe(false);
			expect(await keptKeys()).toEqual(["dotz.kept.tjustgone003.mail-write.cs"]);
		});

		const hiddenTab = (tab: string, stampAge: number, now: number) => [
			seed(tab, "dc", 2 * HOUR, { edit: { R1: "백그라운드 탭의 수정" }, note: {} }, now),
			seed(tab, "ra-fix.R1", HOUR, { part: "body", text: { body: "백그라운드 탭의 고침" }, subject: {}, note: "", hash: "h1" }, now),
			seed(tab, "nt-edit", HOUR, [["N1", { id: "N1", opt: "o", text: "백그라운드 탭의 사유" }]], now),
			`localStorage.setItem("dotz.alive.${tab}", "${now - stampAge}:hidden")`,
		].join("; ");

		test("an app relaunched right after the old tab went hidden gets its decision-card, reply-fix and notice text at load", async () => {
			const now = await ev<number>(`Date.now()`);
			await run(hiddenTab("thiddentab01", 5000, now));
			await boot();
			const a = await ev<string>(`KEPT_TAB`);
			expect(await ev(`({ dc: DC.edit.R1, nt: NS.stash.get("N1")?.text })`)).toEqual({ dc: "백그라운드 탭의 수정", nt: "백그라운드 탭의 사유" });
			expect(JSON.parse((await entry(`dotz.kept.${a}.ra-fix.R1`))!.text).text.body).toBe("백그라운드 탭의 고침");
		});

		test("a hidden tab keeps its own entries, however long it has been hidden, when another tab adopts copies of them", async () => {
			const now = await ev<number>(`Date.now()`);
			await run(hiddenTab("thiddentab02", 10 * 60_000, now));
			await boot();
			const a = await ev<string>(`KEPT_TAB`);
			expect(await ev(`DC.edit.R1`)).toBe("백그라운드 탭의 수정");
			expect(await keptKeys()).toEqual(["dc", "nt-edit", "ra-fix.R1"].flatMap(f => [`dotz.kept.${a}.${f}`, `dotz.kept.thiddentab02.${f}`]).sort());
			expect(JSON.parse((await entry("dotz.kept.thiddentab02.dc"))!.text).edit.R1).toBe("백그라운드 탭의 수정");
			expect((await entry(`dotz.kept.${a}.dc`))?.at).toBe(now - 2 * HOUR);
			expect(await ev(`localStorage.getItem("dotz.alive.thiddentab02")`)).toMatch(/:adopted$/);
		});

		test("copies taken from a hidden tab are taken once: after the new tab sends them, a reload does not bring them back", async () => {
			const now = await ev<number>(`Date.now()`);
			await run(hiddenTab("thiddentab03", 5000, now));
			await boot();
			expect(await ev(`DC.edit.R1`)).toBe("백그라운드 탭의 수정");
			expect(await ev(`localStorage.getItem("dotz.alive.thiddentab03")`)).toBe(`${now - 5000}:adopted`);
			const a = await ev<string>(`KEPT_TAB`);
			await run(`for (const k of Object.keys(KEPT_HOLD)) delete KEPT_HOLD[k]; for (const k of Object.keys(localStorage)) if (k.startsWith("dotz.kept." + KEPT_TAB + ".")) localStorage.removeItem(k)`);
			await boot();
			expect(await ev<string>(`KEPT_TAB`)).toBe(a);
			expect(await ev(`DC.edit.R1 ?? null`)).toBeNull();
			expect(await keptKeys()).toEqual(["dc", "nt-edit", "ra-fix.R1"].map(f => `dotz.kept.thiddentab03.${f}`));
		});

		test("a tab stamps itself hidden when it goes to the background and open again when it comes back", async () => {
			const state = (v: string) => `Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "${v}" }); document.dispatchEvent(new Event("visibilitychange"))`;
			await run(state("hidden"));
			expect(await ev<string>(`localStorage.getItem("dotz.alive." + KEPT_TAB)`)).toMatch(/^\d+:hidden$/);
			await run(state("visible"));
			expect(await ev<string>(`localStorage.getItem("dotz.alive." + KEPT_TAB)`)).toMatch(/^\d+$/);
		});
	});

	test("an empty box is not kept", async () => {
		await run(`mbCompose({})`);
		await boot();
		expect(await ev(`!!document.querySelector(".mbox-sheet") || MBOX.boxes.size > 0`)).toBe(false);
	});
});

describe("kept drafts", () => {
	const stored = (field: string) => ev<{ text: string; at: number } | null>(`JSON.parse(localStorage.getItem(KEPT_OWN + ${JSON.stringify(field)}) || "null")`);
	const keys = () => ev<string[]>(`Object.keys(localStorage).filter(k => k.startsWith("dotz.kept.") || k.startsWith("dotz.alive."))`);

	test("saving again keeps the stamp of the entry's first write, so a draft written 23 hours ago is gone 2 hours later", async () => {
		const got = await ev<{ at: number[]; text: string[]; t0: number; read: unknown[] }>(`(() => {
			const H = 3600000, t0 = 5000000000, real = Date.now;
			let v = { text: "쓰던 글" };
			kept("probe", () => v);
			const at = [], text = [];
			for (const [t, next] of [[t0, "쓰던 글"], [t0 + 23 * H, "더 쓴 글"], [t0 + 24 * H - 1, "또 쓴 글"]]) { v = { text: next }; Date.now = () => t; keptSave(); const e = JSON.parse(localStorage.getItem(KEPT_OWN + "probe")); at.push(e.at); text.push(JSON.parse(e.text).text); }
			Date.now = real;
			const raw = localStorage.getItem(KEPT_OWN + "probe");
			return { at, text, t0, read: [keptEntry(raw, t0 + 24 * H) && 1, keptEntry(raw, t0 + 25 * H)] };
		})()`);
		expect(got.at).toEqual([got.t0, got.t0, got.t0]);
		expect(got.text).toEqual(["쓰던 글", "더 쓴 글", "또 쓴 글"]);
		expect(got.read).toEqual([1, null]);
	});

	test("a draft started after the last one was emptied gets its own stamp, and an emptied one leaves no entry", async () => {
		const got = await ev<(number | null)[]>(`(() => {
			const t0 = 5000000000, real = Date.now;
			let v = { text: "첫 글" };
			kept("probe", () => v);
			const out = [];
			for (const [t, next] of [[t0, { text: "첫 글" }], [t0 + 1000, { text: "" }], [t0 + 2000, { text: "두번째 글" }]]) { v = next; Date.now = () => t; keptSave(); out.push(JSON.parse(localStorage.getItem(KEPT_OWN + "probe") || "null")?.at ?? null); }
			Date.now = real;
			return out;
		})()`);
		expect(got).toEqual([5000000000, null, 5000002000]);
	});

	test("every field has its own stamp: a field written 1 hour ago stays when a field written 25 hours ago is dropped", async () => {
		const now = await ev<number>(`Date.now()`);
		const put = (field: string, age: number, value: object) => `localStorage.setItem(KEPT_OWN + "${field}", JSON.stringify({ text: ${JSON.stringify(JSON.stringify(value))}, at: ${now - age} }))`;
		await run(`${put("dc", 25 * HOUR, { edit: { R1: "하루 지난 글" }, note: {} })}; ${put("mail-write.cs", HOUR, { to: "a@example.org", cc: "", subject: "안부", body: "한 시간 전 글", files: [], showCc: false, min: false })}`);
		await boot();
		await waitFor(`MBOX.cs && MBOX.cs.st.body === "한 시간 전 글"`);
		expect(await ev(`({ dc: DC.edit.R1 ?? null, left: Object.keys(localStorage).filter(k => k.startsWith("dotz.kept.")).map(k => k.slice(KEPT_OWN.length)) })`)).toEqual({ dc: null, left: ["mail-write.cs"] });
		expect((await stored("mail-write.cs"))?.at).toBe(now - HOUR);
	});

	test("a gone tab's 1 hour old note is restored beside its 25 hour old one, which is dropped with the stamp of a tab gone for 25 hours", async () => {
		const now = await ev<number>(`Date.now()`);
		const put = (tab: string, field: string, age: number, value: object) => `localStorage.setItem("dotz.kept.${tab}.${field}", JSON.stringify({ text: ${JSON.stringify(JSON.stringify(value))}, at: ${now - age} }))`;
		await run([
			put("tdeadtab0003", "dc", HOUR, { edit: {}, note: { R1: "한 시간 전 글" } }), put("tdeadtab0003", "mail-write.cs", 25 * HOUR, { to: "a@example.org", cc: "", subject: "안부", body: "하루 지난 글", files: [], showCc: false, min: false }),
			`localStorage.setItem("dotz.alive.tdeadtab0003", String(${now - 5 * 60_000}))`, `localStorage.setItem("dotz.alive.tdeadtab0004", String(${now - 25 * HOUR}))`,
		].join("; "));
		await boot();
		expect(await ev(`({ note: DC.note.R1 ?? null, cs: !!MBOX.cs })`)).toEqual({ note: "한 시간 전 글", cs: false });
		const a = await ev<string>(`KEPT_TAB`);
		expect((await keys()).sort()).toEqual([`dotz.alive.${a}`, `dotz.kept.${a}.dc`].sort());
	});

	test("a tab writes and removes only its own entries", async () => {
		const got = await ev<Record<string, unknown>>(`(() => {
			let a = { text: "가" };
			kept("probe-a", () => a);
			localStorage.setItem("dotz.kept.tothertab001.probe-a", JSON.stringify({ text: JSON.stringify({ text: "다른 탭의 글" }), at: Date.now() }));
			keptSave();
			const seen = k => JSON.parse(localStorage.getItem(k) || "null");
			const first = { mine: seen(KEPT_OWN + "probe-a").text, other: seen("dotz.kept.tothertab001.probe-a").text };
			a = { text: "" };
			keptSave();
			return { first, mine: seen(KEPT_OWN + "probe-a"), other: seen("dotz.kept.tothertab001.probe-a").text };
		})()`);
		expect(got).toEqual({ first: { mine: JSON.stringify({ text: "가" }), other: JSON.stringify({ text: "다른 탭의 글" }) }, mine: null, other: JSON.stringify({ text: "다른 탭의 글" }) });
	});

	test("a tab writes an entry again that another tab took while it was frozen", async () => {
		await run(`kept("probe", () => ({ text: "쓰던 글" })); keptSave(); localStorage.removeItem(KEPT_OWN + "probe"); keptSave()`);
		expect((await stored("probe"))?.text).toContain("쓰던 글");
	});

	test("a tab stamps that it is alive when it writes, and again when it is shown", async () => {
		const got = await ev<number[]>(`(() => {
			const real = Date.now, out = [];
			for (const t of [7000000000, 7000030000]) { Date.now = () => t; keptSave(); out.push(Number(localStorage.getItem("dotz.alive." + KEPT_TAB))); }
			Date.now = () => 7000060000; document.dispatchEvent(new Event("visibilitychange")); out.push(Number(localStorage.getItem("dotz.alive." + KEPT_TAB)));
			Date.now = real;
			return out;
		})()`);
		expect(got).toEqual([7000000000, 7000030000, 7000060000]);
	});

	test("the tab keeps its id across a reload", async () => {
		const id = await ev<string>(`KEPT_TAB`);
		await boot();
		expect(await ev(`[KEPT_TAB, sessionStorage.getItem("dotz.tab")]`)).toEqual([id, id]);
	});

	test("a hidden page writes its fields to localStorage and not to sessionStorage, and the old single entry is removed on load", async () => {
		await run(`kept("probe", () => ({ text: "쓰던 글" })); dispatchEvent(new Event("pagehide"))`);
		expect(await ev(`(() => { const o = JSON.parse(localStorage.getItem(KEPT_OWN + "probe")); return { text: JSON.parse(o.text).text, fresh: Math.abs(Date.now() - o.at) < 5000, session: sessionStorage.getItem("dotz.kept.probe") }; })()`)).toEqual({ text: "쓰던 글", fresh: true, session: null });
		await run(`localStorage.setItem("dotz.kept", JSON.stringify({ at: Date.now(), parts: { dc: { edit: { R1: "옛 글" }, note: {} } } }))`);
		await boot();
		expect(await ev(`({ old: localStorage.getItem("dotz.kept"), dc: DC.edit.R1 ?? null })`)).toEqual({ old: null, dc: null });
	});

	test("a reload brings the text back", async () => {
		await run(`DC.edit.R1 = "고치던 글"`);
		await boot();
		expect(await ev(`DC.edit.R1`)).toBe("고치던 글");
	});

	test("what the version before kept in sessionStorage (dotz.kept) is imported into this tab's entries and removed", async () => {
		const old = {
			dc: { edit: { R1: "옛 수정 글" }, note: { R1: "옛 메모" } },
			"ra-fix": [["R7", { part: "reply", text: { reply: "옛 답장" }, subject: {}, note: "더 짧게", hash: "" }]],
			"nt-edit": [],
		};
		await run(`sessionStorage.setItem("dotz.kept", ${JSON.stringify(JSON.stringify(old))})`);
		await boot();
		expect(await ev(`({ edit: DC.edit.R1, note: DC.note.R1, old: sessionStorage.getItem("dotz.kept") })`)).toEqual({ edit: "옛 수정 글", note: "옛 메모", old: null });
		expect((await stored("dc"))?.text).toContain("옛 수정 글");
		expect((await stored("ra-fix.R7"))?.text).toContain("더 짧게");
		expect(await stored("nt-edit")).toBeNull();
	});

	test("the entries of the update before this one (dotz.kept.<field>) are imported into this tab's entries and removed, an expired one dropped", async () => {
		const now = await ev<number>(`Date.now()`);
		const put = (field: string, age: number, value: object) => `localStorage.setItem("dotz.kept.${field}", JSON.stringify({ text: ${JSON.stringify(JSON.stringify(value))}, at: ${now - age} }))`;
		await run([put("dc", HOUR, { edit: { R1: "전 버전 글" }, note: {} }), put("mail-write.cs", 25 * HOUR, { to: "a@example.org", cc: "", subject: "안부", body: "하루 지난 글", files: [], showCc: false, min: false }), put("ra-fix.R7", 2 * HOUR, { part: "reply", text: { reply: "전 답장" }, subject: {}, note: "전 메모", hash: "" })].join("; "));
		await boot();
		expect(await ev(`({ edit: DC.edit.R1, cs: !!MBOX.cs })`)).toEqual({ edit: "전 버전 글", cs: false });
		expect(await ev(`Object.keys(localStorage).filter(k => k.startsWith("dotz.kept.")).map(k => k.slice(KEPT_OWN.length)).sort()`)).toEqual(["dc", "ra-fix.R7"]);
		expect((await stored("dc"))?.at).toBe(now - HOUR);
		expect(await ev(`Object.keys(localStorage).filter(k => k.startsWith("dotz.kept.") && !k.startsWith(KEPT_OWN)).length`)).toBe(0);
	});
});

describe("the reply sheet on a phone", () => {
	test("it is no taller than the visible area while the keyboard is up, so its head stays on screen", async () => {
		await view.resize(390, 844);
		await boot();
		await run(`const h = fsOpen({ label: "답장", cls: "mid rq-sheet" }); h.box.append(fsHead([el("h2", { class: "fs-t", text: "답장" })], { close: () => h.close() }), el("div", { class: "fs-body" }, el("div", { style: "height: 3000px" })))`);
		await waitFor(`document.querySelector(".fs-card.mid .fs-hd")`);
		await run(`document.documentElement.style.setProperty("--vvh", "320px")`);
		await view.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))`);
		const got = await ev<{ h: number; head: number }>(`(() => { const c = document.querySelector(".fs-card.mid"), r = c.getBoundingClientRect(); return { h: Math.round(r.height), head: Math.round(c.querySelector(".fs-hd").getBoundingClientRect().top - r.top) }; })()`);
		expect(got.h).toBeLessThanOrEqual(320);
		expect(got.head).toBeGreaterThanOrEqual(0);
		await view.resize(1100, 800);
	});
});
