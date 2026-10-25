import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeHub, json, waitFor, type View } from "./test-web.ts";

// The cards /api/command answers with (hub/control.ts CommandCard), one per command the palette lists.
type Card = { title: string; tone?: string; facts: { label: string; value: string }[]; note?: string; actions?: { label: string; send: string }[]; text: string };
const card = (title: string, facts: Card["facts"] = [], rest: Partial<Card> = {}): Card => ({ title, facts, text: title, ...rest });
const CARDS: Record<string, Card> = {
	"/status": card("상태", [
		{ label: "dotz", value: "대기 중 · 컨텍스트 12% (24k / 200k)" }, { label: "모델", value: "Opus 5.5 · high" }, { label: "세션", value: "3개 · 작업 중 1" },
		{ label: "api", value: "작업 중 · 컨텍스트 40% (80k / 200k)" }, { label: "서브에이전트", value: "Sonnet 5.5 · medium" }, { label: "Discord", value: "연결됨" },
	], { tone: "ok" }),
	"/context": card("컨텍스트", [{ label: "dotz", value: "12% (24k / 200k)" }, { label: "api", value: "40% (80k / 200k) · 압축 중" }], { note: "/compact 로 압축해요" }),
	"/compact": card("dotz 컨텍스트 압축 중", [], { tone: "busy", note: "끝나면 알려드려요" }),
	"/lanes": card("세션", [{ label: "api", value: "작업 중 · Opus 5.5" }, { label: "web", value: "대기 중 · Sonnet 5.5" }, { label: "docs", value: "멈춤 · Sonnet 5.5" }]),
	"/model": card("모델", [{ label: "dotz", value: "anthropic/claude-opus-5-5 · high" }, { label: "새 세션", value: "anthropic/claude-sonnet-5-5 · medium" }, { label: "서브에이전트", value: "anthropic/claude-sonnet-5-5 · low" }],
		{ note: "대상과 모델을 적어서 바꿔요", actions: [{ label: "Opus 5.5", send: "/model orchestrator anthropic/claude-opus-5-5" }, { label: "Sonnet 5.5", send: "/model orchestrator anthropic/claude-sonnet-5-5" }] }),
	"/effort": card("추론 강도 · dotz", [{ label: "지금", value: "high" }, { label: "고를 수 있는 값", value: "off, minimal, low, medium, high, xhigh" }], { actions: [{ label: "medium", send: "/effort orchestrator medium" }] }),
	"/restart": card("api 세션을 다시 시작했어요", [], { tone: "ok" }),
	"/stop": card("api 세션을 멈추는 중", [], { tone: "busy" }),
	"/resume": card("api 세션이 이어져요", [], { tone: "ok" }),
	"/abort": card("dotz 작업을 취소했어요", [], { tone: "ok" }),
};
const HELP = card("명령", [{ label: "상태", value: "/status  봇·세션 상태\n/context  컨텍스트 사용량" }, { label: "세션", value: "/lanes  세션 목록\n/stop  세션 멈추기" }], { note: "인자는 Tab 으로 골라요" });
const FAIL = card("실패", [], { tone: "err", note: "no such session: nope" });

const SNAP = "/tmp/dotz-palette-test";
const hub = fakeHub({
	api: async (req, url) => {
		if (req.method === "POST" && url.pathname === "/api/command") {
			const text = String(((await req.json()) as { text?: string }).text ?? "");
			if (/nope/.test(text)) return Response.json({ error: "no such session: nope", output: FAIL.text, card: FAIL }, { status: 400 });
			const c = text === "/help" ? HELP : CARDS[text.split(/\s+/)[0]!];
			return c ? Response.json({ ok: true, output: c.text, card: c }) : Response.json({ error: "unknown" }, { status: 400 });
		}
		return url.pathname.startsWith("/api/") ? Response.json({}) : new Response("not found", { status: 404 });
	},
});
const base = `${hub.origin}/`;
const open = async (width: number, height: number): Promise<View> => {
	const v = await hub.view({ width, height });
	await v.navigate(base);
	return v;
};
// Opens the palette, types the command, presses Enter in the field (the owner's keyboard path), and waits for the result.
const runPalette = async (v: View, text: string) => {
	await v.evaluate(`document.querySelector("dialog.pal")?.close()`);
	await waitFor(v, `!document.querySelector("dialog.pal")`);
	await v.evaluate(`(() => { openPalette(); const i = document.querySelector(".pal-in"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
	await waitFor(v, `document.querySelector(".pal-out .pal-rt") && document.querySelector(".pal-out .pal-rt").textContent !== "실행 중"`);
};
const shape = async (v: View) => JSON.parse(await v.evaluate(`JSON.stringify({
	pre: document.querySelectorAll("dialog.pal pre").length, out: !document.querySelector(".pal-out").hidden, listHidden: document.querySelector(".pal-list").hidden,
	title: document.querySelector(".pal-rt").textContent, tag: document.querySelector(".pal-rh .tag")?.textContent ?? "", dot: document.querySelector(".pal-rh .dot").className,
	rows: [...document.querySelectorAll(".pal-out .list .li")].map(r => r.textContent), note: document.querySelector(".pal-out .cc-note")?.textContent ?? "",
	acts: [...document.querySelectorAll(".pal-out .cc-act .btn")].map(b => b.textContent), mono: getComputedStyle(document.querySelector(".pal-out")).fontFamily,
	sw: document.documentElement.scrollWidth, dlgR: Math.round(document.querySelector("dialog.pal").getBoundingClientRect().right) })`) as string) as {
	pre: number; out: boolean; listHidden: boolean; title: string; tag: string; dot: string; rows: string[]; note: string; acts: string[]; mono: string; sw: number; dlgR: number;
};

beforeAll(() => { Bun.spawnSync(["mkdir", "-p", SNAP]); });
afterAll(() => hub.stop());

describe("command palette, in a headless browser", () => {
	test("the search says 도구 또는 명령; the 도구 group comes first and the 명령 group last, and the arrow keys walk in that order", async () => {
		const v = await open(1280, 800);
		const m = JSON.parse(await v.evaluate(`(() => { openPalette(); const items = [...document.querySelectorAll(".pal-list .pal-i")]; const heads = [...document.querySelectorAll(".pal-list .ph")].map(n => n.textContent);
			const first = items[0], last = items[items.length - 1];
			const inp = document.querySelector(".pal-in"); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
			const wrapped = document.querySelector(".pal-i.on") === last;
			inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
			return JSON.stringify({ ph: inp.placeholder, heads, firstCmd: first.classList.contains("cmd"), lastCmd: last.classList.contains("cmd"), wrapped, back: document.querySelector(".pal-i.on") === first, order: items.map(n => n.classList.contains("cmd") ? "c" : "t").join("") }); })()`) as string);
		expect(m.ph).toBe("도구 또는 명령");
		expect(m.heads[0]).toBe("도구");
		expect(m.heads.at(-1)).toBe("명령");
		expect(m.heads).not.toContain("이동");
		expect(m).toMatchObject({ firstCmd: false, lastCmd: true, wrapped: true, back: true });
		expect(m.order).toMatch(/^t+c+$/);   // no command row above a tool row
		await Bun.write(`${SNAP}/palette-list-1280.png`, await v.screenshot());
	}, 60_000);

	test("filtering keeps the order: a slash query lists only commands; a word lists tools before commands", async () => {
		const v = await open(1280, 800);
		const m = JSON.parse(await v.evaluate(`(() => { openPalette(); const inp = document.querySelector(".pal-in");
			const run = q => { inp.value = q; inp.dispatchEvent(new Event("input")); return [...document.querySelectorAll(".pal-list .pal-i")].map(n => (n.classList.contains("cmd") ? "c:" : "t:") + n.querySelector(".nm").textContent); };
			return JSON.stringify({ slash: run("/st"), term: run("터미널"), mixed: run("s") }); })()`) as string);
		expect(m.slash).toEqual(["c:/status", "c:/stop"]);
		expect(m.term.some((x: string) => x.startsWith("t:") && x.includes("터미널"))).toBe(true);
		expect(m.term.every((x: string) => x.startsWith("t:"))).toBe(true);
		const kinds = m.mixed.map((x: string) => x[0]).join("");
		expect(kinds).toMatch(/^t+c+$/);
	}, 60_000);

	const CASES: [string, string][] = [["/status", "상태"], ["/context", "컨텍스트"], ["/compact orchestrator", "dotz 컨텍스트 압축 중"], ["/lanes", "세션"], ["/model", "모델"], ["/effort orchestrator", "추론 강도"], ["/restart api", "다시 시작"], ["/stop api", "멈추는 중"], ["/resume api", "이어져요"], ["/abort", "취소했어요"]];
	for (const [cmd, title] of CASES) {
		test(`${cmd} shows as the app's own UI (status line, list rows, note, buttons), never a text dump`, async () => {
			const v = await open(390, 844);
			await runPalette(v, cmd);
			const s = await shape(v);
			const c = CARDS[cmd.split(" ")[0]!]!;
			expect(s.pre).toBe(0);
			expect(s).toMatchObject({ out: true, listHidden: true });
			expect(s.title).toContain(title);
			expect(s.dot).toContain("dot");
			if (c.tone) expect(s.tag).toBe({ ok: "완료", busy: "진행 중" }[c.tone as "ok" | "busy"]);
			expect(s.rows.length).toBe(c.facts.length);
			c.facts.forEach((f, i) => { expect(s.rows[i]).toContain(f.label); expect(s.rows[i]).toContain(f.value.split("\n")[0]!); });   // the data is the same
			expect(s.note).toBe(c.note ?? "");
			expect(s.acts).toEqual((c.actions ?? []).map(a => a.label));
			expect(s.mono).not.toMatch(/^ui-monospace|Menlo/);   // not the terminal-style dump font
			expect(s.sw).toBeLessThanOrEqual(390);
			expect(s.dlgR).toBeLessThanOrEqual(390);
		}, 60_000);
	}

	test("/help groups render as rows with the command in code and its text beside it", async () => {
		const v = await open(1280, 800);
		await runPalette(v, "/help");
		const m = JSON.parse(await v.evaluate(`JSON.stringify({ pre: document.querySelectorAll("dialog.pal pre").length, rows: document.querySelectorAll(".pal-out .li").length, codes: [...document.querySelectorAll(".pal-out .pal-vl code")].map(c => c.textContent) })`) as string);
		expect(m).toMatchObject({ pre: 0, rows: 2, codes: ["/status", "/context", "/lanes", "/stop"] });
	}, 60_000);

	test("a button in a result runs its command in the palette", async () => {
		const v = await open(1280, 800);
		await runPalette(v, "/model");
		// The stub answers "/model ..." with the same 모델 card, so the title alone cannot show the run; only the brief 실행 중
		// state differs, and catching it was a race. Wait for the clicked card to be replaced by a settled one instead.
		await v.evaluate(`(window.__palCard = document.querySelector(".pal-out .pal-res"), document.querySelector(".pal-out .cc-act .btn").click())`);
		await waitFor(v, `!!document.querySelector(".pal-out .pal-res") && !document.querySelector(".pal-out").contains(window.__palCard) && document.querySelector(".pal-out .pal-rt")?.textContent !== "실행 중"`);
		expect(await v.evaluate(`document.querySelectorAll("dialog.pal pre").length`)).toBe(0);
	}, 60_000);

	test("a failed command is an error status with the reason, not a raw message", async () => {
		const v = await open(1280, 800);
		await runPalette(v, "/stop nope");
		const s = await shape(v);
		expect(s).toMatchObject({ pre: 0, title: "실패", tag: "실패", note: "no such session: nope" });
		expect(s.dot).toContain("err");
	}, 60_000);

	test("screenshots: /status, /model and /lanes at 390px and on a desktop width", async () => {
		for (const [w, h] of [[390, 844], [1280, 800]] as const) {
			const v = await open(w, h);
			for (const [cmd, name] of [["/status", "status"], ["/model", "model"], ["/lanes", "lanes"]] as const) {
				await runPalette(v, cmd);
				await Bun.write(`${SNAP}/palette-${name}-${w}.png`, await v.screenshot());
			}
		}
	}, 120_000);
});
