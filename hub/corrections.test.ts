import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correctionEntry, isCorrection, isCorrectionText, recordCorrection, topicOf, type Correction } from "./corrections.ts";
import fixture from "./corrections.fixture.json";
import { emit } from "./events.ts";
import { dueAlerts } from "./reflect.ts";

// A week of owner messages labeled by hand, anonymized: words that identify anything are ○, handover rows are written for this test.
type Row = { ts: string; t: string; topic?: string; handover?: boolean };
const rows = fixture as Row[];
const owner = rows.filter(r => !r.handover);
const flagged = owner.filter(r => isCorrectionText(r.t));

test("the regex keeps the audited recall and precision on the labeled week", () => {
	const labeled = owner.filter(r => r.topic);
	const hits = flagged.filter(r => r.topic);
	expect(labeled.length).toBe(141);
	expect(hits.length / labeled.length).toBeGreaterThanOrEqual(0.72);
	expect(hits.length / flagged.length).toBeGreaterThanOrEqual(0.59);
});

test("gateway handover text is no correction, even when it quotes one", () => {
	const handovers = rows.filter(r => r.handover);
	expect(handovers.length).toBeGreaterThan(0);
	for (const r of handovers) expect(isCorrectionText(r.t)).toBe(false);
});

const event = (extra: Record<string, unknown>) => ({ ts: "2026-11-04T01:00:00.000Z", kind: "message", source: "web", channel: "web", text: "여전히 안되네", ...extra });

test("a button choice and a command are no correction; a lane message is one, and other kinds are not", () => {
	expect(isCorrection(event({}))).toBe(true);
	expect(isCorrection(event({ picks: [{ q: "q", n: 1, label: "아니요" }], text: "아니요" }))).toBe(false);
	expect(isCorrection(event({ decision: "n1", text: "아니요" }))).toBe(false);
	expect(isCorrection(event({ text: "/model 왜" }))).toBe(false);
	expect(isCorrection(event({ kind: "lane_message", lane: "x" }))).toBe(true);
	expect(isCorrection(event({ kind: "out" }))).toBe(false);
});

test("the entry keeps the whole text, the file paths, the conversation and the answer before it from that conversation only", () => {
	const text = `왜 안되냐 ${"가".repeat(1000)}`;
	const answer = (target: string, reply: string, extra = {}) => ({ ts: "2026-11-04T00:59:00.000Z", kind: "out", source: "orchestrator", target, text: reply, ...extra });
	const ring = [answer("web", "웹 답"), answer("web", "진행 줄", { update_key: "progress" }), answer("ch:123", "다른 대화 답")];
	const e = correctionEntry(event({ text, attachments: [{ url: "/data/uploads/a.png" }], files: [{ path: "/data/uploads/b.png" }], mid: "m1" }), ring);
	expect(e).toEqual({ ts: "2026-11-04T01:00:00.000Z", topic: "not-applied", conv: "main", text, attachments: ["/data/uploads/a.png", "/data/uploads/b.png"], previous: "웹 답", message_id: "m1" });
	expect(correctionEntry(event({ channel: "ch:123" }), ring).previous).toBe("다른 대화 답");
});

test("each correction is one whole JSON line; anything else writes nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "corrections-"));
	const file = join(dir, "corrections.jsonl");
	try {
		recordCorrection(event({ text: "줄바꿈이\n이상해" }), file);
		recordCorrection(event({ text: "좋아 진행해" }), file);
		recordCorrection(event({ text: "너무 길어" }), file);
		const lines = readFileSync(file, "utf8").trimEnd().split("\n").map(l => JSON.parse(l) as Correction);
		expect(lines.map(l => [l.text, l.topic])).toEqual([["줄바꿈이\n이상해", "linebreak"], ["너무 길어", "other"]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("topics read English lessons too and fall back to other", () => {
	expect(topicOf("Compare the layout at both widths")).toBe("ui");
	expect(topicOf("Do not leave a session stuck")).toBe("stalled");
	expect(topicOf("Sign the release tag")).toBe("other");
});

test("everyday 표현 and 설명 are no wording complaint; a complaint about the words is, in messages and in lessons", () => {
	for (const t of ["이걸 왜 그런지 설명해봐", "문서 설명에 적어둬", "이 상태는 점으로 표현하자", "한 화면에 다 표현되게 해줘", "첫 화면 문구가 잘려", "빈 문구 잘림 고쳐"]) expect(topicOf(t)).not.toBe("copy");
	for (const t of ["표현이 너무 ai 같은데", "설명이 어색해", "설명 좀 바꿔", "어색한 표현 빼", "문구 고쳐", "이 문구 별로야", "문체가 딱딱해", "카피 다시 써", "ai slop 없애", "ai 티 나"]) expect(topicOf(t)).toBe("copy");
	for (const t of ["- [11-01] 딱딱한 표현을 쓰지 않아요", "- [11-01] Keep the wording plain"]) expect(topicOf(t)).toBe("copy");
});

test("replayed night by night, the labeled week raises a card only where words the mask left still repeat one complaint", () => {
	const at = (ts: string) => Date.parse(`2026-${ts.replace(" ", "T")}:00+09:00`);
	const entries = flagged.map(r => ({ ts: new Date(at(r.ts)).toISOString(), topic: topicOf(r.t), conv: "web", text: r.t, attachments: [], previous: "" }) as Correction);
	const sent: Record<string, number> = {};
	const cards: string[] = [];
	for (let night = Date.parse("2026-10-30T04:40:00+09:00"); night <= Date.parse("2026-11-05T04:40:00+09:00"); night += 24 * 3600_000) {
		const seen = entries.filter(e => Date.parse(e.ts) <= night);
		for (const a of dueAlerts(seen, "", sent, night)) {
			sent[a.key] = night;
			cards.push(a.key);
		}
	}
	console.log(`repeat cards on the labeled week: ${cards.length} (${cards.join(", ")})`);
	expect(new Set(cards).size).toBe(cards.length);
	expect(cards).toEqual(["not-applied", "ui"]);
});

test("a peer gateway's message is no owner correction; the owner's own message from the other computer's page still is", () => {
	const peer = { author: "ddotz@github", via: "맥북" };
	expect(isCorrection(event({ ...peer, text: "맥북: 홈 빈 문구 잘림 수정을 main에 올렸어요. 재시작은 필요 없어요." }))).toBe(false);
	expect(isCorrection(event({ ...peer, text: "맥북 수치예요. 여전히 표본이 작아요." }))).toBe(false);
	expect(isCorrection(event({ ...peer, kind: "lane_message", lane: "work", text: "맥북: 여전히 안되네" }))).toBe(false);
	expect(isCorrection(event({ ...peer, channel: "mail:inbox", text: "여전히 안되네" }))).toBe(true);
	expect(isCorrection(event({ author: "ddotz@github", text: "맥북 왜 안되냐" }))).toBe(true);
});

const BRIEF = `출자전환 관련해서는 구조실에서 오퍼레이팅 처리 누락이 종종 있어서 대손상각비처리가 되어야하는데 매각손으로 처리되는 경우가 있음. 이 경우에는 대손상각비로 보고 처리를 하는게 맞음. 거기에 맞춰서 대손보고서와 고객별대손준비금변동표에도 업뎃되어야함. 기존의 잘못된 로직을 틀어막는 구조도 필요하고
대손보고서 검증셀에서 v2에서 판정식에 0이 아니라 다른 숫자가 들어가서 깨져있음. 확인 필요함. 그리고 WF 파일에 들어가는 숫자랑 다른 것들이 많음. 이거 메일 보낼때 리스팅해야함
35L 금액 관련해서는 나한테 좀 더 설명해봐. 국내만 하는게 맞는지, 그리고 왜 3분기 회수에만 해당되는지`;
test.each([
	["코딩 하네스도 omp 아니냐", false],
	["그리고 방금 백그라운드 작업에서 비서 하네스랑 코딩하네스중에 어떤걸로 진행된거냐", false],
	["부실 후 이관을 할 때, 계정원장에서 계좌원금 이수관되고 대손준비금이랑 대손상각비도 이수관되는데 왜 준비금환입이랑 준비금전입과 같은 계정들은 안넘어가는거야?", false],
	[BRIEF, false],
	["계속해서 초안이 깨지네. 수정 반영도 안되고. 이거 메인으로 옮겨서 원인 분석 세션 하나 시켜", true],
	["아니 그냥 매각손익으로 분개처리된거는 오류로 보고 대손상각비로 갈음해서 사용하면 되는데? 그러면 문제 없는거 아니냐", true],
	["아 안되네. 강제로 제거해", true],
	["아 저기 왜 갑자기 opus max로 처리하냐", true],
	["아 근데 왜 계속 영어 답변이 중간에 나오냐. 저거 생각 아닌가", true],
	["야잇 또 그러네. 구조적으로 막아야지", true],
] as const)("a question or a new brief is no correction, pushing back on the answer before is one: %s → %p", (text, want) => {
	expect(isCorrectionText(text)).toBe(want);
});

test("the entry names its message and the answer before it, also a lane's report and an answer the live ring no longer holds", () => {
	const dir = mkdtempSync(join(tmpdir(), "corrections-"));
	const file = join(dir, "corrections.jsonl");
	const at = (s: number) => new Date(Date.parse("2050-05-01T00:00:00.000Z") + s * 1000).toISOString();
	try {
		emit("inbox", { ts: at(0), kind: "lane_report", source: "lane:cl", lane: "cl", text: "기준 테스트를 마쳤어요." });
		const lane = { ts: at(1), kind: "lane_message", source: "web", lane: "cl", text: "아 근데 왜 계속 영어 답변이 나오냐", mid: "l1" };
		emit("inbox", lane);
		recordCorrection(lane, file);
		emit("outbox", { ts: at(2), kind: "out", source: "orchestrator", target: "ch:77", text: "초안을 고쳤어요." });
		for (let i = 0; i < 320; i++) emit("outbox", { ts: at(3 + i), kind: "out", source: "orchestrator", target: "ch:78", text: `다른 대화 ${i}` });
		const late = { ts: at(400), kind: "message", source: "web", channel: "ch:77", text: "계속해서 초안이 깨지네", mid: "c1" };
		emit("inbox", late);
		recordCorrection(late, file);
		const lines = readFileSync(file, "utf8").trimEnd().split("\n").map(l => JSON.parse(l) as Correction);
		expect(lines.map(l => [l.message_id, l.conv, l.previous])).toEqual([["l1", "lane:cl", "기준 테스트를 마쳤어요."], ["c1", "ch:77", "초안을 고쳤어요."]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
