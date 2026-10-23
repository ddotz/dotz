import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCall } from "../../../hub/reply-draft.ts";

export type TestEnv = { dir: string; cleanup: () => void };

// A temp data dir per test file: the feature reads DOTZ_DIR on every call, so nothing touches the machine's real data.
export function setupEnv(): TestEnv {
	const dir = mkdtempSync(join(tmpdir(), "rd-"));
	const before = process.env.DOTZ_DIR;
	process.env.DOTZ_DIR = dir;
	return {
		dir,
		cleanup: () => {
			rmSync(dir, { recursive: true, force: true });
			if (before === undefined) delete process.env.DOTZ_DIR;
			else process.env.DOTZ_DIR = before;
		},
	};
}

export function enable(env: TestEnv, extra: object = {}): void {
	mkdirSync(join(env.dir, "custom", "reply-drafts"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true, ...extra }));
}

export const j = (o: object) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

export function fakeModel(outs: string[]) {
	const calls: { system: string; user: string }[] = [];
	const call: ModelCall = async (system, user) => {
		calls.push({ system, user });
		return outs[Math.min(calls.length - 1, outs.length - 1)]!;
	};
	return { call, calls };
}

// What the gateway's web send writes to inbox.jsonl for a decision answer (hub/notices.ts answerDecision), a bit in the future of any draft.
export function pick(env: TestEnv, id: string, n: 1 | 2 | 3, note?: string, source = "web"): void {
	const label = ["보내기", "고치기", "보내지 않기"][n - 1]!;
	const text = `${n}) ${label}${note ? ` - ${note}` : ""}`;
	appendFileSync(join(env.dir, "inbox.jsonl"), `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source, text, picks: [{ q: `이 답장 보낼까요? (${id})`, n, label }] })}\n`);
}

export const mailFixture = { key: "m-1", target: "main", thread: "t1", source: "zele", id: "msg-1", subject: "회의 일정 문의", from: "Kim <kim@example.com>", to: "me@example.net", body: "다음 주 회의 일정을 알려 주실 수 있을까요?" };
export const goodReply = { action: "draft", reason: "asks a question", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요.", questions: [] };
