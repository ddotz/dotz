// The custom layer (hub/custom.ts): cards and pins read from <DATA_DIR>/custom, data commands with a cache, the pure
// projects view, routine schedules and the HTTP routes. The fake clock (test-setup) moves time; no real waiting.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { DATA_DIR } from "./config.ts";
import { type CustomDeps, customRoute, type DetailInput, projectDetailView, projectsView, readCards, readPins, reportHead, settleRefreshes, syncRoutineSchedules } from "./custom.ts";
import { advance, clock } from "./runtime/test-clock.ts";
import { addSchedule, listSchedules, removeSchedule } from "./schedule.ts";

const CUSTOM = join(DATA_DIR, "custom");
const WORK = join(process.env.DOTZ_TEST_DIR!, "custom-work");
let sent: Array<{ target: string; text: string; login: string }>;
const deps: CustomDeps = { lanes: () => [], channels: () => ({}), send: async (target, text, login) => void sent.push({ target, text, login }) };

const card = (id: string, spec: unknown) => {
	mkdirSync(join(CUSTOM, "cards"), { recursive: true });
	writeFileSync(join(CUSTOM, "cards", `${id}.json`), typeof spec === "string" ? spec : JSON.stringify(spec));
};
const pins = (p: unknown) => {
	mkdirSync(CUSTOM, { recursive: true });
	writeFileSync(join(CUSTOM, "pins.json"), typeof p === "string" ? p : JSON.stringify(p));
};
const call = async (method: string, path: string, body?: unknown, d: CustomDeps = deps) => {
	const url = new URL(`http://hub${path}`);
	return customRoute(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), url, d);
};
const json = async (res: Response | undefined) => (await res!.json()) as any;
const cardOf = async (id: string) => (await json(await call("GET", "/api/custom"))).cards.find((c: any) => c.id === id);

beforeEach(() => {
	sent = [];
	rmSync(CUSTOM, { recursive: true, force: true });
	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });
	for (const s of listSchedules()) if (s.text.startsWith("[routine:") || s.text === "plain-untouched") removeSchedule(s.id);
});

// ---- cards ----
test("a valid card keeps its fields and defaults", async () => {
	card("disk", { title: "디스크", note: "맥 내장", view: "stat", text: "1T", link: "#lanes", order: 2, extra: "ignored" });
	const res = await json(await call("GET", "/api/custom"));
	expect(res.dir).toEndWith("/custom");
	expect(res.cards).toEqual([{ id: "disk", title: "디스크", note: "맥 내장", view: "stat", link: "#lanes", order: 2, render: false, rev: "0", actions: [], data: "1T" }]);
	expect(res.errors).toEqual([]);
});

test("a missing custom folder is an empty layer", async () => {
	expect(await json(await call("GET", "/api/custom"))).toMatchObject({ cards: [], projects: [], routines: [], links: [], errors: [] });
});

test("broken JSON, a bad id and a missing title come back as {id,file,error}", async () => {
	card("broken", "{nope");
	card("Bad_ID", { title: "x" });
	card("notitle", { note: "n" });
	card("longview", { title: "x", view: "chart" });
	const bad = (await json(await call("GET", "/api/custom"))).cards;
	expect(bad.map((c: any) => c.id).sort()).toEqual(["Bad_ID", "broken", "longview", "notitle"]);
	for (const c of bad) expect(Object.keys(c).sort()).toEqual(["error", "file", "id"]);
	expect(bad.find((c: any) => c.id === "broken").file).toBe("cards/broken.json");
});

test("cards sort by order then id; more than 30 are cut with an error", async () => {
	card("b", { title: "b", order: 1 });
	card("a", { title: "a", order: 1 });
	card("z", { title: "z", order: -1 });
	expect((await json(await call("GET", "/api/custom"))).cards.map((c: any) => c.id)).toEqual(["z", "a", "b"]);
	for (let i = 0; i < 31; i++) card(`m${String(i).padStart(2, "0")}`, { title: "m" });
	const errors: { file: string; error: string }[] = [];
	expect(readCards(errors)).toHaveLength(30);
	expect(errors).toHaveLength(4);
});

test("a folder card with render.js reports render true and the file mtime as rev", async () => {
	mkdirSync(join(CUSTOM, "cards", "fancy"), { recursive: true });
	writeFileSync(join(CUSTOM, "cards", "fancy", "card.json"), JSON.stringify({ title: "fancy", text: "hi" }));
	writeFileSync(join(CUSTOM, "cards", "fancy", "render.js"), "export default () => 'x';\n");
	const c = await cardOf("fancy");
	expect(c.render).toBe(true);
	expect(c.rev).toMatch(/^\d{9,}$/);
	const res = await call("GET", "/api/custom/render?id=fancy");
	expect(res!.status).toBe(200);
	expect(res!.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
	expect(res!.headers.get("cache-control")).toBe("no-cache");
	expect(await res!.text()).toBe("export default () => 'x';\n");
});

test("render route is 404 without a render.js or with a path-like id", async () => {
	card("plain", { title: "p" });
	expect((await call("GET", "/api/custom/render?id=plain"))!.status).toBe(404);
	expect((await call("GET", "/api/custom/render?id=../pins"))!.status).toBe(404);
	expect((await call("GET", "/api/custom/render"))!.status).toBe(404);
});

// ---- data commands ----
test("the data command output is parsed as JSON, else kept as text", async () => {
	card("j", { title: "j", command: `echo '{"value": 42}'` });
	card("t", { title: "t", command: "echo '  hello  '" });
	expect((await cardOf("j")).data).toEqual({ value: 42 });
	const t = await cardOf("t");
	expect(t.data).toBe("hello");
	expect(t.updated).toMatch(/^\d{4}-\d\d-\d\dT/);
	expect(t.error).toBeUndefined();
});

test("a non-zero exit keeps the last good data as stale and reports the output tail", async () => {
	card("flaky", { title: "f", cwd: WORK, command: "if [ -f flag ]; then echo boom; exit 3; fi; echo good" });
	expect((await cardOf("flaky")).data).toBe("good");
	writeFileSync(join(WORK, "flag"), "");
	const res = await json(await call("POST", "/api/custom/refresh", { id: "flaky" }));
	expect(res).toMatchObject({ id: "flaky", data: "good", stale: true, error: "boom" });
});

test("a failing first run has an error and no data", async () => {
	card("dead", { title: "d", command: "echo nope >&2; exit 1" });
	const c = await cardOf("dead");
	expect(c.error).toBe("nope");
	expect(c.data).toBeUndefined();
	expect(c.stale).toBeUndefined();
});

test("a command that runs past timeout_seconds is killed and reported", async () => {
	card("slow", { title: "s", command: "sleep 30", timeout_seconds: 1 });
	const pending = call("GET", "/api/custom");
	await advance(1500);
	const c = (await json(await pending)).cards[0];
	expect(c.error).toContain("killed after 1 s");
	expect(c.data).toBeUndefined();
});

test("the command runs once within every_minutes and again after it (background), and POST refresh forces a run", async () => {
	const start = clock.now;
	card("count", { title: "c", cwd: WORK, command: "echo x >> n.txt; wc -l < n.txt", every_minutes: 10 });
	const runs = () => readFileSync(join(WORK, "n.txt"), "utf8").trim().split("\n").length;
	await cardOf("count");
	expect((await cardOf("count")).data).toBe(1);
	expect(runs()).toBe(1);
	try {
		clock.now = start + 11 * 60_000;
		expect((await cardOf("count")).data).toBe(1);
		await settleRefreshes();
		expect(runs()).toBe(2);
		expect((await cardOf("count")).data).toBe(2);
		expect((await json(await call("POST", "/api/custom/refresh", { id: "count" }))).data).toBe(3);
		expect((await call("POST", "/api/custom/refresh", { id: "nope" }))!.status).toBe(404);
	} finally {
		clock.now = start;
	}
});

test("two concurrent GETs share one run", async () => {
	card("once", { title: "o", cwd: WORK, command: "echo x >> n.txt; echo ok" });
	await Promise.all([call("GET", "/api/custom"), call("GET", "/api/custom")]);
	expect(readFileSync(join(WORK, "n.txt"), "utf8").trim().split("\n")).toHaveLength(1);
});

// ---- card actions ----
test("actions are listed without their command text; a bad action invalidates the card", async () => {
	card("act", { title: "a", actions: [{ label: "정리", command: "rm -rf /nope", confirm: true }, { label: "묻기", prompt: "왜 찼어?" }] });
	card("both", { title: "b", actions: [{ label: "x", command: "true", prompt: "p" }] });
	card("none", { title: "n", actions: [{ label: "x" }] });
	card("many", { title: "m", actions: Array.from({ length: 5 }, () => ({ label: "x", command: "true" })) });
	card("label", { title: "l", actions: [{ label: "", command: "true" }] });
	const cards = (await json(await call("GET", "/api/custom"))).cards;
	const by = (id: string) => cards.find((c: any) => c.id === id);
	expect(by("act").actions).toEqual([{ label: "정리", kind: "command", confirm: true }, { label: "묻기", kind: "prompt" }]);
	expect(JSON.stringify(by("act"))).not.toContain("rm -rf");
	for (const id of ["both", "none", "many", "label"]) expect(Object.keys(by(id)).sort()).toEqual(["error", "file", "id"]);
});

test("a command action runs in the card cwd, then the card data is re-run", async () => {
	card("act", { title: "a", cwd: WORK, command: "cat count 2>/dev/null || echo 0", actions: [{ label: "올리기", command: "echo 1 > count; echo done" }, { label: "실패", command: "echo bad; exit 2" }] });
	expect((await cardOf("act")).data).toBe(0);
	const ok = await json(await call("POST", "/api/custom/action", { id: "act", index: 0 }));
	expect(ok).toMatchObject({ ok: true, code: 0, output: "done" });
	expect(ok.card.data).toBe(1);
	expect(await json(await call("POST", "/api/custom/action", { id: "act", index: 1 }))).toMatchObject({ ok: false, code: 2, output: "bad" });
});

test("a prompt action goes to the orchestrator as '[카드 <title>] <prompt>'; unknown id or index is 404", async () => {
	card("ask", { title: "디스크", actions: [{ label: "묻기", prompt: "왜 찼어?" }] });
	expect(await json(await call("POST", "/api/custom/action", { id: "ask", index: 0 }))).toEqual({ ok: true });
	expect(sent).toEqual([{ target: "main", text: "[카드 디스크] 왜 찼어?", login: "local" }]);
	expect((await call("POST", "/api/custom/action", { id: "ask", index: 1 }))!.status).toBe(404);
	expect((await call("POST", "/api/custom/action", { id: "ask", index: "0" }))!.status).toBe(404);
	expect((await call("POST", "/api/custom/action", { id: "nope", index: 0 }))!.status).toBe(404);
});

// ---- pins ----
test("pins validation drops a bad entry with its own error and keeps the rest", () => {
	pins({
		projects: [{ name: "ok", path: "~/Code/ok" }, { path: "~/x" }, { name: "empty" }, { name: "chan", channel: "123" }],
		hide_projects: ["dir:~/Code/old", 5],
		routines: [
			{ id: "good", name: "g", prompt: "p", schedule: { at: "09:00" } },
			{ id: "Bad Id", name: "b", prompt: "p" },
			{ id: "both", name: "b", prompt: "p", schedule: { at: "09:00", every_minutes: 10 } },
			{ id: "fast", name: "b", prompt: "p", schedule: { every_minutes: 1 } },
			{ id: "good", name: "dup", prompt: "p" },
		],
		links: [{ name: "cf", url: "https://dash.cloudflare.com" }, { name: "ftp", url: "ftp://x" }],
	});
	const { pins: p, errors } = readPins({ sync: false });
	expect(p.projects.map(x => x.name)).toEqual(["ok", "chan"]);
	expect(p.hide_projects).toEqual(["dir:~/Code/old"]);
	expect(p.routines).toEqual([{ id: "good", name: "g", prompt: "p", target: "main", schedule: { at: "09:00" } }]);
	expect(p.links).toEqual([{ name: "cf", url: "https://dash.cloudflare.com" }]);
	expect(errors).toHaveLength(8);
	expect(errors.every(e => e.file === "pins.json" && e.error)).toBe(true);
});

test("a pins.json that does not parse gives one error and empty pins; auto projects still list", async () => {
	pins("{oops");
	const lanes = [{ name: "a", cwd: "/Users/zed/Code/auto", status: "idle", startedAt: "2026-10-01T00:00:00Z" }];
	const res = await json(await call("GET", "/api/custom", undefined, { ...deps, lanes: () => lanes }));
	expect(res.errors).toHaveLength(1);
	expect(res.errors[0].file).toBe("pins.json");
	expect([res.routines, res.links]).toEqual([[], []]);
	expect(res.projects.map((p: any) => p.name)).toEqual(["auto"]);
});

// ---- projects ----
const HOME = "/Users/h";
const lane = (name: string, cwd: string, startedAt?: string, extra: Record<string, unknown> = {}) => ({ name, cwd, status: "idle", live: false, reports: 0, lastText: "", ...(startedAt ? { startedAt } : {}), ...extra });
const view = (input: Parameters<typeof projectsView>[0]) => projectsView({ home: HOME, tmpDirs: ["/tmp", "/private/tmp", "/var/folders"], ...input });
const noPins = { projects: [], hide_projects: [], routines: [], links: [] };

test("projectsView groups lanes by cwd, homes channel, orphan work channel, pins merge, hide and order", () => {
	const out = view({
		lanes: [
			lane("a", `${HOME}/Code/dotz`, "2026-10-01T00:00:00Z", { live: true, reports: 2, lastText: "x".repeat(400) }),
			lane("b", `${HOME}/Code/dotz/`, "2026-10-03T00:00:00Z"),
			lane("c", `${HOME}/Code/old`, "2026-10-02T00:00:00Z"),
			lane("d", `${HOME}/Code/solo`, "2026-10-04T00:00:00Z"),
			lane("t1", "/tmp/scratch", "2026-10-05T00:00:00Z"),
			lane("t2", "/var/folders/zz/y", "2026-10-05T00:00:00Z"),
		],
		channels: { work: { "100": "solo-ch", "200": "orphan" }, homes: { d: "100" }, lanes: { a: "900" } },
		pins: { ...noPins, projects: [{ name: "Pinned dotz", path: "~/Code/dotz", note: "n" }, { name: "Manual", path: "~/Code/manual" }, { name: "Chan only", channel: "300" }], hide_projects: ["dir:~/Code/old"] },
	});
	expect(out.map(p => p.key)).toEqual(["dir:~/Code/dotz", "dir:~/Code/manual", "ch:300", "dir:~/Code/solo", "ch:200"]);
	const [dotz, manual, chan, solo, orphan] = out;
	expect(dotz).toMatchObject({ name: "Pinned dotz", path: "~/Code/dotz", note: "n", pinned: true });
	expect(dotz.lanes.map(l => l.name)).toEqual(["b", "a"]);
	expect(dotz.lanes[1]).toEqual({ name: "a", status: "idle", live: true, startedAt: "2026-10-01T00:00:00Z", lastText: "x".repeat(300), reports: 2, channel: "900" });
	expect(manual).toMatchObject({ pinned: true, lanes: [] });
	expect(chan).toMatchObject({ name: "Chan only", pinned: true, channel: { id: "300", name: "300" } });
	expect(solo).toMatchObject({ name: "solo-ch", pinned: false, channel: { id: "100", name: "solo-ch" } });
	expect(orphan).toMatchObject({ name: "orphan", pinned: false, channel: { id: "200", name: "orphan" }, lanes: [] });
});

test("projectsView puts a worktree lane under the checkout it works for", () => {
	const out = view({ lanes: [lane("w", `${HOME}/.dotz/lanes/w/worktree`, "2026-10-01T00:00:00Z", { repo: `${HOME}/Code/dotz` })], channels: {}, pins: noPins });
	expect(out.map(p => [p.key, p.name, p.lanes.map(l => l.name)])).toEqual([["dir:~/Code/dotz", "dotz", ["w"]]]);
});

test("projectsView merges a pin by channel id, folds an orphan channel into a path pin, never hides pinned", () => {
	const lanes = [lane("d", `${HOME}/Code/solo`, "2026-10-04T00:00:00Z")];
	const channels = { work: { "100": "solo-ch", "200": "orphan" }, homes: { d: "100" } };
	const byChannel = view({ lanes, channels, pins: { ...noPins, projects: [{ name: "Solo!", channel: "100" }], hide_projects: ["dir:~/Code/solo"] } });
	expect(byChannel.map(p => [p.key, p.name, p.pinned])).toEqual([["dir:~/Code/solo", "Solo!", true], ["ch:200", "orphan", false]]);
	const folded = view({ lanes: [lane("x", `${HOME}/Code/x`, "2026-10-01T00:00:00Z")], channels, pins: { ...noPins, projects: [{ name: "X", path: "~/Code/x", channel: "200" }] } });
	expect(folded.map(p => p.key)).toEqual(["dir:~/Code/x", "ch:100"]);
	expect(folded[0]).toMatchObject({ name: "X", path: "~/Code/x", channel: { id: "200", name: "orphan" } });
	const chanOnly = view({ lanes: [], channels, pins: { ...noPins, projects: [{ name: "Y", path: "~/Code/y", channel: "200" }] } });
	expect(chanOnly[0]).toMatchObject({ key: "ch:200", name: "Y", path: "~/Code/y", pinned: true });
});

test("projectsView lists at most 12 auto projects, newest first, home as ~", () => {
	const lanes = Array.from({ length: 15 }, (_, i) => lane(`l${i}`, `${HOME}/p${String(i).padStart(2, "0")}`, `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
	const out = view({ lanes: [...lanes, lane("home", HOME, "2026-10-30T00:00:00Z")], channels: {}, pins: noPins });
	expect(out).toHaveLength(12);
	expect(out[0]).toMatchObject({ key: "dir:~", path: "~" });
	expect(out[1].key).toBe("dir:~/p14");
});

// ---- routine schedules ----
const routineEntries = () => listSchedules().filter(s => s.text.startsWith("[routine:"));
const nextKst = (now: number, hh: number, mm: number) => {
	const day = 86_400_000;
	const t = Math.floor((now + 9 * 3_600_000) / day) * day + (hh * 60 + mm) * 60_000 - 9 * 3_600_000;
	return t <= now ? t + day : t;
};

test("routine sync adds one entry per scheduled routine with the contract tag, text and times", () => {
	const at = { id: "morning", name: "아침 점검", prompt: "훑어줘", target: "main", schedule: { at: "09:00" } };
	pins({ routines: [{ ...at }, { id: "poll", name: "폴링", prompt: "봐줘", schedule: { every_minutes: 30 } }, { id: "manual", name: "수동", prompt: "p" }] });
	syncRoutineSchedules();
	const now = Date.now();
	const [a, b] = routineEntries();
	expect(routineEntries()).toHaveLength(2);
	const hash = createHash("sha1").update(JSON.stringify(at)).digest("hex").slice(0, 6);
	expect(a.text).toBe(`[routine:morning:${hash}] 아침 점검\n훑어줘`);
	expect(Date.parse(a.at)).toBe(nextKst(now, 9, 0));
	expect(a.every_minutes).toBe(1440);
	expect(b.text).toMatch(/^\[routine:poll:[0-9a-f]{6}\] 폴링\n봐줘$/);
	expect(Date.parse(b.at)).toBe(now + 30 * 60_000);
	expect(b.every_minutes).toBe(30);
});

test("routine sync is idempotent, replaces on a hash change and removes what is no longer wanted", () => {
	const r = { id: "r1", name: "n", prompt: "one", schedule: { at: "09:00" } };
	pins({ routines: [r] });
	syncRoutineSchedules();
	const first = routineEntries();
	syncRoutineSchedules();
	expect(routineEntries()).toEqual(first);
	pins({ routines: [{ ...r, prompt: "two" }] });
	syncRoutineSchedules();
	const changed = routineEntries();
	expect(changed).toHaveLength(1);
	expect(changed[0].id).not.toBe(first[0].id);
	expect(changed[0].text).toContain("\ntwo");
	pins({ routines: [{ id: "r1", name: "n", prompt: "two" }] });
	syncRoutineSchedules();
	expect(routineEntries()).toEqual([]);
	pins({ routines: [{ ...r }] });
	syncRoutineSchedules();
	expect(routineEntries()).toHaveLength(1);
	rmSync(join(CUSTOM, "pins.json"));
	syncRoutineSchedules();
	expect(routineEntries()).toEqual([]);
});

test("routine sync never touches schedules that do not start with [routine:", () => {
	const plain = addSchedule({ text: "plain-untouched", in_minutes: 60 });
	const lookalike = addSchedule({ text: "routine:x is just text", in_minutes: 60 });
	pins({ routines: [{ id: "r1", name: "n", prompt: "p", schedule: { every_minutes: 5 } }] });
	syncRoutineSchedules();
	pins({});
	syncRoutineSchedules();
	const ids = listSchedules().map(s => s.id);
	expect(ids).toContain(plain.id);
	expect(ids).toContain(lookalike.id);
	removeSchedule(lookalike.id);
	expect(routineEntries()).toEqual([]);
});

test("GET /api/custom syncs when pins.json changed and lists routines with their next run", async () => {
	pins({ routines: [{ id: "daily", name: "매일", prompt: "p", schedule: { at: "09:00" } }], links: [{ name: "cf", url: "https://x.example" }] });
	const res = await json(await call("GET", "/api/custom"));
	expect(res.links).toEqual([{ name: "cf", url: "https://x.example" }]);
	expect(res.routines).toEqual([{ id: "daily", name: "매일", prompt: "p", target: "main", schedule: { at: "09:00" }, next: routineEntries()[0].at }]);
	expect(existsSync(join(CUSTOM, "pins.json"))).toBe(true);
});

// ---- routine run ----
test("POST /api/custom/routine sends '[루틴 <name>] <prompt>' to main or the lane; unknown id is 404", async () => {
	pins({ routines: [{ id: "m", name: "점검", prompt: "훑어줘" }, { id: "l", name: "레인", prompt: "상태", target: "lane:alpha" }] });
	expect(await json(await call("POST", "/api/custom/routine", { id: "m" }))).toEqual({ ok: true });
	expect(await json(await call("POST", "/api/custom/routine", { id: "l" }))).toEqual({ ok: true });
	expect(sent).toEqual([{ target: "main", text: "[루틴 점검] 훑어줘", login: "local" }, { target: "lane:alpha", text: "[루틴 레인] 상태", login: "local" }]);
	expect((await call("POST", "/api/custom/routine", { id: "ghost" }))!.status).toBe(404);
	const failing: CustomDeps = { ...deps, send: async () => Promise.reject(new Error("no lane")) };
	const res = await call("POST", "/api/custom/routine", { id: "l" }, failing);
	expect([res!.status, (await json(res)).error]).toEqual([409, "no lane"]);
});

test("customRoute ignores paths and methods that are not its own", async () => {
	expect(await call("GET", "/api/state")).toBeUndefined();
	expect(await call("DELETE", "/api/custom/refresh")).toBeUndefined();
	expect(await call("POST", "/api/custom/unknown", {})).toBeUndefined();
});

// ---- project page detail ----
test("reportHead picks the marker line even after an OmO handoff block", () => {
	expect(reportHead("Ask: x - wanted: y\n\n[done] 머지했어요(abc123).\n- 바뀐 것")).toEqual({ tone: "done", line: "머지했어요(abc123).", body: "- 바뀐 것" });
	expect(reportHead("**[fail]** 빌드가 안 돼요")).toMatchObject({ tone: "fail", line: "빌드가 안 돼요" });
	expect(reportHead("그냥 글")).toEqual({ line: "그냥 글", body: "" });
});

test("project detail: ended lanes' report.md fill results newest first, with receipts, commits, tasks and links", () => {
	const lanes = [
		{ name: "a", cwd: "/h/.dotz/lanes/a/worktree", repo: "/h/Code/proj", status: "exited", live: false, startedAt: "2026-10-01T00:00:00Z", reports: 1, lastText: "", resumable: true, claim: { state: "verified" } },
		{ name: "b", cwd: "/h/.dotz/lanes/b/worktree", repo: "/h/Code/proj", status: "working", live: true, startedAt: "2026-10-02T00:00:00Z", reports: 0, lastText: "하는 중", pendingAsk: { text: "?", at: "x" } },
		{ name: "z", cwd: "/h/Code/other", status: "exited", live: false, startedAt: "2026-10-01T00:00:00Z", reports: 1, lastText: "" },
	];
	const all = projectsView({ lanes, channels: { work: { "9": "작업" }, homes: { a: "9" }, threads: { t1: { parent: "9", name: "스레드" }, t2: { parent: "8", name: "남의 것" } } }, pins: { projects: [], hide_projects: [], routines: [], links: [] }, home: "/h", tmpDirs: [] });
	const project = all.find(p => p.key === "dir:~/Code/proj")!;
	const input: DetailInput = {
		project, others: all, lanes, home: "/h",
		reports: { a: { text: "[done] 끝냈어요\n세부", at: "2026-10-03T00:00:00Z" } },
		receipts: [
			{ command: "bun test", cwd: "/h/.dotz/lanes/a/worktree", exitCode: 0, ranAt: Date.parse("2026-10-04T00:00:00Z") },
			{ command: "bun test", cwd: "/h/Code/proj", exitCode: 1, ranAt: Date.parse("2026-10-01T00:00:00Z") },
			{ command: "ls", cwd: "/h/Code/other", exitCode: 0, ranAt: Date.parse("2026-10-05T00:00:00Z") },
		],
		tasks: [{ id: "t-p", what: "proj 저장소 정리" }, { id: "t-other", what: "other 쪽 일" }, { id: "t-none", what: "어디에도 안 속함" }],
		routines: [{ id: "r", name: "점검", prompt: "x", target: "lane:a" }, { id: "r2", name: "남", prompt: "y", target: "main" }],
		schedules: [{ id: "s", text: "lane:b 확인", at: "2026-10-06T00:00:00Z", created: "x" }],
		watches: [], channels: { work: { "9": "작업" }, threads: { t1: { parent: "9", name: "스레드" }, t2: { parent: "8", name: "남의 것" } } },
		git: { branch: "main", base: "main", dirty: 2, commits: [{ hash: "c1", at: "2026-10-02T00:00:00Z", subject: "커밋" }], unmerged: [] },
	};
	const d = projectDetailView(input);
	expect(d.summary).toEqual({ lanes: 2, running: 1, waiting: 1, lastActivity: "2026-10-04T00:00:00.000Z" });
	expect(d.lanes.find(l => l.name === "a")).toMatchObject({ line: "끝냈어요", tone: "done", claim: "verified", resumable: true, finishedAt: "2026-10-03T00:00:00Z" });
	expect(d.lanes.find(l => l.name === "b")).toMatchObject({ line: "하는 중", waiting: true, resumable: false });
	expect(d.results.map(r => [r.kind, r.title])).toEqual([["verify", "bun test"], ["report", "끝냈어요"], ["commit", "커밋"]]);
	expect(d.results[0]).toMatchObject({ ok: true, lane: "a" });
	expect(d.tasks.map(t => t.id)).toEqual(["t-p"]);
	expect(projectDetailView({ ...input, self: true }).tasks.map(t => t.id)).toEqual(["t-p", "t-none"]);
	expect(d.linked).toMatchObject({ channel: { id: "9", name: "작업" }, threads: [{ id: "t1", name: "스레드" }], routines: [{ id: "r" }], schedules: [{ id: "s" }] });
	expect(d.repo).toMatchObject({ dirty: 2 });
});

test("project titles: record, pin, work channel name, first session's title, folder basename, in that order", () => {
	const lanes = [lane("late", `${HOME}/Code/dotz`, "2026-10-05T00:00:00Z", { title: "나중 세션" }), lane("first", `${HOME}/Code/dotz`, "2026-10-01T00:00:00Z", { title: "디스코드 설정" })];
	const only = (input: Partial<Parameters<typeof projectsView>[0]> = {}) => view({ lanes, channels: {}, pins: noPins, ...input })[0]!;
	expect(only().name).toBe("디스코드 설정");
	expect(only({ lanes: [lane("x", `${HOME}/Code/dotz`, "2026-10-01T00:00:00Z")] }).name).toBe("dotz");
	expect(only({ channels: { work: { "100": "채널 이름" }, homes: { first: "100" } } }).name).toBe("채널 이름");
	const pins = { ...noPins, projects: [{ name: "고정 이름", path: "~/Code/dotz" }] };
	expect(only({ pins, channels: { work: { "100": "채널 이름" }, homes: { first: "100" } } }).name).toBe("고정 이름");
	const record = { title: "기록 제목", purpose: "목적", updated: "2026-10-21T00:00:00Z" };
	const withRecord = only({ pins, records: { "dir:~/Code/dotz": record, "ch:1": { title: "다른 것", updated: "x" } } });
	expect(withRecord).toMatchObject({ name: "기록 제목", record });
	expect(only({ records: { "dir:~/Code/dotz": { purpose: "제목 없음", updated: "x" } } }).name).toBe("디스코드 설정");
	expect(only().lanes.map(l => l.title)).toEqual(["나중 세션", "디스코드 설정"]);
});

test("project detail adds the record, the monitors of its channel and the routines and schedules scoped to it", () => {
	const channels = { work: { "9": "작업" }, homes: { a: "9" } };
	const lanes = [lane("a", "/h/Code/proj", "2026-10-01T00:00:00Z")];
	const record = { title: "기록", goal: "목표", milestones: [{ text: "하나", done: true }], updated: "2026-10-21T00:00:00Z" };
	const all = projectsView({ lanes, channels, pins: noPins, records: { "dir:~/Code/proj": record }, home: "/h", tmpDirs: [] });
	const watch = (id: string, channelsOf: string[], extra: Record<string, unknown> = {}) => ({ id, name: `w-${id}`, command: "curl -s https://x\nsecond line", every_minutes: 10, on: "change", channels: channelsOf, fails: 0, ...extra });
	const d = projectDetailView({
		project: all[0]!, record, others: all, lanes, reports: {}, receipts: [], tasks: [], home: "/h", channels,
		watches: [watch("m1", ["9"], { on: "match", pattern: "fail", lastRun: "2026-10-21T00:00:00Z", nextAt: "2026-10-21T00:10:00Z", fails: 2, paused: true }), watch("m2", ["9", "8"]), watch("o1", ["8"])],
		routines: [{ id: "r1", name: "채널 루틴", prompt: "x", target: "ch:9", schedule: { every_minutes: 60 } }, { id: "r2", name: "남의 루틴", prompt: "y", target: "main" }],
		schedules: [{ id: "s1", text: "[routine:r1:abc123] x", at: "2026-10-22T00:00:00Z", every_minutes: 60, paused: true, created: "x" }, { id: "s2", text: "[routine:r2:abc123] y", at: "2026-10-22T00:00:00Z", created: "x" }, { id: "s3", text: "ch:9 에 보고", at: "2026-10-22T00:00:00Z", created: "x" }],
	});
	expect(d.record).toEqual(record);
	expect(d.monitors.map(m => m.id)).toEqual(["m1", "m2"]);
	expect(d.monitors[0]).toEqual({ id: "m1", name: "w-m1", command: "curl -s https://x", every_minutes: 10, on: "match", pattern: "fail", lastRun: "2026-10-21T00:00:00Z", nextAt: "2026-10-21T00:10:00Z", fails: 2, paused: true });
	expect(d.monitors[1]).toMatchObject({ paused: false });
	expect(d.routines.map(r => r.id)).toEqual(["r1"]);
	expect(d.schedules.map(s => [s.id, s.routine ?? null, s.paused ?? false])).toEqual([["s3", null, false], ["s1", "r1", true]]);
	expect(projectDetailView({ project: { ...all[0]!, channel: undefined }, others: all, lanes, reports: {}, receipts: [], tasks: [], home: "/h", channels: {}, watches: [watch("m1", ["9"])], routines: [], schedules: [] }).monitors).toEqual([]);
});

test("project detail of a fresh project (no sessions, no record) keeps every list an array, so the page can render its empty states", () => {
	const all = projectsView({ lanes: [], channels: {}, pins: { ...noPins, projects: [{ name: "새 프로젝트", path: "~/fresh" }] }, home: "/h", tmpDirs: [] });
	const d = projectDetailView({ project: all[0]!, others: all, lanes: [], reports: {}, receipts: [], tasks: [], home: "/h", channels: {}, watches: [], routines: [], schedules: [] });
	for (const k of ["monitors", "routines", "schedules", "lanes", "results", "tasks"] as const) expect(d[k]).toEqual([]);
	expect(d.record).toBeUndefined();
	expect(d.summary).toEqual({ lanes: 0, running: 0, waiting: 0 });
	expect(d.linked).toEqual({ threads: [], laneChannels: [], routines: [], schedules: [], watches: [] });
});

test("GET /api/custom/project answers 404 for an unknown key", async () => {
	expect((await call("GET", "/api/custom/project?key=dir:~/nope"))!.status).toBe(404);
});

test("a work channel named like a session folder joins that folder's project, and the project page lists its background work", () => {
	const lanes = [{ name: "a", cwd: "/h/Code/dotz", status: "exited", live: false, startedAt: "2026-10-01T00:00:00Z", reports: 0, lastText: "" }];
	const channels = { work: { "9": "dotz-개선", "8": "다른 일" } };
	const all = projectsView({ lanes, channels, pins: noPins, home: "/h", tmpDirs: [] });
	expect(all.map(p => [p.key, p.name, p.channel?.id, p.lanes.length])).toEqual([["dir:~/Code/dotz", "dotz-개선", "9", 1], ["ch:8", "다른 일", "8", 0]]);
	const work = (id: string, over: Record<string, unknown>) => ({ id, description: id, status: "running" as const, started_at: 1, ...over });
	const d = projectDetailView({ project: all[0]!, others: all, lanes, reports: {}, receipts: [], tasks: [], home: "/h", channels, watches: [], routines: [], schedules: [],
		work: [work("by-folder", { folder: "/h/Code/dotz" }), work("by-channel", { target: "ch:9" }), work("elsewhere", { folder: "/h/Code/other", target: "ch:8" }), work("main", { target: "web" })] });
	expect(d.work.map(w => w.id)).toEqual(["by-folder", "by-channel"]);
});
