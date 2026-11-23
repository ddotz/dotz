import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { advanceTimers, ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

const SHOTS = process.env.CUSTOM_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const RULE_NAMES = ["하나", "둘", "셋", "넷", "다섯", "여섯", "일곱"];
const rule = (n: string) => ({ title: `규칙 ${n}`, full: `[11-01] 규칙 ${n}의 원문` });
const items = (label: string, n: number) => Array.from({ length: n }, (_, i) => ({ title: `${label} ${i + 1}`, line: `${label} ${i + 1}의 설명` }));
let rules = RULE_NAMES;
let down = false;
const detail = () => ({
	key: "builtin:custom", builtin: true, dir: "~/.dotz/custom",
	groups: [
		{ id: "cards", label: "홈 카드", empty: "아직 만든 카드가 없어요", items: items("카드", 6) },
		{ id: "pins", label: "고정 항목", empty: "사이드바에 고정한 게 없어요", items: items("고정", 3) },
		{ id: "routines", label: "루틴", empty: "아직 만든 루틴이 없어요", items: items("루틴", 3) },
		{ id: "rules", label: "내 규칙", empty: "아직 정한 규칙이 없어요", items: rules.map(rule) },
		{ id: "features", label: "내 기능", empty: "아직 만든 기능이 없어요", items: items("기능", 4) },
		{ id: "identity", label: "말투와 성격", empty: "기본 말투와 성격 그대로예요", items: items("성격", 3) },
	],
});
const builtin = { key: "builtin:custom", name: "커스텀", note: "내 취향대로 바꾼 것", pinned: true, builtin: true, lanes: [] };
const requests: string[] = [];

const hub = fakeHub({
	slowTimers: true,
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [builtin], routines: [], links: [] });
		if (p === "/api/custom/project") {
			requests.push(url.searchParams.get("key") ?? "");
			return down ? json({ error: "down" }, 500) : json(detail());
		}
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/conversations" || p === "/api/monitors" || p === "/api/integrations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/todo" || p === "/api/activity") return json({ items: [] });
		return undefined;
	},
});
afterEach(() => { hub.release(); rules = RULE_NAMES; down = false; requests.length = 0; });
afterAll(() => hub.stop());

async function boot(width: number, height: number, path = "/"): Promise<View> {
	const opened = hub.nextStream();
	const v = await hub.view({ width, height }, path);
	await opened;
	await waitFor(v, `typeof S !== "undefined" && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	return v;
}
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running" || (a.effect && a.effect.getTiming().iterations === Infinity))`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const openCustom = async (v: View) => {
	await run(v, `go("custom")`);
	await waitFor(v, `current === "custom" && document.querySelectorAll("#custom .pmv-sec").length === 6`);
};
const lit = (v: View) => ev<string[]>(v, `[...document.querySelectorAll("#nav .ni.on")].map(b => b.dataset.view)`);

for (const [w, h] of [[390, 844], [1280, 800]] as const) {
	test(`at ${w}px 설정 › 내 규칙·커스텀 draws the six groups, five rules with 더 보기 as the card's last line, and 설정 stays lit`, async () => {
		const v = await boot(w, h);
		await openCustom(v);
		await shot(v, `custom-${w}.png`);
		expect(await ev(v, `document.querySelector("#title").textContent`)).toBe("내 규칙·커스텀");
		expect(await ev(v, `location.hash`)).toBe("#custom");
		expect(await lit(v)).toEqual(["settings"]);
		expect(await ev(v, `[...document.querySelectorAll("#custom .pmv-sec > .sec > span")].map(s => s.textContent)`)).toEqual(["홈 카드", "고정 항목", "루틴", "내 규칙", "내 기능", "말투와 성격"]);
		expect(await ev(v, `[...document.querySelectorAll("#custom .pmv-sec")].map(s => s.querySelectorAll(".list > .li").length)`)).toEqual([6, 3, 3, 5, 4, 3]);
		expect(await ev(v, `[...document.querySelectorAll("#custom .pmv-sec")[3].querySelectorAll(".list > .li")].map(e => e.textContent)`)).toEqual(["규칙 하나", "규칙 둘", "규칙 셋", "규칙 넷", "규칙 다섯"]);
		expect(await ev(v, `document.querySelectorAll("#custom .pmv-sec")[3].querySelector(".list > .cv-more:last-child").textContent`)).toBe("규칙 2개 더 보기");
		expect(await ev(v, `document.querySelectorAll("#custom .pmv-sec")[3].querySelectorAll(".list .btn").length`)).toBe(0);
		expect(await ev(v, `(() => { const c = document.querySelector("#custom .list:has(> .cv-more)"), m = c.querySelector(".cv-more").getBoundingClientRect(); return [m.width === c.clientWidth, m.height >= 44]; })()`)).toEqual([true, true]);
		expect(requests).toEqual(["builtin:custom"]);
	});

	test(`at ${w}px 더 보기 opens every rule with a search, and a rule row closes the page and drops its full text into the main chat's composer`, async () => {
		const v = await boot(w, h);
		await openCustom(v);
		await run(v, `document.querySelector("#custom .cv-more").click()`);
		await waitFor(v, `document.querySelector(".pdv-body #cm-q")`);
		await shot(v, `custom-rules-${w}.png`);
		expect(await ev(v, `document.querySelectorAll(".pdv-body .li").length`)).toBe(7);
		expect(await ev(v, `document.querySelector(".pdv-t").textContent`)).toBe("내 규칙");
		await run(v, `const i = document.querySelector("#cm-q"); i.value = "여섯의 원문"; i.dispatchEvent(new Event("input", { bubbles: true }))`);
		expect(await ev(v, `[...document.querySelectorAll(".pdv-body .li")].map(e => e.textContent)`)).toEqual(["규칙 여섯"]);
		await run(v, `const i = document.querySelector("#cm-q"); i.value = "없는 말"; i.dispatchEvent(new Event("input", { bubbles: true }))`);
		expect(await ev(v, `document.querySelector(".pdv-body .empty").textContent`)).toBe("찾는 규칙이 없어요");
		await run(v, `const i = document.querySelector("#cm-q"); i.value = "여섯의 원문"; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector(".pdv-body .li").click()`);
		await waitFor(v, `!document.querySelector(".fs-card.pdv:not([aria-hidden])") && ta.value.includes("[11-01] 규칙 여섯의 원문")`);
		expect(await ev(v, `[current, target, ta.value.startsWith("[프로젝트 커스텀 · 개인 설정] 내 규칙 ")]`)).toEqual(["chat", "main", true]);
	});

	test(`at ${w}px 추가 and 수정 on a group open the main chat with a draft naming that group or item`, async () => {
		const v = await boot(w, h);
		await openCustom(v);
		await run(v, `document.querySelectorAll("#custom .pmv-sec")[1].querySelector(".sec .btn").click()`);
		await waitFor(v, `current === "chat" && target === "main" && ta.value === "[프로젝트 커스텀 · 개인 설정] 고정 항목: "`);
		await openCustom(v);
		await run(v, `document.querySelectorAll("#custom .pmv-sec")[2].querySelectorAll(".li .btn")[1].click()`);
		await waitFor(v, `current === "chat" && ta.value === '[프로젝트 커스텀 · 개인 설정] 루틴 "루틴 2": '`);
	});

	test(`at ${w}px the 설정 list has the 내 규칙·커스텀 row, it opens the page, and 뒤로 returns to 설정`, async () => {
		const v = await boot(w, h);
		await run(v, `go("settings")`);
		await waitFor(v, `current === "settings" && [...document.querySelectorAll("#settings .li.tap")].some(b => b.textContent.includes("내 규칙·커스텀"))`);
		await shot(v, `settings-row-${w}.png`);
		expect(await ev(v, `[...document.querySelectorAll("#settings .li.tap")].find(b => b.textContent.includes("내 규칙·커스텀")).querySelector(".sup").textContent`)).toBe("내가 바꾼 것을 봐요");
		await run(v, `[...document.querySelectorAll("#settings .li.tap")].find(b => b.textContent.includes("내 규칙·커스텀")).click()`);
		await waitFor(v, `current === "custom" && document.querySelectorAll("#custom .pmv-sec").length === 6`);
		expect(await lit(v)).toEqual(["settings"]);
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `current === "settings"`);
		expect(await ev(v, `location.hash`)).toBe("#settings");
		expect(await lit(v)).toEqual(["settings"]);
	});
}

test("S2: a typed #project/builtin%3Acustom address opens 설정 › 내 규칙·커스텀 and the address becomes #custom", async () => {
	const v = await boot(390, 844);
	await run(v, `location.hash = "#project/builtin%3Acustom"`);
	await waitFor(v, `current === "custom" && document.querySelectorAll("#custom .pmv-sec").length === 6`);
	expect(await ev(v, `location.hash`)).toBe("#custom");
	expect(await ev(v, `document.querySelector("#v-project").hidden`)).toBe(true);
	expect(await lit(v)).toEqual(["settings"]);
});

test("S2: booting on #project/builtin%3Acustom opens 설정 › 내 규칙·커스텀", async () => {
	const v = await boot(390, 844, "/#project/builtin%3Acustom");
	await waitFor(v, `current === "custom" && document.querySelectorAll("#custom .pmv-sec").length === 6`);
	expect(await ev(v, `location.hash`)).toBe("#custom");
});

test("S2: go(\"project\", \"builtin:custom\") from code opens 설정 › 내 규칙·커스텀", async () => {
	const v = await boot(390, 844);
	await run(v, `go("project", "builtin:custom")`);
	await waitFor(v, `current === "custom" && document.querySelectorAll("#custom .pmv-sec").length === 6`);
	expect(await ev(v, `[location.hash, document.querySelector("#v-project").hidden, ppCur]`)).toEqual(["#custom", true, ""]);
});

test("S2: a history entry saved with the old project address opens 설정 › 내 규칙·커스텀 on back", async () => {
	const v = await boot(390, 844);
	await run(v, `go("home"); history.pushState({ dz: 1, c: ["home", "project/builtin%3Acustom"], ov: 0, w: ["home", "project/builtin%3Acustom"] }, "", "#project/builtin%3Acustom"); go("settings")`);
	await waitFor(v, `current === "settings"`);
	await run(v, `history.back()`);
	await waitFor(v, `current === "custom" && document.querySelectorAll("#custom .pmv-sec").length === 6`);
	expect(await ev(v, `location.hash`)).toBe("#custom");
});

test("a failed read says so with 다시 시도, and pressing it draws the page once the gateway answers", async () => {
	down = true;
	const v = await boot(390, 844);
	await run(v, `go("custom")`);
	await waitFor(v, `document.querySelector("#custom .empty .btn")`);
	expect(await ev(v, `document.querySelectorAll("#custom .pmv-sec").length`)).toBe(0);
	down = false;
	await run(v, `document.querySelector("#custom .empty .btn").click()`);
	await waitFor(v, `document.querySelectorAll("#custom .pmv-sec").length === 6`);
});

test("the 20 s refresh follows the gateway, keeps the reader's place, and leaves a search typed in the rules page alone", async () => {
	const v = await boot(390, 844);
	await openCustom(v);
	await run(v, `document.querySelector("#views").scrollTop = 300`);
	const before = await ev<number>(v, `document.querySelector("#views").scrollTop`);
	expect(before).toBeGreaterThan(100);
	rules = [...RULE_NAMES, "여덟", "아홉"];
	await advanceTimers(v, 20_000);
	await waitFor(v, `document.querySelector("#custom .cv-more")?.textContent === "규칙 4개 더 보기"`);
	expect(await ev(v, `document.querySelector("#views").scrollTop`)).toBe(before);
	await run(v, `document.querySelector("#custom .cv-more").click()`);
	await waitFor(v, `document.querySelector(".pdv-body #cm-q")`);
	await run(v, `const i = document.querySelector("#cm-q"); i.focus(); i.value = "여섯"; i.dispatchEvent(new Event("input", { bubbles: true }))`);
	rules = [...RULE_NAMES, "여덟", "아홉", "열"];
	await advanceTimers(v, 20_000);
	await waitFor(v, `document.querySelector("#custom .cv-more")?.textContent === "규칙 5개 더 보기"`);
	expect(await ev(v, `[document.activeElement.id, document.activeElement.value, document.querySelectorAll(".pdv-body .li").length]`)).toEqual(["cm-q", "여섯", 1]);
});

test("the 설정 tab's list asks nothing of the custom page until it is opened", async () => {
	const v = await boot(390, 844);
	await run(v, `go("settings")`);
	await waitFor(v, `current === "settings" && document.querySelector("#settings .li.tap")`);
	await advanceTimers(v, 20_000);
	expect(requests).toEqual([]);
});
