// Expensive-model use the owner asked for is no warning: the basis is the gateway's own record of model picks and grants.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { ownerCovered, parseOwnerBasis } from "./owner-asked.ts";
import { collectSessions } from "./session-sources.ts";
import { analyze, findingsOf, ownerUseOf } from "./token-audit.ts";

const T0 = Date.UTC(2026, 10, 11, 0);
const iso = (min: number) => new Date(T0 + min * 60e3).toISOString();
const picks = JSON.stringify({
	orchestrator: { model: "anthropic/claude-fable-5-2", thinking: "high", by: "owner", at: iso(-600) },
	lanes: { model: "anthropic/claude-opus-5-5", thinking: "medium", by: "owner", at: iso(-600) },
});
const log = [
	`${iso(-30)} model change: lane:site-fix anthropic/claude-opus-5-5:medium -> anthropic/claude-fable-5-2:high by owner-message:m1`,
	`${iso(100)} model change: lane:site-fix anthropic/claude-fable-5-2:high -> anthropic/claude-opus-5-5:medium by fallback`,
	`${iso(-10)} expensive grant: lane:docs until ${iso(60)} by owner`,
	`${iso(-10)} expensive grant: lane:agent until ${iso(60)} by owner-message:m2`,
	`${iso(-5)} something else entirely`,
].join("\n");
const basis = parseOwnerBasis(picks, log);
const use = (first: number, last: number, o: { models?: string[]; levels?: string[] } = {}) => ({ models: o.models ?? ["claude-fable-5-2"], levels: o.levels ?? [], first: T0 + first * 60e3, last: T0 + last * 60e3 });

test("the owner's pick covers the model it names while it is in force; a fallback after it ends the basis", () => {
	expect(ownerCovered(use(0, 50), "orchestrator", false, basis)).toEqual({ model: true, effort: true });
	expect(ownerCovered(use(0, 50), "lane:site-fix", false, basis).model).toBe(true);
	expect(ownerCovered(use(0, 120), "lane:site-fix", false, basis).model).toBe(false);
	expect(ownerCovered(use(-60, 50), "lane:site-fix", false, basis).model).toBe(false);
});

test("a level the pick does not name stays uncovered, and a lane without its own pick runs the lanes default", () => {
	expect(ownerCovered(use(0, 10, { levels: ["xhigh"] }), "orchestrator", false, basis)).toEqual({ model: true, effort: false });
	expect(ownerCovered(use(0, 10), "lane:other", false, basis).model).toBe(false);
	expect(ownerCovered(use(0, 10, { models: [] , levels: ["medium"] }), "lane:other", false, basis).effort).toBe(true);
});

test("a grant covers its conversation's sessions and workers inside its time; no target means no basis", () => {
	expect(ownerCovered(use(0, 50), "lane:docs", true, basis)).toEqual({ model: true, effort: true });
	expect(ownerCovered(use(0, 90), "lane:docs", true, basis).model).toBe(false);
	expect(ownerCovered(use(0, 50), "lane:agent", false, basis).model).toBe(true);
	expect(ownerCovered(use(0, 50), "orchestrator", true, basis).model).toBe(false);
	expect(ownerCovered(use(0, 50), undefined, false, basis).model).toBe(false);
});

test("a lane launched on the owner's ask covers its own model and its workers' expensive model, not another level", () => {
	const withLane = parseOwnerBasis(picks, log, { review: { model: "anthropic/claude-fable-5-2", thinking: "high" } });
	expect(ownerCovered(use(0, 50, { levels: ["high"] }), "lane:review", false, withLane)).toEqual({ model: true, effort: true });
	expect(ownerCovered(use(0, 50, { levels: ["xhigh"] }), "lane:review", false, withLane)).toEqual({ model: true, effort: false });
	expect(ownerCovered(use(0, 50), "lane:review", true, withLane).model).toBe(true);
	expect(ownerCovered(use(0, 50), "lane:review", false, basis).model).toBe(false);
});

const turn = (min: number, model: string) =>
	JSON.stringify({ type: "message", timestamp: iso(min), message: { role: "assistant", provider: "anthropic-subscription", model, stopReason: "stop", content: [], usage: { input: 2, output: 500, cacheRead: 1000, cacheWrite: 100, totalTokens: 1602, cost: { total: 2 } } } });
const session = (name: string, model: string, target: string) => {
	const file = join(DATA_DIR, `${name}.jsonl`);
	writeFileSync(file, `${[turn(1, model), turn(2, model)].join("\n")}\n`);
	return { file, label: name, child: false, runtime: "omo" as const, target };
};

const CONFIG = join(DATA_DIR, "config.json");
const original = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : undefined;
afterEach(() => {
	if (original === undefined) rmSync(CONFIG, { force: true });
	else writeFileSync(CONFIG, original);
});

test("asked use leaves the warnings and is counted once on its own line; the rest stays a warning", () => {
	writeFileSync(CONFIG, JSON.stringify({ ...(original ? JSON.parse(original) : {}), guard: { ask_before_expensive: true, expensive_models: ["fable"] } }));
	const asked = analyze(session("asked-fable", "claude-fable-5-2", "orchestrator"), T0);
	const not = analyze(session("unasked-fable", "claude-fable-5-2", "lane:other"), T0);
	const judge = (s: typeof asked) => ownerCovered({ models: [...s.dearModels], levels: [...s.dearLevels], first: s.dearFirst, last: s.dearLast }, s.src.target, false, basis);
	const dear = findingsOf([asked, not], [], judge).filter(f => f.kind === "비싼 모델");
	expect(dear.map(f => f.who)).toEqual(["unasked-fable"]);
	expect(ownerUseOf([asked, not], judge)).toEqual({ sessions: 1, cost: 4 });
});

test("session folders carry their model target and task workers their parent session", () => {
	const home = mkdtempSync(join(tmpdir(), "owner-asked-"));
	const dataDir = join(home, ".dotz");
	const root = join(home, "sessions");
	const orch = join(root, `-${dataDir.replace(/\//g, "-")}--`), lane = join(root, `-${dataDir.replace(/\//g, "-")}-lanes-site-fix-worktree--`), other = join(root, "--home-user-code--");
	for (const d of [orch, lane, other]) mkdirSync(d, { recursive: true });
	writeFileSync(join(orch, "a_01a1c000.jsonl"), "{}\n");
	writeFileSync(join(lane, "b_01a1c001.jsonl"), "{}\n");
	writeFileSync(join(other, "c_01a1c002.jsonl"), "{}\n");
	const store = join(home, "store"), tid = "st_1";
	mkdirSync(join(store, "children", tid, "sessions", tid), { recursive: true });
	mkdirSync(join(store, "tasks"), { recursive: true });
	writeFileSync(join(store, "children", tid, "sessions", tid, "w.jsonl"), "{}\n");
	writeFileSync(join(store, "tasks", `${tid}.json`), JSON.stringify({ name: "w", parent_session_id: "01a1c000-0000-7000-8000-000000000000" }));
	const stores = join(home, "stores.json");
	writeFileSync(stores, JSON.stringify({ stores: { [store]: {} } }));
	const srcs = collectSessions(0, { home, dataDir, roots: [{ dir: root, runtime: "omo" }], omoStores: stores });
	const of = (part: string) => srcs.find(s => s.file.includes(part));
	expect(of("a_01a1c000")?.target).toBe("orchestrator");
	expect(of("b_01a1c001")?.target).toBe("lane:site-fix");
	expect(of("c_01a1c002")?.target).toBeUndefined();
	expect(of("w.jsonl")?.parent).toBe("01a1c000-0000-7000-8000-000000000000");
});
