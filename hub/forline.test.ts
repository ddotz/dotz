import { expect, test } from "bun:test";
import { NAME } from "./config.ts";
import { waitsOnMain } from "./forline.ts";

const verdicts = (texts: string[]) => texts.map(t => [t, waitsOnMain(t)]);

test("a [wait] that hands main the work in other words, or in English, waits on main", () => {
	const texts = [
		"[wait] 릴리스와 업데이트는 메인에 맡겼어요",
		"[wait] 메인에 릴리스를 요청했어요",
		"[wait] 메인에 부탁해 뒀어요",
		"[wait] 남은 배포는 메인에 넘겼어요",
		"[wait] 메인에서 게이트웨이를 다시 띄우면 이어서 해요",
		"[wait] Waiting for main to cut a release",
		"[wait] main needs to restart the gateway before I go on",
	];
	expect(verdicts(texts)).toEqual(texts.map(t => [t, true]));
});

test("main as the branch, a page, a screen or a function is no wait on main", () => {
	const texts = [
		"[wait] 메인 페이지 빌드를 기다려요",
		"[wait] 메인 화면 스크린샷 CI를 기다려요",
		"[wait] 메인 함수 리팩터 워커를 기다려요",
		"[wait] CI가 끝나면 메인에 머지해요",
		"[wait] 메인에 병합 요청을 올렸고 CI를 기다려요",
		"[wait] 메인에 올리기 전에 CI를 기다려요",
		"[wait] 메인에 push 한 뒤 Actions를 기다려요",
		"[wait] 메인에서 브랜치를 따서 워커를 돌려요",
		"[wait] Waiting for CI before merging the fix to main",
		"[wait] waiting for the main branch build",
		"[wait] tests are green on main, waiting for the deploy job",
		"[wait] fixed the main page, waiting for CI",
		"[wait] 피드백을 받은 뒤 main에 머지할게요",
		"[wait] main 최신에서 전체 시험을 다시 돌리려고 기다려요",
		"[wait] `main`에 합치기 전이라 Actions를 기다려요",
		"[wait] After merging the latest main (27b4e63) the run is still going",
		"[wait] Once the run finishes, I'll fast-forward main to b597cb9",
		"[wait] evidence: the job is running, now main f195459a",
	];
	expect(verdicts(texts)).toEqual(texts.map(t => [t, false]));
});

test("a For line that says there is nothing in a full sentence asks main for nothing", () => {
	expect(waitsOnMain(`[wait] CI를 기다려요\n\n${NAME} 몫: 없어요.`)).toBe(false);
	expect(waitsOnMain(`[wait] CI를 기다려요\n\n${NAME} 몫: 없습니다`)).toBe(false);
	expect(waitsOnMain(`[wait] CI를 기다려요\n\n${NAME} 몫: 재시작해 주세요`)).toBe(true);
});

test("the bot's own name counts only as the one who acts, is asked or is waited on", () => {
	const named = [`[wait] ${NAME}에게 릴리스를 부탁했어요`, `[wait] ${NAME}의 답을 기다려요`, `[wait] ${NAME}의 "정리 끝" 신호를 받은 뒤에 시작해요`, `[wait] ${NAME}이 재시작해 주길 기다려요`, `[wait] waiting for ${NAME} to restart the gateway`];
	const other = [`[wait] ${NAME} 대시보드 배포 결과를 기다려요`, `[wait] ${NAME} 저장소의 CI를 기다려요`];
	expect(verdicts(named)).toEqual(named.map(t => [t, true]));
	expect(verdicts(other)).toEqual(other.map(t => [t, false]));
});
