import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, idleState, json, run, type View, waitFor } from "./test-web.ts";

const SHOTS = process.env.FOURTAB_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 9, m)).toISOString();
const work: Record<string, string> = { "7001": "기획팀", "7002": "가격 조사", "7003": "빈 프로젝트" };
const lane = (name: string, title: string, extra: object) => ({ name, title, cwd: "/h/shared", status: "idle", live: true, reports: 1, startedAt: at(1), ...extra });
const lanes = [
	lane("audit", "경쟁사 가격표", { status: "working", home: "ch:7002", startedAt: at(2) }),
	lane("ask", "할인율 확인", { home: "ch:7002", startedAt: at(3), pendingAsk: { text: "몇 퍼센트로 할까요?" } }),
	lane("free", "회의록 정리", { status: "working", startedAt: at(4) }),
	lane("old", "지난 보고", { status: "exited", live: false, home: "ch:7001", finishedAt: at(5) }),
	lane("gone", "오래된 정리", { status: "exited", live: false, finishedAt: at(6) }),
];
const runs = { "lane:audit": { kind: "working" }, "lane:free": { kind: "working" }, "lane:ask": { kind: "waiting", reason: "ask" } };
const projects = [
	{ key: "ch:7001", name: "기획팀", channel: { id: "7001" }, pinned: true, lanes: [] },
	{ key: "ch:7002", name: "가격 조사", channel: { id: "7002" }, lanes: [{ name: "audit", status: "working", live: true }, { name: "ask", status: "idle", live: true, waiting: true }] },
	{ key: "ch:7003", name: "빈 프로젝트", channel: { id: "7003" }, lanes: [] },
];
const conversations = [
	{ target: "ch:7001", unread: 0, last: { ts: at(10), text: "회의 안건 정리했어요", from: "orchestrator" } },
	{ target: "ch:7002", unread: 2, last: { ts: at(20), text: "가격표 모았어요", from: "orchestrator" } },
	{ target: "ch:7003", unread: 0, last: { ts: at(30), text: "시작했어요", from: "orchestrator" } },
	{ target: "lane:audit", unread: 3, last: { ts: at(35), text: "표 두 개 더 모았어요", from: "lane" } },
	{ target: "mail:m1", unread: 1, last: { ts: at(40), text: "견적 부탁드려요" }, mail: { subject: "견적 문의", from: "Kim <kim@example.com>", at: at(40), source: "home", reply: "draft", unreplied: true } },
];
const many = {
	work: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(8000 + i), `프로젝트 ${i}`])),
	lanes: [
		lane("late-ask", "늦은 질문", { home: "ch:8049", startedAt: at(2), pendingAsk: { text: "어느 쪽으로 할까요?" } }),
		lane("late-run", "늦은 작업", { status: "working", home: "ch:8045", startedAt: at(3) }),
	],
	runs: { "lane:late-ask": { kind: "waiting", reason: "ask" }, "lane:late-run": { kind: "working" } },
	projects: Array.from({ length: 50 }, (_, i) => ({ key: `ch:${8000 + i}`, name: `프로젝트 ${i}`, channel: { id: String(8000 + i) }, lanes: [] })),
	conversations: Array.from({ length: 50 }, (_, i) => ({ target: `ch:${8000 + i}`, unread: 0, last: { ts: at(100 - i), text: `소식 ${i}`, from: "orchestrator" } })),
};
const mix = {
	lanes: [
		lane("m-done", "끝난 정리", { home: "ch:7001", startedAt: at(1) }),
		lane("m-held", "한도 작업", { status: "rate-limited", home: "ch:7001", startedAt: at(2) }),
		lane("m-run", "도는 작업", { status: "working", home: "ch:7001", startedAt: at(3) }),
		lane("m-ask", "묻는 작업", { home: "ch:7001", startedAt: at(4), pendingAsk: { text: "이걸로 할까요?" } }),
		lane("m-free", "혼자 도는 작업", { status: "working", startedAt: at(5) }),
		lane("m-free-held", "혼자 멈춘 작업", { status: "rate-limited", startedAt: at(6) }),
	],
	runs: { "lane:m-done": { kind: "done", since: at(7) }, "lane:m-run": { kind: "working" }, "lane:m-ask": { kind: "waiting", reason: "ask" }, "lane:m-free": { kind: "working" } },
};
const posts: Record<string, unknown>[] = [];
let empty = false, mode: "base" | "many" | "mix" = "base", hold: Promise<void> | null = null, notices: unknown[] = [];
const hub = fakeHub({
	stream: "fake",
	state: () => idleState({ channels: { work: empty ? {} : mode === "many" ? many.work : work }, lanes: empty ? [] : mode === "many" ? many.lanes : mode === "mix" ? mix.lanes : lanes, runs: empty ? {} : mode === "many" ? many.runs : mode === "mix" ? mix.runs : runs, discord: { enabled: true } }),
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/projects" && req.method === "POST") {
			const b = (await req.json()) as Record<string, unknown>;
			posts.push(b);
			if (hold) await hold;
			if (b.title === "가") return json({ error: "이름은 두 글자 이상이어야 해요" }, 400);
			work["7009"] = String(b.title);
			return json({ key: "ch:7009", title: b.title });
		}
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: empty ? [] : mode === "many" ? many.projects : projects, routines: [], links: [], errors: [] });
		if (p === "/api/custom/project") return json({ key: url.searchParams.get("key"), monitors: [], lanes: [], work: [], results: [], routines: [], schedules: [], watches: [] });
		if (p === "/api/target") return json({ key: "main", model: "anthropic/claude-sonnet-4", models: [{ selector: "anthropic/claude-sonnet-4", name: "Sonnet 4", provider: "anthropic" }] });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: empty ? [] : mode === "many" ? many.conversations : conversations });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: notices.length, items: notices });
		return undefined;
	},
});
afterEach(() => { hub.release(); empty = false; mode = "base"; hold = null; notices = []; posts.length = 0; delete work["7009"]; });

const open = async (width: number, path = "/#chat/list") => {
	const v = await hub.view({ width, height: 900 }, path);
	await waitFor(v, `CV.loaded && PRJ && PRJ.projects && !S.seeded && !!document.querySelector('#chat-convo [data-k="new-project"]')`);
	return v;
};
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
	await Bun.write(join(SHOTS, name), await v.screenshot());
};
const ORDER = `[...document.querySelectorAll("#chat-convo .cv-sec, #chat-convo .cv-row[data-t], #chat-convo details.ended")].map(n => n.matches(".cv-sec") ? n.firstChild.textContent : n.matches("details") ? "ended" : n.dataset.t)`;
const TREE = ["main", "worklog", "프로젝트", "ch:7001", "ch:7003", "ch:7002", "lane:ask", "lane:audit", "기타 진행 중", "lane:free", "ended"];

test("S6: the list is the fixed rows, the projects pinned first then newest with their live sessions under them (waiting first), 기타 진행 중, then the ended group", async () => {
	const v = await open(390);
	await waitFor(v, `JSON.stringify(${ORDER}) === ${JSON.stringify(JSON.stringify(TREE))}`);
	expect(await ev<string[]>(v, ORDER)).toEqual(TREE);
	expect(await ev<boolean[]>(v, `["lane:ask", "lane:audit"].map(t => document.querySelector('#chat-convo .cv-row[data-t="' + t + '"]').classList.contains("sub"))`)).toEqual([true, true]);
	const row = (t: string) => `(r => ({ dot: r.querySelector(".cv-m2 .dot").className, dotSays: r.querySelector(".cv-m2 .dot").getAttribute("aria-label"), unread: (r.querySelector(".nb") || {}).textContent || "" }))(document.querySelector('#chat-convo .cv-row[data-t="${t}"]'))`;
	expect(await ev(v, row("ch:7002"))).toEqual({ dot: "dot warn", dotSays: "답을 기다려요", unread: "2" });
	expect(await ev(v, row("ch:7003"))).toEqual({ dot: "dot ", dotSays: "세션 없음", unread: "" });
	expect(await ev<string[]>(v, `[...document.querySelectorAll("#chat-convo .cv-row.cv-fold")].map(n => n.dataset.k)`)).toEqual(["fold:ch:7002"]);
	await shot(v, "list-tree-390.png");
	const wide = await open(1280);
	await waitFor(wide, `JSON.stringify(${ORDER}) === ${JSON.stringify(JSON.stringify(TREE))}`);
	await shot(wide, "list-tree-1280.png");
});

test("S6: the mail · KakaoTalk card is gone: no w: row and no 메일 · 카카오톡 header, even with a mail waiting on a reply", async () => {
	const v = await open(1280);
	await waitFor(v, `MAILS.has("mail:m1")`);
	expect(await ev<number>(v, `document.querySelectorAll('#chat-convo [data-k^="w:"]').length`)).toBe(0);
	expect(await ev<string[]>(v, `[...document.querySelectorAll("#chat-convo .cv-sec")].map(n => n.textContent).filter(t => t.includes("메일"))`)).toEqual([]);
});

const fold = (t: string) => `document.querySelector('#chat-convo .cv-row.cv-fold[data-k="fold:${t}"]')`;
const shown = (t: string) => `!!document.querySelector('#chat-convo .cv-row[data-t="${t}"]')`;
const foldSays = (t: string) => `(f => [f.getAttribute("aria-expanded"), [f.querySelector(".cv-n").textContent, f.querySelector(".cv-p").textContent].join(" · "), (f.querySelector(".nb") || {}).textContent || ""])(${fold(t)})`;
const SEQ = `[...document.querySelectorAll("#chat-convo .cv-row")].map(n => n.dataset.t || n.dataset.k)`;

test("S6: a project's fold row sits under it and says what is nested; folding hides all but the waiting session, puts the hidden unread on the fold row, and survives a reload with the computer folds kept", async () => {
	const v = await open(390);
	await run(v, `localStorage.setItem("dotz-pj-fold", JSON.stringify(["다른 맥"]))`);
	await v.navigate(`${hub.origin}/#chat/list`);
	await waitFor(v, `CV.loaded && PRJ && ${shown("lane:audit")}`);
	const seq = await ev<string[]>(v, SEQ);
	expect(seq.slice(seq.indexOf("ch:7002"), seq.indexOf("ch:7002") + 4)).toEqual(["ch:7002", "fold:ch:7002", "lane:ask", "lane:audit"]);
	expect(await ev(v, foldSays("ch:7002"))).toEqual(["true", "세션 2개 · 답을 기다림 1 · 진행 중 1", ""]);
	await run(v, `${fold("ch:7002")}.click()`);
	await waitFor(v, `!${shown("lane:audit")}`);
	expect(await ev(v, `[${shown("lane:ask")}, ${foldSays("ch:7002")}]`)).toEqual([true, ["false", "세션 2개 · 답을 기다림 1 · 진행 중 1", "3"]]);
	await shot(v, "list-folded-390.png");
	await v.navigate(`${hub.origin}/#chat/list`);
	await waitFor(v, `CV.loaded && PRJ && !!${fold("ch:7002")} && ${shown("lane:ask")}`);
	expect(await ev(v, `[${shown("lane:audit")}, ${foldSays("ch:7002")}]`)).toEqual([false, ["false", "세션 2개 · 답을 기다림 1 · 진행 중 1", "3"]]);
	expect((await ev<string[]>(v, `JSON.parse(localStorage.getItem("dotz-pj-fold"))`)).sort()).toEqual(["ch:7002", "다른 맥"].sort());
	await run(v, `${fold("ch:7002")}.click()`);
	await waitFor(v, shown("lane:audit"));
	expect(await ev(v, foldSays("ch:7002"))).toEqual(["true", "세션 2개 · 답을 기다림 1 · 진행 중 1", ""]);
	const wide = await open(1280);
	await run(wide, `${fold("ch:7002")}.click()`);
	await waitFor(wide, `!${shown("lane:audit")} && ${shown("lane:ask")}`);
	await shot(wide, "list-folded-1280.png");
	await run(wide, `localStorage.removeItem("dotz-pj-fold")`);
});

test("S6 at 390: a project row is an ordinary row (its time and badges end at its neighbours' x); its fold row spans the list, is at least 40px tall and indented like its sessions", async () => {
	const v = await open(390);
	await waitFor(v, `${shown("lane:audit")} && ${shown("ch:7001")}`);
	const box = (q: string) => `(r => ({ left: r.left, right: r.right, height: r.height }))(${q}.getBoundingClientRect())`;
	const endRight = (t: string) => `document.querySelector('#chat-convo .cv-row[data-t="${t}"] .cv-m').getBoundingClientRect().right`;
	expect(await ev<number>(v, endRight("ch:7002"))).toBe(await ev<number>(v, endRight("ch:7001")));
	expect(await ev<boolean>(v, `!!${fold("ch:7002")}`)).toBe(true);
	const project = await ev<{ left: number; right: number; height: number }>(v, box(`document.querySelector('#chat-convo .cv-row[data-t="ch:7002"]')`));
	const row = await ev<{ left: number; right: number; height: number }>(v, box(fold("ch:7002")));
	expect([row.left, row.right]).toEqual([project.left, project.right]);
	expect(row.height).toBeGreaterThanOrEqual(40);
	const avLeft = (q: string) => `${q}.querySelector(".cv-av").getBoundingClientRect().left`;
	expect(await ev<number>(v, avLeft(fold("ch:7002")))).toBe(await ev<number>(v, avLeft(`document.querySelector('#chat-convo .cv-row[data-t="lane:ask"]')`)));
	expect(await ev<number>(v, `document.querySelectorAll("#chat-convo .cv-fold:not(.cv-row)").length`)).toBe(0);
});

for (const width of [390, 1280]) {
	test(`S6 at ${width}: the fold row is one row of name and state line, its chevron ends where the plain rows' right column ends, and a tap leaves the focus on it`, async () => {
		const v = await open(width);
		await waitFor(v, `${shown("lane:audit")} && ${shown("ch:7001")}`);
		const lines = `(f => [Math.round(f.querySelector(".cv-n").getBoundingClientRect().height), Math.round(f.querySelector(".cv-p").getBoundingClientRect().height)])(${fold("ch:7002")})`;
		expect(await ev<number[]>(v, lines)).toEqual([18, 16]);
		const lastChild = `(f => getComputedStyle(f, "::after").content !== "none" && f.lastElementChild.classList.contains("cv-m") && getComputedStyle(f.querySelector(".cv-m")).order === "0")(${fold("ch:7002")})`;
		expect(await ev<boolean>(v, lastChild)).toBe(true);
		await run(v, `${fold("ch:7002")}.focus(); ${fold("ch:7002")}.click()`);
		await waitFor(v, `!${shown("lane:audit")}`);
		expect(await ev<string>(v, `document.activeElement.dataset.k || document.activeElement.tagName`)).toBe("fold:ch:7002");
		await run(v, `${fold("ch:7002")}.click()`);
		await waitFor(v, shown("lane:audit"));
		await run(v, `localStorage.removeItem("dotz-pj-fold")`);
	});
}

test("S6: an ended session that is the open conversation keeps a marked row, with or without a project", async () => {
	for (const t of ["lane:gone", "lane:old"]) {
		const v = await open(1280, `/#chat/${t}`);
		await waitFor(v, `target === ${JSON.stringify(t)} && CV.loaded && ${shown(t)}`);
		expect(await ev<string[]>(v, `[...document.querySelectorAll("#chat-convo .cv-row.on")].map(n => n.dataset.t)`)).toEqual([t]);
	}
});

test("S6: with 50 projects, the projects whose session waits or runs are on the first page with their sessions, before 더 보기", async () => {
	mode = "many";
	const v = await open(390);
	await waitFor(v, `!!document.querySelector("#chat-convo .cv-more")`);
	const seq = await ev<string[]>(v, `[...document.querySelectorAll("#chat-convo .cv-row, #chat-convo .cv-more")].map(n => n.matches(".cv-more") ? "more" : n.dataset.t || n.dataset.k)`);
	const more = seq.indexOf("more");
	for (const t of ["ch:8045", "lane:late-run", "ch:8049", "lane:late-ask"]) expect([t, seq.indexOf(t) >= 0 && seq.indexOf(t) < more]).toEqual([t, true]);
	expect(seq.filter(t => t.startsWith("ch:")).length).toBe(42);
});

test("S6: every live session of a project stays under it, waiting, running, 한도 걸림, 완료; the fold row names each part; the project dot takes the most pressing one; 기타 진행 중 keeps only what runs or waits", async () => {
	mode = "mix";
	const v = await open(1280);
	await waitFor(v, `${shown("lane:m-free")} && ${shown("lane:m-done")} && JSON.stringify(${ORDER}).includes('"프로젝트","ch:7001"')`);
	const MIX = ["main", "worklog", "프로젝트", "ch:7001", "lane:m-ask", "lane:m-run", "lane:m-held", "lane:m-done", "ch:7003", "ch:7002", "기타 진행 중", "lane:m-free"];
	expect(await ev<string[]>(v, ORDER)).toEqual(MIX);
	const seq = await ev<string[]>(v, SEQ);
	expect(seq.slice(seq.indexOf("ch:7001"), seq.indexOf("ch:7001") + 6)).toEqual(["ch:7001", "fold:ch:7001", "lane:m-ask", "lane:m-run", "lane:m-held", "lane:m-done"]);
	expect(await ev(v, foldSays("ch:7001"))).toEqual(["true", "세션 4개 · 답을 기다림 1 · 진행 중 1 · 한도 걸림 1 · 완료 1", ""]);
	const four = `[${["m-ask", "m-run", "m-held", "m-done"].map(n => shown(`lane:${n}`)).join(", ")}]`;
	for (const [width, height] of [[390, 844], [1280, 860]] as const) {
		const s = await hub.view({ width, height }, "/#chat/list");
		await waitFor(s, `CV.loaded && PRJ && !!${fold("ch:7001")} && ${shown("lane:m-done")} && ${shown("ch:7003")}`);
		await shot(s, `four-open-${width}.png`);
		await run(s, `${fold("ch:7001")}.click()`);
		await waitFor(s, `!${shown("lane:m-run")}`);
		expect(await ev(s, four)).toEqual([true, false, false, false]);
		await shot(s, `four-folded-${width}.png`);
		await run(s, `localStorage.removeItem("dotz-pj-fold")`);
	}
	const dot = `(d => [d.className, d.getAttribute("aria-label")])(document.querySelector('#chat-convo .cv-row[data-t="ch:7001"] .cv-m2 .dot'))`;
	const drop = async (name: string, want: [string, string]) => {
		await run(v, `S.lanes = S.lanes.filter(l => l.name !== "${name}"); delete S.runs["lane:${name}"]; renderBars()`);
		await waitFor(v, `!${shown(`lane:${name}`)}`);
		expect(await ev(v, dot)).toEqual(want);
	};
	expect(await ev(v, dot)).toEqual(["dot warn", "답을 기다려요"]);
	await drop("m-ask", ["dot pri", "진행 중"]);
	await drop("m-run", ["dot warn", "한도 걸림"]);
	await drop("m-held", ["dot ", "완료"]);
	await drop("m-done", ["dot ", "세션 없음"]);
	expect(await ev<boolean>(v, `!!${fold("ch:7001")}`)).toBe(false);
});

test("S6: a folded project keeps the session whose open decision waits on the owner, and the project counts as waiting", async () => {
	mode = "mix";
	notices = [{ id: "n-dec", kind: "decision", title: "어느 가격표로 할까요?", ts: at(8), text: "", read: false, decision: { state: "open", to: "lane:m-done", options: [{ n: 1, label: "A" }, { n: 2, label: "B" }] } }];
	const v = await open(1280);
	await waitFor(v, `NT.items.length > 0 && ${shown("lane:m-done")} && convNeeds("lane:m-done")`);
	await run(v, `${fold("ch:7001")}.click()`);
	await waitFor(v, `!${shown("lane:m-run")}`);
	expect(await ev(v, `[${["m-ask", "m-run", "m-held", "m-done"].map(n => shown(`lane:${n}`)).join(", ")}]`)).toEqual([true, false, false, true]);
	await run(v, `localStorage.removeItem("dotz-pj-fold")`);
});

test("S6: a nested session row opens that session's chat and is the marked row", async () => {
	const v = await open(1280, "/#chat/main");
	await run(v, `document.querySelector('#chat-convo .cv-row[data-t="lane:ask"]').click()`);
	await waitFor(v, `target === "lane:ask" && current === "chat"`);
	await waitFor(v, `[...document.querySelectorAll('#chat-convo [aria-current="true"]')].map(n => n.dataset.t).join() === "lane:ask"`);
	expect(await ev<boolean>(v, `document.querySelector('#chat-convo .cv-row[data-t="lane:ask"]').classList.contains("on")`)).toBe(true);
});

test("S6: with no project the 프로젝트 header still has + 새 프로젝트 as the shared add button and says in its card that there is none yet", async () => {
	empty = true;
	for (const width of [390, 1280]) {
		const v = await open(width);
		await waitFor(v, `document.querySelector("#chat-convo").textContent.includes("아직 프로젝트가 없어요")`);
		expect(await ev(v, `(b => [b.className, b.parentElement.className, (document.querySelector("#chat-convo .sec-act + .cv-card > .empty") || {}).textContent || ""])(document.querySelector('#chat-convo [data-k="new-project"]'))`)).toEqual(["btn text sm", "cv-sec sec sec-act", "아직 프로젝트가 없어요"]);
		await shot(v, `list-no-project-${width}.png`);
	}
});

const sheet = `document.querySelector("dialog[open]")`;
const openSheet = async (v: View) => {
	await run(v, `document.querySelector('#chat-convo [data-k="new-project"]').click()`);
	await waitFor(v, `!!${sheet} && ${sheet}.innerText.includes("새 프로젝트")`);
};
const createBtn = `[...${sheet}.querySelectorAll(".dact .btn")].find(b => b.textContent === "만들기")`;
for (const width of [390, 1280]) {
	test(`S6 at ${width}: the new-project sheet refuses an empty name without a request, keeps the typed values on a server error, and opens the new project's chat on success`, async () => {
		const v = await open(width);
		await openSheet(v);
		expect(await ev<boolean>(v, `!!${sheet}.querySelector('[data-np="discord"]')`)).toBe(true);
		await shot(v, `sheet-empty-${width}.png`);
		await run(v, `${createBtn}.click()`);
		await waitFor(v, `${sheet}.querySelector(".err-t").textContent === "이름을 적어 주세요"`);
		expect(posts).toEqual([]);
		await run(v, `const s = ${sheet}; s.querySelector('[data-np="name"]').value = "가"; s.querySelector('[data-np="purpose"]').value = "할인 정책 정리"; ${createBtn}.click()`);
		await waitFor(v, `${sheet}.querySelector(".err-t").textContent === "이름은 두 글자 이상이어야 해요" && !${createBtn}.disabled`);
		expect(await ev(v, `[${sheet}.querySelector('[data-np="name"]').value, ${sheet}.querySelector('[data-np="purpose"]').value]`)).toEqual(["가", "할인 정책 정리"]);
		await shot(v, `sheet-error-${width}.png`);
		await run(v, `const n = ${sheet}.querySelector('[data-np="name"]'); n.value = "새 가격표"; n.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
		await waitFor(v, `!document.querySelector("dialog[open]") && location.hash === "#chat/ch:7009"`);
		expect(posts.at(-1)).toEqual({ title: "새 가격표", purpose: "할인 정책 정리" });
		await waitFor(v, `document.activeElement === $("#text")`);
		if (width >= 1100) await waitFor(v, `!!document.querySelector('#chat-convo .cv-row[data-t="ch:7009"]')`);
		else {
			await run(v, `go("chat", "list")`);
			await waitFor(v, `!!document.querySelector('#chat-convo .cv-row[data-t="ch:7009"]')`);
		}
	}, 30_000);
}

test("S6: Esc closes the new-project sheet without creating anything", async () => {
	const v = await open(1280);
	await openSheet(v);
	await run(v, `${sheet}.querySelector('[data-np="name"]').value = "취소할 이름"; ${sheet}.dispatchEvent(new Event("cancel")); ${sheet}.close()`);
	await waitFor(v, `!document.querySelector("dialog[open]")`);
	expect(posts).toEqual([]);
});

test("S6: a new-project sheet closed while the project is being made says once it is made, with a button that opens its chat", async () => {
	const gate = Promise.withResolvers<void>();
	hold = gate.promise;
	const v = await open(1280, "/#chat/main");
	await waitFor(v, `target === "main"`);
	await openSheet(v);
	await run(v, `${sheet}.querySelector('[data-np="name"]').value = "느린 프로젝트"; ${createBtn}.click()`);
	await waitFor(v, `${createBtn}.disabled`);
	await run(v, `${sheet}.dispatchEvent(new Event("cancel")); ${sheet}.close()`);
	await waitFor(v, `!document.querySelector("dialog[open]")`);
	gate.resolve();
	await v.evaluate(`new Promise(res => { let frames = 0; const tick = () => (document.querySelector(".snack.act") || ++frames > 180 ? res(0) : requestAnimationFrame(tick)); tick(); })`);
	expect(await ev(v, `[(document.querySelector(".snack.act span") || {}).textContent || "", (document.querySelector(".snack.act .sa") || {}).textContent || "", location.hash]`)).toEqual(["'느린 프로젝트' 프로젝트를 만들었어요", "대화 열기", "#chat/main"]);
	await run(v, `document.querySelector(".snack.act .sa").click()`);
	await waitFor(v, `location.hash === "#chat/ch:7009" && target === "ch:7009"`);
});

test("S6: a new-project sheet closed while the project is being made says so when the server refuses it", async () => {
	const gate = Promise.withResolvers<void>();
	hold = gate.promise;
	const v = await open(1280, "/#chat/main");
	await waitFor(v, `target === "main"`);
	await openSheet(v);
	await run(v, `${sheet}.querySelector('[data-np="name"]').value = "가"; ${createBtn}.click()`);
	await waitFor(v, `${createBtn}.disabled`);
	await run(v, `${sheet}.dispatchEvent(new Event("cancel")); ${sheet}.close()`);
	await waitFor(v, `!document.querySelector("dialog[open]")`);
	gate.resolve();
	await v.evaluate(`new Promise(res => { let frames = 0; const tick = () => (document.querySelector(".snack") || ++frames > 180 ? res(0) : requestAnimationFrame(tick)); tick(); })`);
	expect(await ev(v, `[(document.querySelector(".snack") || {}).textContent || "", location.hash]`)).toEqual(["'가' 프로젝트를 만들지 못했어요: 이름은 두 글자 이상이어야 해요", "#chat/main"]);
});

test("S6: a saved pane state or named layout holding a mail or KakaoTalk pane loads without it and without an error", async () => {
	const errors: string[] = [];
	const v = await hub.view({ width: 1400, height: 900, console: (type, ...args) => { if (type === "error") errors.push(args.map(String).join(" ")); } });
	await v.navigate(`${hub.origin}/#chat/list`);
	const saved = { root: { dir: "row", a: { id: "p1", kind: "chat", t: "main" }, b: { id: "p2", kind: "chat", t: "mail:m1" }, r: 0.5 }, active: "p1", seq: 2 };
	const kakao = { root: { dir: "row", a: { id: "p1", kind: "chat", t: "worklog" }, b: { id: "p3", kind: "app", t: "i:kakao#kk:77" }, r: 0.5 }, active: "p3" };
	await run(v, `localStorage.setItem("dotz-panes", ${JSON.stringify(JSON.stringify(saved))}); localStorage.setItem("dotz-pane-layouts", ${JSON.stringify(JSON.stringify({ 카톡: kakao }))})`);
	await v.navigate(`${hub.origin}/#chat/main`);
	await waitFor(v, `target === "main" && CV.loaded && typeof paneList === "function"`);
	expect(await ev(v, `[paneCount(), paneList().map(p => p.t).filter(t => t.startsWith("mail:")), document.querySelectorAll("#split .pane").length]`)).toEqual([1, [], 0]);
	await run(v, `paneLayoutApply("카톡")`);
	await waitFor(v, `target === "worklog"`);
	expect(await ev<number>(v, `paneCount()`)).toBeLessThan(2);
	expect(errors).toEqual([]);
});
