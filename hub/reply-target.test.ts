// Replays the reply targets of 2026-11-05 (KST) from outbox.jsonl: a post that names no message must attach to nothing.
import { expect, test } from "bun:test";
import { createPrompts } from "./prompts.ts";
import { lateRequestId } from "./threads.ts";

const LONG_AGO = () => Date.now() - 60 * 60_000;

function setup() {
	const posts: { text: string; replyTo?: string }[] = [];
	const q = createPrompts({
		deliver: () => {},
		steer: () => true,
		working: () => false,
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: async (_target, text, replyTo) => (posts.push({ text, replyTo }), { delivered: true }),
		clearProgress: () => {},
		persist: () => {},
		log: () => {},
	});
	// The owner's request, handed to a background worker.
	const waiting = (id: string, worker: string) => {
		q.deliver(`[dotz inbox] web msg=${id}`, { target: "web", replyTo: id, owner: true });
		q.onPrompt(`[dotz inbox] web msg=${id}`);
		q.workersSpawned([{ id: worker }]);
		q.onAnswer("[later]");
		q.settleTurn();
	};
	// /api/send, then what out() does with a post that names no message, then the delivery settling what the post answers.
	const dotzSend = (text: string, replyTo?: string) => {
		const answers = q.sent("web", text, replyTo);
		const ref = replyTo ?? answers ?? lateRequestId("web", q.current(), "newer", LONG_AGO);
		if (ref) q.markAnswered(ref);
		posts.push({ text, replyTo: ref });
	};
	return { q, posts, waiting, dotzSend };
}

test("three posts of 01:08, 01:25 and 01:33 that named no message attach to nothing and close no waiting request", () => {
	const { q, posts, waiting, dotzSend } = setup();
	waiting("0ed8d967", "st_01a1a6fb");
	waiting("6f8e7bed", "st_01a1a701");
	waiting("e05e1e49", "st_01a1a715");
	waiting("c2600951", "st_01a1a751");
	waiting("97b4ef02", "st_01a1a74f");
	q.deliver("[dotz inbox] web msg=5ec6bae2", { target: "web", replyTo: "5ec6bae2", owner: true });
	q.onPrompt("[dotz inbox] web msg=5ec6bae2");
	q.workersSteered(["st_01a1a751"]);
	q.onAnswer("[later]");
	q.settleTurn();

	// 01:08: a lane's [ask] starts a turn of its own, which forwards it.
	q.deliver("[dotz inbox] session report: cloudflare-webapp");
	q.onPrompt("[dotz inbox] session report: cloudflare-webapp");
	dotzSend("[ask] 외부 접속 세션이 Ovis 결과를 반영해 결정 세 가지를 새로 올렸어요");
	q.onAnswer("-");
	q.settleTurn();

	// 01:25: st_01a1a751 wakes a run; a lane report is steered in. Its first send answers the worker's request, the second forwards the
	// report, and the run spawns the next worker with the wake already spent.
	q.workersDone(["st_01a1a751"]);
	dotzSend("✅ 같은 질문이 두 줄로 뜨던 것을 고쳤어요", "5ec6bae2");
	dotzSend("[ask] 코드 점검 세션이 끝나 가요");
	q.workersSpawned([{ id: "st_01a1a761" }]);
	q.onAnswer("-");
	q.settleTurn();

	// 01:33: that worker reports. Nothing ties it to a message, whatever waited when it started.
	q.workersDone(["st_01a1a761"]);
	dotzSend("✅ 업데이트 게이트가 다시 통과해요");
	q.onAnswer("-");
	q.settleTurn();

	expect(q.linkOf("st_01a1a761")).toMatchObject({ target: "web" });
	expect(q.linkOf("st_01a1a761")?.replyTo).toBeUndefined();
	expect(posts.map(p => p.replyTo)).toEqual([undefined, "5ec6bae2", undefined, undefined]);
	expect(q.deferredOpen().map(d => d.replyTo)).toEqual(["0ed8d967", "6f8e7bed", "e05e1e49", "97b4ef02"]);
});

test("00:29: a run's answer woken by a worker no request is linked to reaches the conversation, on no message, and leaves the request open", async () => {
	const { q, posts, waiting } = setup();
	waiting("e6d8285d", "st_cloudflare");
	q.workersDone(["st_lessons"]);
	q.onAnswer("✅ 교훈 구조 수정 중 금지 사항 잘림과 UI 규칙 전달, 두 건이 끝났어요");
	await Bun.sleep(0);
	expect(posts).toEqual([{ text: "✅ 교훈 구조 수정 중 금지 사항 잘림과 UI 규칙 전달, 두 건이 끝났어요", replyTo: undefined }]);
	expect(q.deferredOpen().map(d => d.replyTo)).toEqual(["e6d8285d"]);
});

test("a run woken by a linked worker still answers that worker's request, with the post carrying it", () => {
	const { q, posts, waiting, dotzSend } = setup();
	waiting("a1", "st_a");
	waiting("b2", "st_b");
	q.workersDone(["st_b"]);
	dotzSend("끝났어요");
	expect(posts.map(p => p.replyTo)).toEqual(["b2"]);
	expect(q.deferredOpen().map(d => d.replyTo)).toEqual(["a1"]);
});
