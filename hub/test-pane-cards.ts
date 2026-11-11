import { idleState, json, type HubOptions } from "./test-web.ts";

// One conversation that holds every kind of card the timeline draws (owner's files, a table, a code block, a decision record, a session result,
// background tasks, a mail result card): the pane-cards test and the shot tool open it in a phone window and in a pane.
const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString();
const NOW = Date.UTC(2026, 9, 20, 1, 30);
const LONG_FILE = "2026년 하반기 견적서 최종본 수정 요청 반영.pdf";
const TABLE = ["| 구분 | 정상 | 스팸 | 바이러스 | 합계 |", "| --- | --- | --- | --- | --- |", "| 오늘 | 120 | 3 | 0 | 123 |", "| 어제 | 98 | 5 | 1 | 104 |"].join("\n");
const CODE = "```ts\nconst total = items.reduce((sum, item) => sum + item.price * item.count, 0); // 모든 품목의 합계를 구해요\n```";
const task = (id: string, title: string, i: number) => ({ ts: at(i), kind: "out", source: "gateway", target: "web", text: `백그라운드 작업으로 맡겼어요: ${title}`, system: "deferred", worker: id, work: { id, status: "running", at: NOW, created_at: NOW - 900_000 } });

export const CARD_HISTORY = [
	{ ts: at(0), kind: "message", source: "web", channel: "web", text: "견적서 확인해 줘", files: [{ name: LONG_FILE, path: `/tmp/${LONG_FILE}`, size: 482_304 }, { name: "메모.txt", path: "/tmp/메모.txt", size: 2048 }] },
	{ ts: at(1), kind: "out", source: "orchestrator", target: "main", text: `메일 점검 결과예요.\n\n${TABLE}\n\n합계를 구하는 코드는 이렇게 돼요.\n\n${CODE}` },
	{ ts: at(2), kind: "message", source: "web", channel: "web", text: "1) 보내기", picks: [{ q: "이 답장 보낼까요?", n: 1, label: "보내기" }, { q: "첨부 파일도 같이 보낼까요?", n: 2, label: "같이 보내기", note: "견적서만" }] },
	{ ts: at(3), kind: "result", source: "orchestrator", target: "main", open: "lane:가나", title: "가나", verified: true, text: "견적서 수정이 끝났어요.\n- 합계 금액을 다시 계산했어요\n- 받는 사람 주소를 바꿨어요\n- 첨부 파일 이름을 정리했어요" },
	task("st_1", "결과 파일을 모아서 정리한 뒤 다음 주 회의 자료까지 함께 만들어 두는 아주 긴 이름의 작업", 4),
	task("st_2", "일 2", 5),
	task("st_3", "일 3", 6),
	{ ts: at(7), kind: "mail", source: "mail", target: "main", subject: "월간 점검 보고", from: "Alex Sender <sender@example.com>", text: "Alex Sender <sender@example.com> · 월간 점검 보고\n\n요약\n이번 달 점검이 끝났어요. 스팸 차단은 정상이에요.\n\n할 일\n- 금요일까지 결과 확인\n- 담당자에게 회신" },
];

const lane = (name: string) => ({ name, status: "working", live: true, session: name });

// Every target answers with the same history, so a pane shows the same cards whether it is the open one or a mirror.
export const cardHub: HubOptions = {
	stream: "fake",
	state: () => idleState({ lanes: [lane("가나"), lane("다라")], work: [], work_now: NOW }),
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target") ?? "main", events: CARD_HISTORY });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations" || p === "/api/monitors") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		return undefined;
	},
};
