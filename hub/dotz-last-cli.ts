// `dotz last` (hub/dotz-command.ts): prints the newest answer of the main conversation. Read-only; it sends nothing.
import { HUB_TOKEN, PORT } from "./config.ts";
import type { HubEvent } from "./events.ts";
import { answerForTerminal, lastAnswer } from "./dotz-last.ts";
import { useColor } from "./spec-terminal.ts";

const r = await fetch(`http://127.0.0.1:${PORT}/api/history?target=main&limit=60`, { headers: { "x-dotz-token": HUB_TOKEN }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => {
	console.error(`게이트웨이가 실행 중이 아니에요 (${e.message})`);
	return process.exit(1);
});
const data = (await r.json().catch((e: Error) => ({ error: e.message }))) as { events?: HubEvent[] };
const text = r.ok ? lastAnswer(data.events ?? []) : undefined;
if (!text) {
	console.error(r.ok ? "아직 답변이 없어요" : `답변을 읽지 못했어요 (${r.status})`);
	process.exit(1);
}
console.log(answerForTerminal(text, useColor(process.env, !!process.stdout.isTTY)));
