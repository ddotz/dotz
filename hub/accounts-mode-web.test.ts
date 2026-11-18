import { afterAll, afterEach, expect, test } from "bun:test";
import { ev, fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";
import { setAppLang } from "./webapp.ts";

// The 계정 card (web/js/25-settings-accounts.js accountSection), the real bundle in a headless Bun.WebView against a fake hub: the 자동 전환
// switch row leads (off = 고정, the account is fixed by tapping its row), the 전환 규칙 row stays in both modes (in 고정 it says the
// rules rest), the script rows show only in 자동 전환, the switch writes PUT /api/accounts/mode, the grips write PUT /api/accounts/order, and
// the 물어보기 menu (under the small section name 한도에 걸리면) writes PUT /api/accounts/on-limit (null for 한 번 묻기) and re-renders.
type Call = [string, string, unknown];
const account = (name: string, over: object = {}) => ({ name, alias: null, label: name, current: false, blocked: null, blocked_until: null, blocked_tag: null, five_hour_left: null, seven_day_left: null, ...over });
const body = (mode: "auto" | "pinned", over: object = {}) => ({
	mode,
	rules: { on_limit: null },
	accounts: [account("default", { current: true }), account("teammate-shared")],
	chosen: { name: "default", label: "default", source: mode === "pinned" ? "manual" : "auto", blocked: null, text: "" },
	rules_text: [{ index: 0, text: "평일 09:00-18:00 · 회사 계정" }],
	script: { path: "/tmp/pick.sh", timeout_ms: 5000, every_minutes: 5, last: { account: "default", at: "2026-10-23T05:00:00Z" } },
	...over,
});
const ANTHROPIC = { id: "anthropic", name: "Claude 구독", auth: "oauth" };

let acc: Record<string, any> = body("auto");
let providers: object[] = [ANTHROPIC];
const calls = inbox<Call>();
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations" || p === "/api/monitors" || p === "/api/integrations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/update" || p === "/api/runtimes") return json({ error: "stub" }, 500);
		if (p === "/api/providers") return json({ providers });
		if (req.method === "PUT" || (req.method === "POST" && p.startsWith("/api/providers/"))) {
			const b = await req.json().catch(() => ({}));
			calls.push([p, req.method, b]);
			if (p === "/api/accounts/on-limit") acc = { ...acc, rules: { ...acc.rules, on_limit: (b as { on_limit: string | null }).on_limit } };
			return json(p.startsWith("/api/accounts") ? acc : {});
		}
		if (p === "/api/accounts") return json(acc);
	},
});
afterEach(() => { hub.release(); setAppLang("ko"); });
afterAll(() => hub.stop());

const CARD = `document.querySelector('#accounts .list[data-prov-conn="anthropic"]')`;
const ROWS = `[...${CARD}.querySelectorAll(":scope > .li.acc")]`;
const DLG = `document.querySelector("dialog.dlg[open]:not([data-leaving])")`;
const MENU = `document.querySelector(".menu:not([data-leaving])")`;
const label = (acts: string[], text: string) => acts.some(a => a === text);

async function open(over: Record<string, any>, provs: object[] = [ANTHROPIC]): Promise<View> {
	acc = over;
	providers = provs;
	calls.length = 0;
	const v = await hub.view({ width: 390, height: 844 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NM.loaded && S`);
	await run(v, `go("accounts")`);
	await waitFor(v, `${ROWS}.length === ${acc.accounts.length}`);
	return v;
}
// What the page has after the next /api/accounts answer: a mutation in the page re-renders from the reply, a test swaps the body and reloads.
const reload = async (v: View, next: Record<string, any>) => {
	acc = next;
	await v.evaluate(`loadAccounts().then(() => 0)`);
	await waitFor(v, `${ROWS}.length === ${next.accounts.length}`);
};
const click = (v: View, target: string) => run(v, `${target}.click()`);
const tap = (v: View, target: string) => run(v, `const t = ${target}; const r = t.getBoundingClientRect(); const o = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true };
	t.dispatchEvent(new PointerEvent("pointerdown", o)); t.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 })); t.dispatchEvent(new MouseEvent("click", o));`);
const main = (i: number) => `${ROWS}[${i}].querySelector(".acc-main")`;
const grip = (i: number) => `${ROWS}[${i}].querySelector(".acc-grip")`;
const acts = () => `[...${DLG}.querySelectorAll(".dact .btn")].map(b => b.textContent.trim())`;
const SWITCH = `${CARD}.querySelector('[role="switch"]')`;

test("자동 전환: the card is the accounts, then the 한도에 걸리면 section (switch, ask, rules, script, one note line); the switch row has no help text", async () => {
	const v = await open(body("auto"));
	const s = await ev<{ lbl: number[]; rowsOnly: boolean; leadSup: number; sw: [string, string]; sel: number; rules: string; lastSup: number; prowLim: number; radiogroup: number; selects: number; text: string; script: [string, string | null] }>(v, `(() => {
		const k = [...${CARD}.children], lbl = k.map((n, i) => (n.className === "li acc-lbl" ? i : -1)).filter(i => i >= 0), lead = k[lbl[1] + 1], sw = lead.querySelector('[role="switch"]'), sr = k.find(n => n.className === "li tap");
		return { lbl, rowsOnly: k.slice(1, lbl[1]).every(n => n.classList.contains("acc")), leadSup: lead.querySelectorAll(".sup").length, sw: [sw.className, sw.getAttribute("aria-checked")], sel: k[lbl[1] + 2].querySelectorAll(".sel").length, rules: k[lbl[1] + 3].textContent,
			lastSup: k[k.length - 1].querySelectorAll(".sup").length, prowLim: ${CARD}.querySelectorAll(".prow-lim").length, radiogroup: ${CARD}.querySelectorAll('[role="radiogroup"]').length, selects: document.querySelectorAll("#accounts select").length, text: ${CARD}.textContent, script: [sr.textContent, sr.getAttribute("title")] };
	})()`);
	expect(s.lbl).toHaveLength(2);
	expect(s.lbl[0]).toBe(0);
	expect(s.rowsOnly).toBe(true);
	expect(s.leadSup).toBe(0);
	expect(s.sel).toBe(1);
	expect(s.rules).toContain("평일 09:00-18:00");
	expect(s.lastSup).toBe(1);
	expect(s.prowLim).toBe(0);
	expect(s.sw).toEqual(["hs-sw", "true"]);
	expect(s.radiogroup).toBe(0);
	expect(s.selects).toBe(0);
	expect(s.text).toContain("전환 규칙");
	expect(s.text).toContain("스크립트");
	expect(s.script[0]).toContain("pick.sh");
	expect(s.script[1]).toBe("/tmp/pick.sh");
	expect(s.text).not.toContain("고정 풀기");
	expect(s.text).not.toContain("고른 계정");
	expect(s.text).not.toContain("고정");
});

test("고정: the switch is off, the help becomes the 고정 text, the 전환 규칙 row stays with 편집 and says the rules rest, the chosen account row has the 사용 중 · 고정 badge, no select", async () => {
	const v = await open(body("pinned"));
	const s = await ev<{ sw: string; swRowSup: number; text: string; rules: string; edit: number; selects: number; first: [string, string]; second: [string, number] }>(v, `(() => {
		const rules = ${CARD}.querySelector('[data-acc-rules="anthropic"]'), [a, b] = ${ROWS};
		return { sw: ${SWITCH}.getAttribute("aria-checked"), swRowSup: ${SWITCH}.closest(".li").querySelectorAll(".sup").length, text: ${CARD}.textContent, rules: rules.textContent, edit: [...rules.querySelectorAll("button")].filter(b => b.textContent.includes("편집")).length,
			selects: document.querySelectorAll("#accounts select").length, first: [a.textContent, a.className], second: [b.textContent, b.querySelectorAll('[class^="tag"]').length] };
	})()`);
	expect(s.sw).toBe("false");
	expect(s.swRowSup).toBe(1);
	expect(s.text).not.toContain("default");
	expect(s.rules).toContain("평일 09:00-18:00");
	expect(s.rules).toContain("고정 중엔 쉬어요");
	expect(s.edit).toBe(1);
	expect(s.text).not.toContain("스크립트");
	expect(s.selects).toBe(0);
	expect(s.first[0]).toContain("사용 중 · 고정");
	expect(s.first[1]).toContain(" on");
	expect(s.second[0]).not.toContain("고정");
	expect(s.second[1]).toBe(0);
});

test("고정: a blocked fixed account says it waits and keeps its badge and limit tag", async () => {
	const blocked = body("pinned", { accounts: [account("default", { current: true, blocked: "rate_limit", blocked_tag: "한도 걸림 · 01:00까지" }), account("teammate-shared")], chosen: { name: "default", label: "default", source: "manual", blocked: "rate_limit", text: "한도에 걸려서 01:00까지 멈춰 있어요. 고정했으니 다른 계정으로 넘어가지 않아요" } });
	const v = await open(blocked);
	const s = await ev<{ text: string; first: string }>(v, `({ text: ${CARD}.textContent, first: ${ROWS}[0].textContent })`);
	expect(s.text).toContain("멈춰 있어요");
	expect(s.first).toContain("사용 중 · 고정");
	expect(s.text).toContain("한도 걸림 · 01:00까지");
});

test("the switch writes PUT /api/accounts/mode: on -> 고정, off -> 자동 전환", async () => {
	const auto = await open(body("auto"));
	await click(auto, SWITCH);
	await calls.until(c => c.length >= 1, 10_000, "mode write from auto");
	expect(calls).toEqual([["/api/accounts/mode", "PUT", { mode: "pinned" }]]);

	const pinned = await open(body("pinned"));
	await click(pinned, SWITCH);
	await calls.until(c => c.length >= 1, 10_000, "mode write from pinned");
	expect(calls).toEqual([["/api/accounts/mode", "PUT", { mode: "auto" }]]);
});

test("고정: tapping another account row fixes it, tapping the fixed one does nothing; 자동 전환 rows open the details instead", async () => {
	const pinned = await open(body("pinned"));
	await click(pinned, main(0));
	await click(pinned, main(1));
	await calls.until(c => c.length >= 1, 10_000, "pin write");
	expect(calls).toEqual([["/api/accounts/mode", "PUT", { mode: "pinned", account: "teammate-shared" }]]);

	const auto = await open(body("auto"));
	await click(auto, main(1));
	await waitFor(auto, DLG);
	expect(await ev<string>(auto, `${DLG}.querySelector(".dtitle").textContent`)).toBe("teammate-shared");
	expect(calls).toEqual([]);
});

test("every account row has its number and a grip; no arrow buttons; ArrowUp/ArrowDown on a grip write PUT /api/accounts/order, the ends do nothing", async () => {
	const three = [account("default", { order: 1, current: true }), account("teammate-shared", { order: 2 }), account("third", { order: 3 })];
	for (const mode of ["auto", "pinned"] as const) {
		const v = await open(body(mode, { accounts: three }));
		const s = await ev<{ nos: string[]; grips: string[]; mvs: number; text: string }>(v, `({ nos: ${ROWS}.map(r => r.querySelector(".acc-no").textContent.trim()), grips: ${ROWS}.map(r => r.querySelector(".acc-grip").dataset.acc), mvs: ${CARD}.querySelectorAll(".acc-mvs").length, text: ${CARD}.textContent })`);
		expect(s.nos).toEqual(["1", "2", "3"]);
		expect(s.grips).toEqual(["default", "teammate-shared", "third"]);
		expect(s.mvs).toBe(0);
		expect(s.text).not.toMatch(/[↑↓]/);
		hub.release();
	}
	const v = await open(body("auto", { accounts: three }));
	const key = (i: number, k: string) => run(v, `${grip(i)}.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
	await key(0, "ArrowUp");
	await key(2, "ArrowDown");
	await key(1, "Enter");
	await key(1, "ArrowUp");
	await calls.until(c => c.length >= 1, 10_000, "order write");
	expect(calls).toEqual([["/api/accounts/order", "PUT", { order: ["teammate-shared", "default", "third"] }]]);
	await key(1, "ArrowDown");
	await calls.until(c => c.length >= 2, 10_000, "second order write");
	expect(calls.at(-1)).toEqual(["/api/accounts/order", "PUT", { order: ["default", "third", "teammate-shared"] }]);
});

test("only an account whose login ran out gets 다시 로그인, on its own row beside the tap area; the other rows and the card have none", async () => {
	const v = await open(body("auto", { accounts: [account("default", { current: true }), account("teammate-shared", { blocked: "auth_error", blocked_tag: "로그인 풀림" })] }));
	const s = await ev<{ okRelogin: number; outRelogin: number; inMain: number; warn: number; card: number }>(v, `(() => {
		const [ok, out] = ${ROWS}, rl = "[data-acc-relogin]";
		return { okRelogin: ok.querySelectorAll(rl).length, outRelogin: out.querySelectorAll(rl).length, inMain: out.querySelector(".acc-main").querySelectorAll(rl).length, warn: out.querySelectorAll(".tag.warn").length, card: ${CARD}.querySelectorAll(rl).length };
	})()`);
	expect(s).toEqual({ okRelogin: 0, outRelogin: 1, inMain: 0, warn: 0, card: 1 });
	await click(v, `${ROWS}[1].querySelector("[data-acc-relogin]")`);
	await calls.until(c => c.length >= 1, 10_000, "login start");
	expect(calls).toEqual([["/api/providers/anthropic/login", "POST", {}]]);
});

test("a limit that only time fixes keeps its warn tag and gets no 다시 로그인; no card row has a trash can or a 쓸 수 있음 tag", async () => {
	const v = await open(body("auto", { accounts: [account("default", { current: true, blocked: "rate_limit", blocked_tag: "한도 걸림 · 01:00까지" }), account("teammate-shared")] }));
	const s = await ev<{ warn: number; relogin: number; ib: number; ok: number }>(v, `({ warn: ${ROWS}[0].querySelectorAll(".tag.warn").length, relogin: ${CARD}.querySelectorAll("[data-acc-relogin]").length, ib: ${CARD}.querySelectorAll(".ib").length, ok: ${CARD}.querySelectorAll(".tag.ok").length })`);
	expect(s).toEqual({ warn: 1, relogin: 0, ib: 0, ok: 0 });
});

test("the stored name default reads as 기본 on the rows and in the 계정 window title, and the stored name is still what the writes use", async () => {
	const v = await open(body("auto"));
	expect(await ev<string>(v, `${CARD}.textContent`)).not.toContain("default");
	await click(v, main(0));
	await waitFor(v, DLG);
	expect(await ev<string>(v, `${DLG}.querySelector(".dtitle").textContent`)).toBe("기본");
	expect(await ev<string[]>(v, `${ROWS}.map(r => r.querySelector(".acc-grip").dataset.acc)`)).toEqual(["default", "teammate-shared"]);
});

test("the only account leaves through 로그아웃 in its window (the card has no trash can); with two accounts the window deletes one instead", async () => {
	const anthropic = { ...ANTHROPIC, can_logout: true };
	const v = await open(body("auto", { accounts: [account("default", { current: true })] }), [anthropic]);
	await click(v, main(0));
	await waitFor(v, DLG);
	const one = await ev<string[]>(v, acts());
	expect(label(one, "로그아웃")).toBe(true);
	expect(label(one, "계정 삭제")).toBe(false);
	await click(v, `[...${DLG}.querySelectorAll(".dact .btn")].find(b => b.textContent.trim() === "로그아웃")`);
	await waitFor(v, `document.querySelector("dialog.dlg.cf[open]")`);
	await click(v, `document.querySelector("dialog.dlg.cf[open] .dact .btn:last-child")`);
	await calls.until(c => c.length >= 1, 10_000, "logout write");
	expect(calls).toEqual([["/api/providers/anthropic/logout", "POST", {}]]);

	await waitFor(v, `!document.querySelector("dialog.dlg[open]")`);
	await reload(v, body("auto"));
	await click(v, main(0));
	await waitFor(v, DLG);
	const two = await ev<string[]>(v, acts());
	expect(label(two, "계정 삭제")).toBe(true);
	expect(label(two, "로그아웃")).toBe(false);
	expect(calls).toHaveLength(1);
});

for (const [lang, said] of [["ko", "고정하거나"], ["en", "can't pin an account"]] as const)
	test(`R10 (${lang}): where the runtime cannot pin an account the card shows a short notice in place of the switch, the limit answer, the rules, the script and the order grips`, async () => {
		setAppLang(lang);
		const off = body("auto", { pin_unavailable: "omp에서는 계정을 고정할 수 없어요" });
		const v = await open(off);
		const s = await ev<{ notice: number; text: string; sw: number; sel: number; rules: number; tap: number; grips: number; rows: number }>(v, `(() => {
			const n = ${CARD}.querySelectorAll("[data-acc-pin-off]");
			return { notice: n.length, text: n[0] ? n[0].textContent : "", sw: ${CARD}.querySelectorAll('[role="switch"]').length, sel: ${CARD}.querySelectorAll(".sel").length, rules: ${CARD}.querySelectorAll("[data-acc-rules]").length,
				tap: ${CARD}.querySelectorAll(".li.tap").length, grips: ${CARD}.querySelectorAll(".acc-grip").length, rows: ${ROWS}.length };
		})()`);
		expect(s.notice).toBe(1);
		expect(s.text).toContain(said);
		expect([s.sw, s.sel, s.rules, s.tap, s.grips, s.rows]).toEqual([0, 0, 0, 0, 0, 2]);
		if (lang !== "ko") return;
		await click(v, main(1));
		await waitFor(v, DLG);
		expect(await ev<string>(v, `${DLG}.querySelector(".dtitle").textContent`)).toBe("teammate-shared");
		expect(await ev<string[]>(v, acts())).not.toContain("이 계정으로 고정");
		expect(calls).toEqual([]);
		await run(v, `${DLG}.close()`);
		await waitFor(v, `!document.querySelector("dialog.dlg[open]")`);
		await reload(v, body("auto", { pin_unavailable: null }));
		expect(await ev<number[]>(v, `[${CARD}.querySelectorAll("[data-acc-pin-off]").length, ${CARD}.querySelectorAll('[role="switch"]').length]`)).toEqual([0, 1]);
	});

const ON_LIMIT = `${CARD}.querySelector('button.sel[aria-label^="물어보기"]')`;
const limitRowText = (v: View) => ev<string>(v, `${ON_LIMIT}.closest(".li").textContent`);
const pickLimit = async (v: View, option: string) => {
	await tap(v, ON_LIMIT);
	await waitFor(v, MENU);
	await tap(v, `[...${MENU}.querySelectorAll(".mi")].find(b => b.textContent.trim() === ${JSON.stringify(option)})`);
	await waitFor(v, `!${MENU}`);
};

test("물어보기: one menu with 한 번 묻기, 기다리기, 자동 전환 shows the saved value; unset is 한 번 묻기", async () => {
	const v = await open(body("pinned", { rules: { on_limit: "wait" } }));
	expect(await ev<number>(v, `${CARD}.querySelectorAll('button.sel[aria-label^="물어보기"]').length`)).toBe(1);
	for (const [saved, shown] of [["wait", "wait"], ["switch", "switch"], [null, ""]] as const) {
		await reload(v, body("pinned", { rules: { on_limit: saved } }));
		expect(await ev<string>(v, `${ON_LIMIT}.value`)).toBe(shown);
	}
	await tap(v, ON_LIMIT);
	await waitFor(v, MENU);
	expect(await ev<string[]>(v, `[...${MENU}.querySelectorAll(".mi")].map(b => b.textContent.trim())`)).toEqual(["한 번 묻기", "기다리기", "자동 전환"]);
});

test("물어보기: a pick writes PUT /api/accounts/on-limit and re-renders; 한 번 묻기 sends null so the next limit asks again", async () => {
	const v = await open(body("pinned", { rules: { on_limit: "wait" } }));
	const before = await limitRowText(v);
	await pickLimit(v, "자동 전환");
	await calls.until(c => c.length >= 1, 10_000, "on-limit write");
	expect(calls).toEqual([["/api/accounts/on-limit", "PUT", { on_limit: "switch" }]]);
	await waitFor(v, `${ON_LIMIT}.closest(".li").textContent !== ${JSON.stringify(before)}`);
	await pickLimit(v, "한 번 묻기");
	await calls.until(c => c.length >= 2, 10_000, "second on-limit write");
	expect(calls.at(-1)).toEqual(["/api/accounts/on-limit", "PUT", { on_limit: null }]);
});
