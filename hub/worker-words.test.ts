import { expect, test } from "bun:test";
import { en } from "./i18n-en.ts";
import { ko } from "./i18n-ko.ts";
import { createPrompts, type PromptDeps, type WorkRow } from "./prompts.ts";
import { RunKeys } from "./runtime/omp-runs.ts";
import { OMO_WORDS, ompWords, runName } from "./worker-words.ts";

const KEY = "Napper~tonk8w1.1";
const OMP = ompWords(runName);
const OMO_TOOL = /task_(send|output|cancel)/;
const stalled = [{ description: "job", id: KEY, reason: "idle" }];
const open = [{ target: "#web", replyTo: "m1", omp: true as const, workers: [{ id: KEY, name: "Napper" }] }];

test("runName round-trips every id RunKeys makes, for names with digits, dashes and tildes", () => {
	for (const name of ["Napper", "Napper-2", "a~b", "w9", "~x", "한글"]) {
		const keys = new RunKeys();
		const first = keys.spawned(name);
		expect(runName(first)).toBe(name);
		expect(keys.nameOf(first)).toBe(name);
		keys.updated(name, "running");
		keys.updated(name, "done");
		const second = keys.spawned(name);
		expect(second).not.toBe(first);
		expect(runName(second)).toBe(name);
		expect(runName(keys.finished(name))).toBe(name);
	}
	expect(runName("st_01a15660")).toBe("st_01a15660");
});

test("omp words: write agent://NAME steers, read agent://NAME reads, write proc://NAME/kill cancels", () => {
	expect([OMP.name(KEY), OMP.steer(KEY), OMP.read(KEY), OMP.cancel(KEY)]).toEqual(["Napper", "write agent://Napper", "read agent://Napper", "write proc://Napper/kill"]);
	expect([OMO_WORDS.name("st_1"), OMO_WORDS.steer("st_1"), OMO_WORDS.read("st_1"), OMO_WORDS.cancel("st_1")]).toEqual(["st_1", "task_send", "task_output", "task_cancel"]);
});

for (const [lang, cat] of [["en", en], ["ko", ko]] as const) {
	test(`${lang}: the omp notes name omp's calls and no OmO tool`, () => {
		const notes = [
			cat.joinWorker(KEY, "fix it", OMP), cat.otherWorker(KEY, "#web", "m1", OMP), cat.workReadElsewhere(KEY, "#web", "#ops", OMP), cat.workReadHere(KEY, OMP),
			cat.workStalled(stalled, OMP), cat.workStalled([...stalled, { ...stalled[0]!, id: "Other~tonk8w1.2" }], OMP), cat.openRequests(open, false), cat.openRequests([{ ...open[0]!, workers: [] }], true),
		];
		for (const note of notes) {
			expect(note).not.toMatch(OMO_TOOL);
			expect(note).not.toContain("~");
		}
		expect(notes[0]).toContain("write agent://Napper");
		expect(notes[4]).toContain("write proc://Napper/kill");
		expect(notes[5]!.match(/write proc:\/\/\w+\/kill/g)).toEqual(["write proc://Napper/kill", "write proc://Other/kill"]);
		expect(notes[6]).toContain("read agent://Napper");
		expect(notes[7]).toContain("read agent://NAME");
	});
}

test("OmO notes are byte for byte what they were", () => {
	const w = { id: "st_1", description: "job", reason: "idle" };
	expect(en.joinWorker("st_1", "fix  it")).toBe(`${en.joinLead}: "fix it" (task st_1). If this message is about the same work (the same approval, the same posting), do not spawn a new worker: pass it to the running one with task_send and end with [later]. Otherwise handle it normally.`);
	expect(en.otherWorker("st_1", "#web", "m1")).toBe(`${en.otherConvLead}. This turn's final answer goes to this conversation only. If the result of task st_1 (#web) arrives during this turn, send that answer with dotz_send target "#web" reply_to "m1", never here.`);
	expect(en.workReadElsewhere("st_1", "#web", "#ops")).toBe(`${en.otherConvLead}. The result of task st_1 (#web) was read in a turn for #ops. It is the answer to the request in #web: answer it here.`);
	expect(en.workReadHere("st_1")).toBe("[dotz gateway] The result of task st_1 was read in a turn that did not answer this request. Answer it now from that result.");
	expect(en.workStalled([w])).toBe(`[dotz gateway] This background task is still marked running but no longer working: "job" (st_1; idle). The gateway did not stop it. Check what it already produced (commits, files), then finish the work yourself or relaunch it (after a usage limit, once the limit has reset), and cancel the stuck task (task_cancel) once you have taken it over.`);
	expect(en.openRequests([{ target: "#web", replyTo: "m1", workers: [{ id: "st_1" }] }], false)).toBe(`${en.openLead}: msg=m1 in #web, workers st_1. Finish each now: answer it from what its worker produced (task_output reads the result), or say what stopped it. This turn's final answer goes to the first one; answer the others with dotz_send reply_to. If real work remains, start it and end with [later].`);
	expect(ko.joinWorker("st_1", "fix  it")).toBe(`${ko.joinLead}: "fix it" (작업 st_1). 이 메시지가 같은 일(같은 승인, 같은 게시)에 관한 것이면 새 작업을 띄우지 말고 task_send로 돌고 있는 작업에 전달한 뒤 [later]로 끝내세요. 아니면 평소처럼 처리하세요.`);
	expect(ko.workReadHere("st_1")).toBe("[dotz gateway] 작업 st_1의 결과가 이 요청에 답하지 않은 턴에서 읽혔어요. 그 결과로 지금 이 요청에 답해 주세요.");
	expect(ko.workStalled([w])).toBe(`[dotz gateway] 백그라운드 작업이 아직 running으로 표시되지만 더는 일하지 않아요: "job"(st_1, 이유: idle). 게이트웨이는 이 작업을 멈추지 않았어요. 그 작업이 이미 만든 것(커밋, 파일)을 확인하고, 직접 마무리하거나 다시 맡기세요(사용량 한도 때문이면 한도가 풀린 뒤에). 넘겨받았으면 멈춘 작업은 task_cancel로 정리하세요.`);
	expect(ko.openRequests([{ target: "#web", replyTo: "m1", workers: [{ id: "st_1" }] }], false)).toBe(`${ko.openLead}: msg=m1 (#web, 작업 st_1). 지금 하나씩 끝내세요: 작업 결과로 답하거나(task_output으로 읽어요) 무엇이 막았는지 말해요. 이 턴의 마지막 답은 첫 요청으로 가고, 나머지는 dotz_send reply_to로 답하세요. 정말 남은 일이 있으면 시작하고 [later]로 끝내세요.`);
});

const queue = (extra: Partial<PromptDeps>) => {
	const rows: WorkRow[] = [{ id: KEY, status: "running", target: "web", replyTo: "m1", startedAt: Date.now(), description: "job" }];
	const q = createPrompts({
		deliver: () => {}, steer: () => true, working: () => false, note: (_t, _r, t) => t, isNote: () => false,
		post: async () => ({ delivered: true }), clearProgress: () => {}, persist: () => {}, log: () => {},
		work: () => rows, links: [{ id: KEY, target: "web", replyTo: "m1", at: Date.now() }], ...extra,
	});
	q.deliver("work", { target: "web", replyTo: "m1" });
	q.onPrompt("work");
	q.onAnswer("[later] on it");
	return q;
};

test("openRequests names the omp worker and marks the request omp; OmO's carry neither", () => {
	const omp = queue({ inProcess: () => true, nameOf: runName }).openRequests();
	expect(omp.map(r => [r.omp, r.workers.map(w => [w.id, w.name])])).toEqual([[true, [[KEY, "Napper"]]]]);
	expect(en.openRequests(omp.map(r => ({ ...r })), false)).toContain("read agent://Napper");
	const omo = queue({ nameOf: runName }).openRequests();
	expect(omo.map(r => [r.omp, r.workers.map(w => w.name)])).toEqual([[undefined, [undefined]]]);
});
