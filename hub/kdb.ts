// KDB company mail, taken over from 오모냥 (the owner's earlier assistant). The launchd watcher dev.ddotz.kdbmail keeps
// posting each mail as a summary + thread in the mail channel and asking for FIDO approval in the alert channel; dotz
// only takes the agent side, through the existing scripts (kdb-mail-act.ts drives Aside; nothing here talks to KDB):
// - an owner message in a mail thread (a key of kdb-mail-threads.json) reaches the orchestrator with the mail id and the
//   rules (draft in the owner's style, send / forward / trash only after an explicit OK in that thread);
// - an explicit OK there is recorded per mail id, and the command guard lets `kdb-mail-act.ts ... --send` and `trash` run
//   only while such an OK is fresh: mail leaves the bank only on the owner's word, whatever the model decides;
// - 재요청/ㅇㅇ in the alert channel while the watcher waits approves the dotz watch `kdb-login` (approval_minutes gate),
//   whose check (hub/kdb-approve.ts) hands the approval to the watcher's file. Never a FIDO push without it.
// Off unless config.json has `kdb` with both channel ids. No config.ts import: the extension's command guard loads this too.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type KdbConfig = { dir: string; mail_channel: string; alert_channel: string };
export const KDB_WATCH = "kdb-login";
export const OK_TTL_MS = 15 * 60_000;

export function kdbConfig(raw: unknown, home = homedir()): KdbConfig | undefined {
	const k = raw as { enabled?: boolean; dir?: string; mail_channel?: unknown; alert_channel?: unknown } | undefined;
	if (!k || k.enabled === false || !k.mail_channel || !k.alert_channel) return undefined;
	const dir = String(k.dir ?? "~/.ddotz").replace(/^~(?=\/|$)/, home);
	return { dir, mail_channel: String(k.mail_channel), alert_channel: String(k.alert_channel) };
}

const readJson = (file: string): any => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

// Thread id -> KDB mail id, from the watcher's map (read on every message: the watcher adds threads all the time).
export function mailIdOf(c: KdbConfig, threadId: string): number | undefined {
	const id = readJson(join(c.dir, "kdb-mail-threads.json"))?.[threadId];
	return typeof id === "number" ? id : undefined;
}

// The whole message is one explicit yes (a "보내기 전에 제목 바꿔" is not).
const OK = /^\s*(ㅇㅇ|ㅇㅋ|응|네|예|ok|okay|오케이|좋아|그래|보내|보내(줘|요|자|라)|전송(해|해줘|해요)?|삭제(해|해줘|해요)?|전달(해|해줘|해요)?|지워(줘|요)?|ㄱㄱ|고)\s*[.!~ㅎ]*\s*$/i;
export const isConfirm = (text: string) => OK.test(text);
// The watcher's prompt says "재요청이라고 답해줘요"; a bare yes counts as well.
export const isFidoGo = (text: string) => /재요청/.test(text) || OK.test(text);

// The watcher asked and waits: logged out with an open approval question (kdb-mail-state.json).
export function waitingApproval(c: KdbConfig): boolean {
	const s = readJson(join(c.dir, "kdb-mail-state.json"));
	return Boolean(s?.loggedOut && s?.askedApproval);
}

const okFile = (dataDir: string, mailId: number) => join(dataDir, "kdb", `ok-${mailId}`);
export function recordOk(dataDir: string, mailId: number, now = Date.now()): void {
	mkdirSync(join(dataDir, "kdb"), { recursive: true });
	writeFileSync(okFile(dataDir, mailId), String(now));
}
function freshOk(dataDir: string, mailId: number, now: number): boolean {
	const f = okFile(dataDir, mailId);
	if (!existsSync(f)) return false;
	const at = Number(readFileSync(f, "utf8").trim()) || statSync(f).mtimeMs;
	return now - at <= OK_TTL_MS;
}

// Command guard: a send or trash through kdb-mail-act.ts needs a fresh owner OK for every mail id it names; the OK is
// used up when the command is allowed, so one yes sends one mail once. A command whose id is not a literal is refused.
export function kdbActBlock(command: string, dataDir: string, now = Date.now()): string | undefined {
	if (!/kdb-mail-act\.ts/.test(command) || !(/--send\b/.test(command) || /kdb-mail-act\.ts['"]?\s+['"]?trash\b/.test(command))) return undefined;
	const ids = [...command.matchAll(/kdb-mail-act\.ts['"]?\s+['"]?(?:trash|reply|forward)['"]?\s+['"]?(\d+)/g)].map(m => Number(m[1]));
	if (!ids.length) return "kdb-mail-act.ts send/trash must name the mail id literally (kdb-mail-act.ts reply <id> ... --send)";
	const missing = ids.filter(id => !freshOk(dataDir, id, now));
	if (missing.length) return `mail ${missing.join(", ")}: no explicit OK (ㅇㅇ/보내/삭제) from the owner in that mail thread within ${OK_TTL_MS / 60_000} min; post the draft (dry run) and wait for it`;
	for (const id of ids) rmSync(okFile(dataDir, id), { force: true });
	return undefined;
}

// The orchestrator's brief for one owner message in a mail thread.
export function mailThreadNote(c: KdbConfig, mailId: number): string {
	const act = `bun ${join(c.dir, "kdb-mail-act.ts")}`;
	return [
		`[KDB company mail ${mailId}] This thread is one company mail (the watcher posted it). The owner's word decides:`,
		`- 답장 / 전체답장 (--all): draft in his style (${join(c.dir, "kdb-mail-style.md")}, no signature; draft with a worker on anthropic/claude-sonnet-5-5 thinking high), fill it with \`${act} reply ${mailId} --body-file <f> [--all]\` (no --send = dry run, screenshot /tmp/kdb-compose-${mailId}.png), post the draft text here, and send only after he answers with an explicit OK here (ㅇㅇ / 보내): then the same command with --send.`,
		`- 전달: \`${act} resolve <name>\` (exit 3 / several candidates -> show name, dept, email and ask), dry run \`${act} forward ${mailId} --to <who> --body-file <f>\`, confirm recipient and text here, then --send after his OK.`,
		`- 삭제: ask to confirm, then \`${act} trash ${mailId}\` after his OK. 내용 확인: \`${act} show ${mailId}\`.`,
		`- 차단: a delete filter rule for the sender (no block button): https://mail.kdb.co.kr/mail/#settings/filters in Aside (${join(c.dir, "OMONYANG_NOTES.md")} §KDB company mail has the steps); confirm first.`,
		"The gateway refuses --send and trash until his OK in this thread (valid 15 min, one use). Needs Aside running. Report the result here. Never send, forward or trash on your own judgment.",
	].join("\n");
}
