// A report, progress line or owner message in a ko install that carries an English paragraph: the lane report goes back to the session once,
// then through; every outbound text with such a paragraph counts as off-language, so the rewrite (hub/outlang.ts localize) takes it.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cfg, paths } from "./config.ts";
import { report } from "./lanereport.ts";
import { hooks, lanes, type Lane } from "./lanestate.ts";
import { languageMismatch } from "./outlang.ts";

// The prune-tests report as main received it (2026-11-18).
const INCIDENT = "Two workers (lint move, PAST·NOTHING·duplicate cleanup) are running, and the baseline full-suite run is still going.\n\n[run] 린트 이동과 PAST·NOTHING·중복 정리 워커 2개를 띄웠고, 기준 전체 테스트가 돌고 있어요.";
const KOREAN_DEV =
	'[run] red test가 green이 됐어요. `bun test hub/report-lang.test.ts`로 확인했고 HEAD는 origin/main 위에 있어요.\n\n수정은 hub/lanereport.ts와 ~/Code/dotz/hub/outlang.ts 두 곳이고, gate 로그에 "report refused (not in the install language)" 한 줄이 남아요. PR #4821, sha 3f9c2ab0도 그대로 적었어요.\n\n```\nThe baseline full-suite run is still going and all workers are green.\n```';

const savedReport = hooks.report;
const savedIdentity = cfg.identity;
let tick = 0;
const made: Lane[] = [];
afterEach(() => {
	for (const lane of made.splice(0)) {
		clearTimeout(lane.watchdog);
		lanes.delete(lane.name);
	}
});
beforeAll(() => {
	cfg.identity = { ...cfg.identity, language: "ko" };
});
afterAll(() => {
	hooks.report = savedReport;
	cfg.identity = savedIdentity;
});

function fakeLane(): { lane: Lane; sent: string[]; reports: string[] } {
	const sent: string[] = [];
	const reports: string[] = [];
	hooks.report = (_lane, text) => void reports.push(text);
	const name = `rl-${++tick}`;
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const lane = { name, cwd: "/tmp", model: "m", status: "idle", startedAt: "", reports: 0, lastText: "", ctx: { compaction: { state: "idle" } }, proc: { send: (t: string) => sent.push(t) } } as unknown as Lane;
	lanes.set(name, lane);
	made.push(lane);
	return { lane, sent, reports };
}

test("the incident report (English paragraph above [run]) goes back to the lane once with a Korean reason, then passes", () => {
	const { lane, sent, reports } = fakeLane();
	report(lane, INCIDENT);
	expect(reports).toEqual([]);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("Two workers (lint move,");
	expect(sent[0]).toMatch(/[가-힣]/);

	const again = `${INCIDENT} `;
	report(lane, again);
	expect(sent).toHaveLength(1);
	expect(reports).toEqual([again]);
	lanes.delete(lane.name);
});

test("Korean text before the status line is also sent back once", () => {
	const { lane, sent, reports } = fakeLane();
	report(lane, "워커 둘이 돌고 있어요.\n\n[run] 기준 전체 테스트가 돌고 있어요.");
	expect(reports).toEqual([]);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("워커 둘이");
	lanes.delete(lane.name);
});

test("Korean prose with dev terms, code, paths, ids and an English quoted string passes on the first try", () => {
	const { lane, sent, reports } = fakeLane();
	report(lane, KOREAN_DEV);
	expect(sent).toEqual([]);
	expect(reports).toHaveLength(1);
	lanes.delete(lane.name);
	expect(languageMismatch(KOREAN_DEV, "ko")).toBe(false);
});

test("progress lines and owner messages: one English paragraph in a mostly Korean text is off-language, so the shared rewrite takes it", () => {
	expect(languageMismatch(INCIDENT, "ko")).toBe(true);
	expect(languageMismatch("[run] red test가 green이 됐어요, HEAD 그대로예요.", "ko")).toBe(false);
	expect(languageMismatch(INCIDENT, "en")).toBe(false);
});
