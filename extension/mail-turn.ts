// A turn that an outside mail woke runs with the shell narrowed in code (the mail text can say anything, a prompt line is no guard):
// no stored secrets, no owner token, nothing sent out. hub/intake.ts marks such a turn's input with MAIL_TURN_MARK (hub/systemdeny.ts); the mark holds
// from that input to the end of the agent turn, whatever else arrives meanwhile. Turns the owner started carry no mark and are untouched.
import { externalAction } from "./guard.ts";
import { expandShellVars, shellText } from "./guard-shell.ts";

export interface MailTurnState {
	marked: Set<symbol>;
}

export const createMailTurnState = (): MailTurnState => ({ marked: new Set() });

// why(platform): omp runs a task subagent in the same process as its parent but never sends it the parent's input event, and it may import this module again with a fresh graph; the state lives on globalThis (omp@18.22.0 docs/extensions.md)
const SHARED = Symbol.for("dotz.mailTurn");
const shared = globalThis as { [SHARED]?: MailTurnState };
const processState = (): MailTurnState => (shared[SHARED] ??= createMailTurnState());

// mark and deny come from hub/systemdeny.ts (index.ts passes them: this layer's hub imports stay as they were).
export function installMailTurn(pi: any, mark: string, mailTurnDeny: (command: string) => string | undefined, state: MailTurnState = processState()): void {
	const mine = Symbol("mail-turn");
	if (state.marked.size > 0) state.marked.add(mine);
	pi.on("input", (event: any) => {
		if (String(event?.text ?? "").includes(mark)) state.marked.add(mine);
	});
	pi.on("agent_end", () => void state.marked.delete(mine));
	pi.on("tool_call", (event: any) => {
		if (state.marked.size === 0 || (event?.toolName !== "bash" && event?.toolName !== "eval")) return;
		const command = expandShellVars(shellText(event.input));
		const why = mailTurnDeny(command) ?? (externalAction(command) && `it is an outbound command (${externalAction(command)})`);
		if (why) return { block: true, reason: `Blocked by dotz: this turn was started by an outside mail, and ${why}. Summarize the mail and ask the owner; the owner's own message starts a turn that may do this.` };
	});
}
