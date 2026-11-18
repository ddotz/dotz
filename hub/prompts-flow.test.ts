import { expect, test } from "bun:test";
import { hushedAnswer, isLoud } from "./handed.ts";
import { createPrompts, type Pending, type PromptDeps, type WorkRow } from "./prompts.ts";

export const row = (id: string, status: WorkRow["status"], target: string, replyTo: string, startedAt = Date.now()): WorkRow => ({ id, status, target, replyTo, startedAt, description: "job", ...(status === "running" ? {} : { endedAt: Date.now() }) });

export function mk(extra: Partial<PromptDeps> = {}) {
	const s = { working: false, delivered: [] as string[], posts: [] as { target: string; text: string; replyTo?: string }[], saved: [] as Pending[][], work: [] as WorkRow[] };
	const q = createPrompts({
		deliver: t => s.delivered.push(t), steer: () => true, working: () => s.working,
		note: (_t, _r, t) => `[note] ${t}`, isNote: t => t.startsWith("[note]"),
		post: async (target, text, replyTo) => (s.posts.push({ target, text, replyTo }), { delivered: true }),
		clearProgress: () => {}, persist: o => s.saved.push(o), log: () => {},
		work: () => s.work, workFor: t => s.work.find(w => w.status === "running" && w.target === t),
		announce: () => {}, ...extra,
	});
	const start = (text: string, reply: { target: string; replyTo?: string }) => { q.deliver(text, reply); s.working = true; q.onPrompt(text); };
	return { q, s, start };
}

test("isLoud: ask and fail markers in every spelling, nothing else", () => {
	for (const m of ["[ask]", "[결정]", "[fail]", "[실패]", "[warn]", "[경고]", "  [WARN]"]) expect(isLoud(`${m} disk is full`)).toBe(true);
	for (const m of ["", "[done] ok", "[run] x", "disk is full", "see [warn] later"]) expect(isLoud(m)).toBe(false);
});

test("an answer to handed text is hushed unless it opens loud in any spelling", () => {
	for (const m of ["[warn] x", "[경고] x", "[실패] x", "[결정] x"]) expect(hushedAnswer({ handback: true }, m, () => false)).toBeUndefined();
	expect(hushedAnswer({ handback: true }, "plain", () => false)).toEqual({ hushed: true });
});

test("answering hears the final text of a turn's own answer and of a later stop that answers a steered note", async () => {
	const heard: [string, string | undefined][] = [];
	const { q, start } = mk({ answering: (t, r) => void heard.push([t, r]) });
	start("one", { target: "web", replyTo: "m1" });
	q.onAnswer("[done] first");
	q.deliver("two", { target: "web", replyTo: "m2", owner: true });
	q.onPrompt("[note] two");
	q.onAnswer("[done] second");
	await Promise.resolve();
	expect(heard).toEqual([["[done] first", "m1"], ["[done] second", "m2"]]);
});

test("answering hears a woken run's answer for the request its worker served, and nothing from a hushed quiet check", async () => {
	const heard: [string, string | undefined][] = [];
	const { q, s, start } = mk({ answering: (t, r) => void heard.push([t, r]), quietNote: () => {} });
	start("work", { target: "web", replyTo: "m3" });
	s.work = [row("W~a.1", "running", "web", "m3")];
	q.workersSpawned([{ id: "W~a.1" }]);
	q.onAnswer("[later]");
	s.working = false; q.settleTurn();
	s.work = [row("W~a.1", "done", "web", "m3")];
	s.working = true;
	q.workersDone(["W~a.1"]);
	q.onAnswer("[done] woken");
	await Promise.resolve();
	expect(heard).toEqual([["[done] woken", "m3"]]);
	q.deliver("check", { target: "web", quiet: true });
	s.working = false; q.settleTurn(); s.working = true; q.onPrompt("check");
	q.onAnswer("plain quiet result");
	expect(heard.length).toBe(1);
});

const OLD_LINK = { id: "W~old.1", target: "web", replyTo: "m1", at: Date.now() - 60_000, receipted: true };
const WAITING = { text: "work", at: Date.now() - 120_000, target: "web", replyTo: "m1", deferred: true };

test("in the omp process a request whose worker is not in the new process is replayed, and its dead link stops being listed", () => {
	const saves: number[] = [];
	const { q, s } = mk({ links: [{ ...OLD_LINK }], inProcess: () => true, persistLinks: l => void saves.push(l.length) });
	expect(q.replay([WAITING], t => t)).toBe(1);
	expect(s.delivered).toEqual(["work"]);
	expect(q.openRequests()).toEqual([]);
	expect(q.linkOf("W~old.1")?.delivered).toBe(true);
	expect(saves.length).toBeGreaterThan(0);
});

test("in the omp process a request whose worker still runs keeps waiting", () => {
	const { q, s } = mk({ links: [{ ...OLD_LINK }], inProcess: () => true });
	s.work = [row("W~old.1", "running", "web", "m1")];
	expect(q.replay([WAITING], t => t)).toBe(0);
	expect(q.openRequests()[0]!.workers.map(w => w.id)).toEqual(["W~old.1"]);
});

test("OmO keeps the old rule: a worker not listed is still waited on, a failed one is not", () => {
	const kept = mk({ links: [{ ...OLD_LINK }] });
	expect(kept.q.replay([WAITING], t => t)).toBe(0);
	const failed = mk({ links: [{ ...OLD_LINK }] });
	failed.s.work = [row("W~old.1", "failed", "web", "m1")];
	expect(failed.q.replay([WAITING], t => t)).toBe(1);
	expect(failed.q.linkOf("W~old.1")?.delivered).toBeUndefined();
});
