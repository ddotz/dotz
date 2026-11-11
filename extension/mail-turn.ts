// A turn that an outside mail woke runs with the shell narrowed in code (the mail text can say anything, a prompt line is no guard):
// no stored secrets, no owner token, nothing sent out. hub/intake.ts marks such a turn's input with MAIL_TURN_MARK (hub/systemdeny.ts); the mark holds
// from that input to the end of the agent turn, whatever else arrives meanwhile. Turns the owner started carry no mark and are untouched.
import { externalAction } from "./guard.ts";
import { expandShellVars, shellText } from "./guard-shell.ts";

// mark and deny come from hub/systemdeny.ts (index.ts passes them: this layer's hub imports stay as they were).
export function installMailTurn(pi: any, mark: string, mailTurnDeny: (command: string) => string | undefined): void {
	let mailTurn = false;
	pi.on("input", (event: any) => void (mailTurn ||= String(event?.text ?? "").includes(mark)));
	pi.on("agent_end", () => void (mailTurn = false));
	pi.on("tool_call", (event: any) => {
		if (!mailTurn || (event?.toolName !== "bash" && event?.toolName !== "eval")) return;
		const command = expandShellVars(shellText(event.input));
		const why = mailTurnDeny(command) ?? (externalAction(command) && `it is an outbound command (${externalAction(command)})`);
		if (why) return { block: true, reason: `Blocked by dotz: this turn was started by an outside mail, and ${why}. Summarize the mail and ask the owner; the owner's own message starts a turn that may do this.` };
	});
}
