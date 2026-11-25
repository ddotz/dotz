import { say } from "../notice.ts";

const EXPIRES_MS = 15 * 60_000;
const COMMAND = /^\/handoff(?:\s+([\s\S]*))?$/;

interface Ctx {
	agent?: { kind?: string };
}

/** The omp extension API surface the handoff resume uses; `session_compact` carries `compactionEntry.method` (omp `shared-events.ts` `SessionCompactEvent`, `session-entries.ts` `CompactionEntry`) and `input` carries `text` (`InputEvent`). */
export interface HandoffResumeApi {
	on(event: "input", handler: (event: { text: string }, ctx: Ctx) => void): void;
	on(event: "session_compact", handler: (event: { compactionEntry: { method?: string } }, ctx: Ctx) => void): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "aside"; triggerTurn: boolean }): void;
}

const resumeText = (focus: string): string =>
	say({
		en: `The owner ran /handoff.${focus === "" ? " " : `\nTheir focus, verbatim:\n${focus}\n`}The handoff document above is your plan. Continue its Next Steps now, from the first one that is not finished. Decisions recorded there are settled; do not ask the owner about them again.`,
		ko: `사용자가 /handoff를 실행했습니다.${focus === "" ? " " : `\n사용자가 지정한 내용(원문):\n${focus}\n`}위의 핸드오프 문서가 계획입니다. 그 Next Steps를 끝나지 않은 첫 항목부터 지금 바로 이어서 진행하세요. 문서에 기록된 결정은 확정된 것이므로 사용자에게 다시 묻지 마세요.`,
	});

/** Makes a `/handoff` the owner types resume work at once: the manual handoff only commits the document and never starts a turn, so the session would idle until the owner types again. An automatic handoff runs inside a turn that continues on its own and is left alone. */
export function createHandoffResume(pi: HandoffResumeApi): void {
	let armed: { focus: string; at: number } | undefined;

	pi.on("input", (event, ctx) => {
		if (ctx.agent?.kind !== "main") return;
		const typed = COMMAND.exec(event.text.trim());
		armed = typed === null ? undefined : { focus: (typed[1] ?? "").trim(), at: Date.now() };
	});

	pi.on("session_compact", (event, ctx) => {
		if (ctx.agent?.kind !== "main" || event.compactionEntry.method !== "handoff" || armed === undefined) return;
		const { focus, at } = armed;
		armed = undefined;
		if (Date.now() - at >= EXPIRES_MS) return;
		pi.sendMessage({ customType: "session-handoff", content: resumeText(focus), display: true }, { deliverAs: "aside", triggerTurn: true });
	});
}
