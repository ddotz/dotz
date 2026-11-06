import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correctionEntry, isCorrection, isCorrectionText, recordCorrection, topicOf, type Correction } from "./corrections.ts";
import fixture from "./corrections.fixture.json";
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
