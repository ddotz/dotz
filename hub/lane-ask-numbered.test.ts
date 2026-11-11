// A session's [ask] that ends in a plain numbered list (split-panes, 2026-11-09): the owner saw a question with no buttons. Asked of the owner,
// the list becomes the choice block; asked of the orchestrator ("<bot> 몫:"), it stays the orchestrator's and waits on no owner answer.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bareAsk, normalizeAsk } from "./ask-normalize.ts";
import { pendingAskFile } from "./asks.ts";
import { parseDecisions } from "./choices.ts";
import { NAME, paths } from "./config.ts";
import { report } from "./lanereport.ts";
import { hooks, lanes, type Lane } from "./lanestate.ts";

// The lane's report as it was written, with its addressee line left out or given to this install's bot.
const BODY = "[ask] 대화창 분할은 main에 ff로 머지해 강제 없이 origin에 올렸어요(`b71f4668..307f722c`). 완료 조건 중 `full-test.log`의 \"0 fail\"만 아직 맞지 않아요.\n\n- **머지와 산출물:** `merge-base` 확인에서 `merged`가 나왔어요. `docs/split-panes.md`가 있고, 스크린샷은 26장 저장했어요.\n- **전체 테스트 결과:** 마지막 커밋 `307f722c`에서 6,440개 통과, 2개 실패예요.\n  - 실패한 두 시험은 메일 선택 동작(`hub/mail-box-web.test.ts`)과 계정 추가(`hub/providers-login-web.test.ts`)예요. 각각 따로 돌리면 23개, 8개 모두 통과해요.\n- **남은 두 가지:** Mac이 아닌 일부 키보드에서는 칸 나누기 키(Ctrl+Alt+`\\`)가 AltGr 입력과 겹쳐요.\n\n";
const LIST = "아래 둘 중 하나를 정해 주세요.\n1. 흔들리는 실패 2개를 받아들이고, 이 레인을 끝난 것으로 처리\n2. 전체 테스트를 한 번 더 돌려 `full-test.log`를 0 fail로 맞추기";
const TO_OWNER = `${BODY}${LIST}`;
const TO_BOT = `${BODY}${NAME} 몫: ${LIST}`;

const saved = hooks.report;
afterEach(() => void (hooks.report = saved));

test("a numbered list under the owner's question becomes a two-choice card", () => {
	const out = normalizeAsk(TO_OWNER);
	const [block, more] = parseDecisions(out).blocks;
	expect(more).toBeUndefined();
	expect(block!.options.map(o => o.label)).toEqual(["흔들리는 실패 2개를 받아들이고, 이 레인을 끝난 것으로 처리", expect.stringMatching(/^전체 테스트를 한 번 더 돌려/)]);
	expect(bareAsk(out)).toBe(false);
});

test("the same list handed to the orchestrator is no owner card and leaves no question waiting on the owner", () => {
	expect(parseDecisions(normalizeAsk(TO_BOT)).blocks).toEqual([]);
	const name = "ask-numbered-bot";
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const sent: string[] = [], relayed: string[] = [];
	const lane = { name, cwd: "/tmp", model: "m", status: "idle", startedAt: "", reports: 0, lastText: TO_BOT, ctx: { compaction: { state: "idle" } }, proc: { send: (t: string) => sent.push(t) } } as unknown as Lane;
	lanes.set(name, lane);
	hooks.report = (_l, text) => void relayed.push(text);
	report(lane, TO_BOT);
	lanes.delete(name);
	expect(sent).toEqual([]);
	expect(relayed).toEqual([TO_BOT]);
	expect(lane.pendingAsk).toBeUndefined();
	expect(existsSync(pendingAskFile(name))).toBe(false);
});
