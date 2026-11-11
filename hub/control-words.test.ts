// A control word acts by where it stands, not by matching a whole message: every way out of the gateway reads it the same, and a sentence about it stays
// (owner 2026-11-05: "`[later]` 연도(2026)와 회차 제목을 확인했어요..." came through as a code chip; the check was `t === "[later]"`).
import { expect, test } from "bun:test";
import { emitEventActivity } from "./activity.ts";
import { previewOf } from "./conversations.ts";
import { buildPayloads } from "./discord-format.ts";
import { activityItems, type HubEvent, onEmit } from "./events.ts";
import { out } from "./outbound.ts";
import { noticeKo } from "./notice-ko.ts";
import { ownerText, shownEvent } from "./owner-text.ts";
import { classify } from "./push.ts";
import { isLater, laterParts, stripLater, stripMarkers } from "./tone.ts";

const PROSE = "이동이 끝나면 등록할게요.";
export const LATER_SHAPES = [
	"`[later]` 이동이 끝나면 등록할게요.\n\n[later]",
	"`[later]` 이동이 끝나면 등록할게요.",
	"[later] 이동이 끝나면 등록할게요.",
	"이동이 끝나면 등록할게요.\n\n[later]",
	"이동이 끝나면 등록할게요.\n\n`[later]`",
	"이동이 끝나면 등록할게요. [later]",
	"이동이 끝나면 등록할게요. `[later]`",
	"**[later]** 이동이 끝나면 등록할게요.",
];
const ABOUT = [
	"그 턴은 `[later]`로 끝나고 아무것도 가지 않아요.",
	"`[later]`로 끝나는 턴은 요청을 열어 둬요.",
	"`[later]` 표시가 보이던 문제를 고쳤어요.",
	"이 표식은 끝에 붙는 `[later]`",
	"- `[later]`: 답을 미루는 표식\n- `[done]`: 끝났다는 표식",
	"[later] 같은 표시는 안 보여요.\n\n예시예요.\n```\n[later]\n```",
];

test("words around [later]: the word is gone and the turn still counts as deferred", () => {
	for (const said of LATER_SHAPES) expect(laterParts(said)).toEqual({ later: true, text: PROSE });
	for (const bare of ["[later]", " `[later]`\n", "**[later]**"]) {
		expect(isLater(bare)).toBe(true);
		expect(laterParts(bare)).toEqual({ later: true, text: "" });
	}
	expect(laterParts("할 말이 없어요. -\n\n[later]")).toEqual({ later: true, text: "" });
	expect(laterParts("[done] 고쳤어요. [later]")).toEqual({ later: true, text: "[done] 고쳤어요." });
});

test("a sentence about the word stays as written and defers nothing", () => {
	for (const text of ABOUT.slice(0, 5)) {
		expect(laterParts(text)).toEqual({ later: false, text });
		expect(stripMarkers(text)).toBe(text);
	}
	expect(laterParts(ABOUT[5]!).later).toBe(false);
	expect(stripLater(ABOUT[5]!)).toBe(ABOUT[5]!);
});

test("the other control words read the same way at the edges, and only there", () => {
	expect(stripMarkers("`[done]` 고쳤어요.")).toBe("고쳤어요.");
	expect(stripMarkers("고쳤어요. `[ask]`")).toBe("고쳤어요.");
	expect(stripMarkers("고쳤어요.\n\n`[keepalive]`").trim()).toBe("고쳤어요.");
	expect(stripMarkers("[gateway check] [done] 아직 승인되지 않았어요.")).toBe("아직 승인되지 않았어요.");
	expect(stripMarkers("[web:alert] 모델이 바뀌었어요.")).toBe("모델이 바뀌었어요.");
	expect(stripMarkers("진행 중: [ask] 나눠서 옮겨요.")).toBe("진행 중: 나눠서 옮겨요.");
	expect(stripMarkers("다시 로그인했어요.\n\n-").trim()).toBe("다시 로그인했어요.");
	expect(stripMarkers("제가 [ask]로 물어요.")).toBe("제가 [ask]로 물어요.");
	expect(stripMarkers("-")).toBe("-");
});

test("every way out carries the prose without the word", () => {
	for (const said of LATER_SHAPES) {
		expect(ownerText(said)).toBe(PROSE);
		const stored = { ts: "2026-11-05T01:00:00.000Z", kind: "out", source: "orchestrator", target: "web", text: said };
		expect(shownEvent(stored).text).toBe(PROSE);
		expect(previewOf(said)).toBe(PROSE);
		expect(classify({ ...stored, target: "alert", text: ownerText(said) } as HubEvent, 10 * 60_000)?.body ?? "").not.toContain("later");
		expect(JSON.stringify(buildPayloads(ownerText(said)))).not.toContain("later");
		emitEventActivity("control-words", { type: "activity", row: { type: "text", text: said } } as never);
	}
	expect(new Set(activityItems("control-words").map(a => (a as { text: string }).text))).toEqual(new Set([PROSE]));
	expect(ABOUT.slice(0, 5).map(a => ownerText(a))).toEqual(ABOUT.slice(0, 5));
	expect(ownerText("[later]")).toBe("");
});

test("a For <bot> line never reaches Discord, under the bot's old name either", () => {
	const body = JSON.stringify(buildPayloads("고쳤어요.\n\n땃쥐 몫: 게이트웨이 재시작\nFor 땃쥐: 없음"));
	expect(body).toContain("고쳤어요");
	expect(body).not.toContain("재시작");
});

test("out stores the prose, keeps the waiting message open for a note, and posts nothing for a bare word", async () => {
	const seen: HubEvent[] = [];
	onEmit(e => void (e.target === "web" && seen.push(e)));
	await out("web", "`[later]` 복사가 끝나면 알릴게요.\n\n[later]", undefined, { keepsOpen: true });
	expect(seen.filter(e => e.kind === "out").map(e => e.text)).toEqual(["복사가 끝나면 알릴게요."]);
	expect(seen.some(e => e.kind === "delivery")).toBe(false);
	await out("web", "`[later]`");
	expect(seen.filter(e => e.kind === "out")).toHaveLength(1);
});

test("a --- line leaves no dashes on Discord, a code fence keeps them", () => {
	expect(buildPayloads("앞 문단이에요.\n\n---\n\n뒤 문단이에요.")[0]!.content).not.toContain("---");
	expect(buildPayloads("```\n---\n```")[0]!.content).toContain("---");
});

test("an id in brackets leaves Discord and a push, a code span keeps it", () => {
	expect(buildPayloads("워커(st_01a1a07f)가 돌아요. `(st_01a1a07f)`")[0]!.content).toBe("워커가 돌아요. `(st_01a1a07f)`");
	const push = classify({ kind: "lane_report", lane: "a", source: "lane:a", ts: "2026-11-05T01:00:00Z", text: "[done] 워커(st_01a1a07f)가 <#1500000000005984746>에 올렸어요." } as HubEvent);
	expect(push?.body).toBe("워커가 채널에 올렸어요.");
});

test("a bare worker id and a code word stay readable on Discord, a push and a preview", () => {
	const text = "[done] 답글 연결 수정. st_01a1a6ca가 멈춰 있으면 task_send로 이어 가요.";
	const read = "답글 연결 수정. 워커가 멈춰 있으면 task_send로 이어 가요.";
	expect(buildPayloads(text)[0]!.content).toBe(`✅ ${read}`);
	expect(classify({ kind: "lane_report", lane: "a", source: "lane:a", ts: "2026-11-05T01:00:00Z", text } as HubEvent)?.body).toBe(read);
	expect(previewOf(text)).toContain(read);
	// a preview and a push have no code style, so a quoted id in brackets goes as a bracketed one does
	const quoted = "[run] 게이트 리뷰어 판정을 기다려요(`st_01a1a780`).";
	expect(previewOf(quoted)).toBe("게이트 리뷰어 판정을 기다려요.");
	expect(classify({ kind: "lane_report", lane: "a", source: "lane:a", ts: "2026-11-05T01:00:00Z", text: quoted.replace("[run]", "[done]") } as HubEvent)?.body).toBe("게이트 리뷰어 판정을 기다려요.");
});

test("notice words keep an id and a half-named code word whole, and still name what they know", () => {
	expect(noticeKo("`st_01a1a6ca`는 `task_send`로, `dotz_send`는 lane_watch로 가요.")).toBe("`st_01a1a6ca`는 `task_send`로, 보내기는 세션 모니터링으로 가요.");
	expect(buildPayloads("로그는 /tmp/st_01a1a6ca/run.log, 번호 `st_01a1a6ca`예요.")[0]!.content).toBe("로그는 /tmp/st_01a1a6ca/run.log, 번호 `st_01a1a6ca`예요.");
});
