import { afterAll, afterEach, expect, test } from "bun:test";
import { checkRules } from "./account-rules.ts";
import { fakeHub, inbox, json, run, ev, waitFor, type View } from "./test-web.ts";

// 계정 → 전환 규칙 (web/js/25-settings-accounts.js rulesDialog, owner 2026-11-16: "조건부를 제대로 고를 수가 없더라"), the real bundle in a
// headless Bun.WebView against a fake hub whose /api/accounts/rules/check is the hub's own checkRules: a pick in a long account list
// keeps the dialog open, every condition of a rule is its own row (which account + state), the two account pickers have different
// labels, the sentence under the card follows each pick, 저장 sends one provider's rule list only, the rules row stays in 고정, and a
// second subscription provider gets the same dialog.
const LABEL: Record<string, string> = { default: "개인 계정", "work@example.com": "회사 계정", backup: "예비", team: "팀", spare: "여분" };
const GPT: Record<string, string> = { default: "기본", "login-2": "회사용 GPT" };
type State = { names: string[]; mode: "auto" | "pinned"; rules: object; gpt: object };
let S: State = { names: ["default", "work@example.com"], mode: "auto", rules: {}, gpt: {} };
const saves = inbox<Record<string, unknown>>();
const sentence = (r: { rules?: unknown[] }, lab: Record<string, string>) => checkRules(r.rules ?? [], n => lab[n] ?? n).texts.map((text, index) => ({ index, text: text ?? "" }));
const account = (name: string, i: number) => ({ name, order: i + 1, alias: LABEL[name], label: LABEL[name], current: i === 0, blocked: null, blocked_until: null, blocked_tag: null, five_hour_left: 60, seven_day_left: 80 });
const body = () => ({
	providers: [
		{ id: "anthropic", name: "Claude 구독", auth: "oauth", multi: true, can_add: true, can_pin: true, can_delete: true, mode: S.mode, can_rules: true, rules: S.rules, rules_text: sentence(S.rules, LABEL), accounts: S.names.map((n, i) => ({ ...account(n, i), pinned: false, picked: false, windows: [] })) },
		{ id: "chatgpt-subscription", name: "ChatGPT 구독", auth: "oauth", multi: true, can_add: true, can_pin: true, can_delete: true, mode: "auto", can_rules: true, rules: S.gpt, rules_text: sentence(S.gpt, GPT), accounts: [
			{ name: "default", label: "기본", order: 1, current: true, pinned: false, picked: false, blocked: null, blocked_until: null, blocked_tag: null, windows: [] },
			{ name: "login-2", label: "회사용 GPT", order: 2, current: false, pinned: false, picked: false, blocked: null, blocked_until: null, blocked_tag: null, windows: [] },
		] },
	],
	login_providers: [],
	mode: S.mode,
	chosen: { name: "default", label: "개인 계정", source: S.mode === "pinned" ? "manual" : "auto", blocked: null, blocked_until: null, used_instead: null, text: "" },
	accounts: S.names.map(account),
	rules: S.rules,
	rules_text: sentence(S.rules, LABEL),
	script: { path: null, timeout_ms: 5000, every_minutes: 5, last: null },
});
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations" || p === "/api/monitors" || p === "/api/integrations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/update" || p === "/api/runtimes") return json({ error: "stub" }, 500);
		if (p === "/api/providers") return json({ providers: [{ id: "anthropic", name: "Claude 구독", auth: "oauth", can_login: true, can_add_account: true, in_use: true }, { id: "chatgpt-subscription", name: "ChatGPT 구독", auth: "oauth", can_login: true }] });
		if (p === "/api/accounts/rules/check") {
			const b = (await req.json()) as { provider?: string; rules?: unknown[] };
			return json(checkRules(b.rules ?? [], n => (b.provider === "chatgpt-subscription" ? GPT : LABEL)[n] ?? n));
		}
		if (p === "/api/accounts/rules" && req.method === "PUT") {
			const b = (await req.json()) as Record<string, unknown>;
			saves.push(b);
			return json(body());
		}
		if (p.startsWith("/api/accounts")) return json(body());
	},
});
afterEach(() => hub.release());
afterAll(() => hub.stop());

async function open(w: number, h: number, state: Partial<State> = {}): Promise<View> {
	S = { names: ["default", "work@example.com"], mode: "auto", rules: {}, gpt: {}, ...state };
	saves.length = 0;
	const v = await hub.view({ width: w, height: h });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && NM.loaded && S`);
	await run(v, `go("accounts")`);
	await waitFor(v, `document.querySelectorAll("#accounts .li.acc").length >= ${S.names.length}`);
	return v;
}
const DLG = `document.querySelector("dialog.dlg[open]:not([data-leaving])")`;
const editOf = (prov: string) => `[...document.querySelector('#accounts [data-acc-rules="${prov}"]').querySelectorAll(".btn")].find(b => b.textContent.trim() === "편집")`;
// the window slides in; geometry is read once its own motion has ended, as a person sees it
const settled = (v: View) => waitFor(v, `${DLG}.getAnimations().every(a => a.playState !== "running")`);
const openRules = async (v: View, prov = "anthropic") => {
	await run(v, `${editOf(prov)}.click()`);
	await waitFor(v, DLG);
	await settled(v);
};
const sel = (prefix: string, nth = 0) => `[...${DLG}.querySelectorAll("button.sel")].filter(b => (b.getAttribute("aria-label") || "").startsWith(${JSON.stringify(`${prefix}:`)}))[${nth}]`;
const MENU = `document.querySelector(".menu:not([data-leaving])")`;
// a pointer press, release and click at the element's centre, as a finger or a mouse gives them
const tap = (v: View, target: string) => run(v, `const t = ${target}; const r = t.getBoundingClientRect(); const o = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true };
	t.dispatchEvent(new PointerEvent("pointerdown", o)); t.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 })); t.dispatchEvent(new MouseEvent("click", o));`);
const pick = async (v: View, select: string, option: string) => {
	await tap(v, select);
	await waitFor(v, MENU);
	await tap(v, `[...${MENU}.querySelectorAll(".mi")].find(b => b.textContent.trim() === ${JSON.stringify(option)})`);
	await waitFor(v, `!${MENU}`);
};
const say = (v: View, i = 0) => ev<string>(v, `${DLG}.querySelectorAll(".rl-say")[${i}].textContent`);

test("5 accounts at 1440x900: picking the last account keeps the dialog open, the list stays inside it, and the value and the sentence follow", async () => {
	const v = await open(1440, 900, { names: ["default", "work@example.com", "backup", "team", "spare"] });
	await openRules(v);
	await tap(v, `[...${DLG}.querySelectorAll(".btn")].find(b => b.textContent.trim() === "규칙 추가")`);
	await waitFor(v, sel("동작"));
	await pick(v, sel("동작"), "계정 고정");
	await settled(v);
	await tap(v, sel("바꿀 계정"));
	await waitFor(v, MENU);
	await settled(v);
	const inside = await ev<boolean>(v, `(() => { const d = ${DLG}.getBoundingClientRect(); return [...${MENU}.querySelectorAll(".mi")].every(o => { const r = o.getBoundingClientRect(); return r.top >= d.top && r.bottom <= d.bottom; }); })()`);
	expect(inside).toBe(true);
	await tap(v, `[...${MENU}.querySelectorAll(".mi")].at(-1)`);
	await waitFor(v, `!${MENU}`);
	expect(await ev<boolean>(v, `!!${DLG}`)).toBe(true);
	expect(await ev<string>(v, `${sel("바꿀 계정")}.value`)).toBe("spare");
	await waitFor(v, `${DLG}.querySelector(".rl-say").textContent === "항상 여분으로 고정"`);
});

test("a menu option that hangs past the dialog's edge does not close it (the press lands outside the box)", async () => {
	const v = await open(1440, 900, { names: ["default", "work@example.com", "backup", "team", "spare"], rules: { rules: [{ do: { pin: "default" } }] } });
	await openRules(v);
	await tap(v, sel("바꿀 계정"));
	await waitFor(v, MENU);
	// move the open list below the box, as a tall viewport placed it before, and pick its last option there
	await run(v, `const m = ${MENU}, d = ${DLG}.getBoundingClientRect(); m.style.top = (d.bottom + 4) + "px"; m.style.maxHeight = "none";`);
	expect(await ev<boolean>(v, `[...${MENU}.querySelectorAll(".mi")].at(-1).getBoundingClientRect().top > ${DLG}.getBoundingClientRect().bottom`)).toBe(true);
	await tap(v, `[...${MENU}.querySelectorAll(".mi")].at(-1)`);
	await waitFor(v, `!${MENU}`);
	expect(await ev<boolean>(v, `!!${DLG}`)).toBe(true);
	expect(await ev<string>(v, `${sel("바꿀 계정")}.value`)).toBe("spare");
});

test("two conditions are two rows (which account + state); removing one keeps the other, and 저장 sends that provider's rule list only", async () => {
	const rules = { order: ["work@example.com", "default"], on_limit: "wait", rules: [{ name: "근무 시간 한도", when: { days: ["mon", "tue", "wed", "thu", "fri"], conditions: [{ five_hour_left_below: 20 }, { account: "work@example.com", rate_limited: true }] }, do: { pin: "backup" } }] };
	const v = await open(1280, 800, { names: ["default", "work@example.com", "backup"], rules });
	await openRules(v);
	expect(await ev<number>(v, `${DLG}.querySelectorAll(".rl-cond").length`)).toBe(2);
	expect(await ev<string[]>(v, `[...${DLG}.querySelectorAll(".rl-cond")].map(r => [...r.querySelectorAll("button.sel")].map(b => b.querySelector(".val").textContent).join(" / "))`)).toEqual(["지금 쓰는 계정 / 5시간 남은 % 밑", "회사 계정 / 한도 걸림"]);
	await waitFor(v, `${DLG}.querySelector(".rl-say").textContent.includes("회사 계정이 한도에 걸린")`);
	expect(await say(v)).toBe("평일에 5시간 한도가 20% 밑이고 회사 계정이 한도에 걸린 상태면 예비로 고정");
	await tap(v, `${DLG}.querySelector('.rl-cond[data-cond="0"] .rl-x')`);
	expect(await ev<number>(v, `${DLG}.querySelectorAll(".rl-cond").length`)).toBe(1);
	await waitFor(v, `${DLG}.querySelector(".rl-say").textContent === "평일에 회사 계정이 한도에 걸린 상태면 예비로 고정"`);
	await tap(v, `[...${DLG}.querySelectorAll(".dact .btn")].find(b => b.textContent.trim() === "저장")`);
	const [saved] = await saves.until(s => s.length === 1);
	expect(saved).toEqual({ provider: "anthropic", rules: [{ name: "근무 시간 한도", when: { days: ["mon", "tue", "wed", "thu", "fri"], conditions: [{ account: "work@example.com", rate_limited: true }] }, do: { pin: "backup" } }] });
});

test("the condition's account and the action's account are two pickers with their own labels, and the sentence names whose state it is", async () => {
	const v = await open(390, 844, { rules: { rules: [{ do: { pin: "work@example.com" } }] } });
	await openRules(v);
	await tap(v, `${DLG}.querySelector("[data-cond-add]")`);
	await waitFor(v, sel("어느 계정"));
	expect(await ev<string[]>(v, `[...${DLG}.querySelectorAll("button.sel")].map(b => b.getAttribute("aria-label").split(":")[0])`)).toEqual(["어느 계정", "상태", "동작", "바꿀 계정"]);
	await pick(v, sel("어느 계정"), "개인 계정");
	await waitFor(v, `${DLG}.querySelector(".rl-say").textContent === "개인 계정의 5시간 한도가 20% 밑이면 회사 계정으로 고정"`);
	await pick(v, sel("상태"), "못 씀");
	await waitFor(v, `${DLG}.querySelector(".rl-say").textContent === "개인 계정을 못 쓰는 상태면 회사 계정으로 고정"`);
	expect(await ev<number>(v, `document.documentElement.scrollWidth - innerWidth`)).toBeLessThanOrEqual(0);
});

test("고정: the rules row stays with 편집 and says the rules rest until 자동 전환", async () => {
	const v = await open(1280, 800, { mode: "pinned", rules: { rules: [{ do: { pin: "work@example.com" } }] } });
	const row = `document.querySelector('#accounts [data-acc-rules="anthropic"]')`;
	expect(await ev<string>(v, `${row}.textContent`)).toContain("항상 회사 계정으로 고정 · 고정 중엔 쉬어요");
	await openRules(v);
	expect(await ev<number>(v, `${DLG}.querySelectorAll("[data-rule]").length`)).toBe(1);
});

test("ChatGPT 구독 with two accounts has 자동 전환 and 전환 규칙; its dialog says what OmO does and saves with its provider id", async () => {
	const v = await open(1280, 800);
	const list = `document.querySelector('#accounts [data-prov-conn="chatgpt-subscription"]')`;
	expect(await ev<boolean>(v, `!!${list}.querySelector('[role="switch"]')`)).toBe(true);
	await openRules(v, "chatgpt-subscription");
	expect(await ev<string>(v, `${DLG}.querySelector(".dtitle").textContent`)).toBe("전환 규칙 · ChatGPT 구독");
	expect(await ev<string>(v, `${DLG}.querySelector(".dbody").textContent`)).toContain("OmO가 ChatGPT 구독의 다른 계정으로 넘겨요");
	await tap(v, `[...${DLG}.querySelectorAll(".btn")].find(b => b.textContent.trim() === "규칙 추가")`);
	await pick(v, sel("동작"), "계정 고정");
	await pick(v, sel("바꿀 계정"), "회사용 GPT");
	await waitFor(v, `${DLG}.querySelector(".rl-say").textContent === "항상 회사용 GPT로 고정"`);
	await tap(v, `[...${DLG}.querySelectorAll(".dact .btn")].find(b => b.textContent.trim() === "저장")`);
	const [saved] = await saves.until(s => s.length === 1);
	expect(saved).toEqual({ provider: "chatgpt-subscription", rules: [{ do: { pin: "login-2" } }] });
});
