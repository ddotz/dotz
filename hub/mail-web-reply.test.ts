// A web reply in a mail conversation reaches the orchestrator exactly as a message in that mail's Discord thread does: the same
// plugin `thread` hook runs (its note goes into the turn, its OK side effect is recorded), the answer target is the thread, and
// the plugin's command guard lets a send pass only after that OK. Drives the real web send path (hub/intake.ts sendWeb) up to
// the burst the orchestrator gets, with a fake plugin in a throwaway data dir.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as discord from "./discord.ts";
import { eventTarget, onEmit, type HubEvent } from "./events.ts";
import { bursts, inboxText, sendWeb } from "./intake.ts";
import { mailByKey, recordMail } from "./mail.ts";
import { loadPlugins, pluginDeny } from "./plugins.ts";

const data = mkdtempSync(join(tmpdir(), "dotz-mail-reply-"));
const THREAD = "1430000000000004242";
const OK_FILE = join(data, `ok-${THREAD}`);
const KEY = `kdb-r${Date.now().toString(36)}`;

// Shaped like the KDB plugin: the thread hook records an explicit OK and supplies the mail note; deny blocks the send without it.
const GUARD = `import { existsSync, writeFileSync } from "node:fs";
const OK = ${JSON.stringify(OK_FILE)};
export default {
	name: "mailguard",
	thread({ thread, text }) {
		if (thread !== ${JSON.stringify(THREAD)}) return undefined;
		if (/^\\s*(ㅇㅇ|ok|1\\) 보내기)\\s*$/i.test(text)) writeFileSync(OK, "1");
		return { parentName: "회사메일", note: "[mailguard] mail thread " + thread + (existsSync(OK) ? " (owner OK recorded)" : " (no OK yet)") };
	},
	deny(command) {
		if (!/\\bkdb-send\\b/.test(command)) return undefined;
		return existsSync(OK) ? undefined : "kdb-send needs the owner's OK in that mail's conversation";
	},
};
`;

const inbox: HubEvent[] = [];
beforeAll(async () => {
	mkdirSync(join(data, "custom", "plugins"), { recursive: true });
	writeFileSync(join(data, "custom", "plugins", "mailguard.ts"), GUARD);
	await loadPlugins(data);
	discord.channels.threads[THREAD] = { parent: "1561565203714408448", name: "견적 요청" };
	recordMail({ key: KEY, source: "kdb", id: KEY.slice(4), subject: "견적 요청", from: "Kim <kim@example.com>", at: new Date().toISOString(), thread: THREAD });
	onEmit(e => void (e.kind === "message" && e.source === "web" && inbox.push(e)));
});
afterAll(async () => {
	delete discord.channels.threads[THREAD];
	await loadPlugins(join(data, "none"));
});

// Sends through sendWeb and takes the burst it queued for the orchestrator (what flush would deliver), so no turn runs.
async function reply(text: string): Promise<{ target: string; turn: string; event: HubEvent }> {
	await sendWeb({ mail: mailByKey(KEY)!, channel: "web", text, mode: "default", login: "hyuns" });
	const [target, b] = [...bursts].find(([, x]) => x.events.some(e => e.text === text))!;
	clearTimeout(b.timer);
	bursts.delete(target);
	expect(b.events).toHaveLength(1);
	return { target, turn: inboxText(b.events[0]!), event: inbox.findLast(e => e.text === text)! };
}

test("a web reply goes to the mail's thread with the plugin's note, in the mail conversation", async () => {
	const r = await reply("이거 무슨 내용이야?");
	expect(r.target).toBe(`th:${THREAD}`);
	expect(r.turn).toContain(`[mailguard] mail thread ${THREAD} (no OK yet)`);
	expect(r.turn).toContain("견적 요청");
	expect(r.turn).toContain("회사메일");
	expect(r.event).toMatchObject({ channel: `th:${THREAD}`, conv: `mail:${KEY}`, thread_name: "견적 요청", parent_name: "회사메일" });
	expect(r.event).not.toHaveProperty("plugin_note");
	expect(eventTarget(r.event)).toBe(`mail:${KEY}`);
});

test("only an explicit OK in the conversation records the OK; the plugin's guard then lets the send pass", async () => {
	expect(pluginDeny(`kdb-send ${KEY}`, data)).toContain("needs the owner's OK");
	await reply("보내지 말고 기다려");
	expect(existsSync(OK_FILE)).toBe(false);
	expect(pluginDeny(`kdb-send ${KEY}`, data)).toContain("needs the owner's OK");
	const ok = await reply("ㅇㅇ");
	expect(existsSync(OK_FILE)).toBe(true);
	expect(ok.turn).toContain("(owner OK recorded)");
	expect(pluginDeny(`kdb-send ${KEY}`, data)).toBeUndefined();
});

test("a mail with no thread the hub knows answers in its web conversation, with the built-in mail note", async () => {
	const key = `zele-w${Date.now().toString(36)}`;
	recordMail({ key, source: "zele", id: key.slice(5), subject: "웹 전용", from: "Lee", at: new Date().toISOString() });
	await sendWeb({ mail: mailByKey(key)!, channel: "web", text: "요약해 줘", mode: "default", login: "hyuns" });
	const b = bursts.get(`mail:${key}`)!;
	clearTimeout(b.timer);
	bursts.delete(`mail:${key}`);
	const turn = inboxText(b.events[0]!);
	expect(turn).toContain(`zele ${key.slice(5)}`);
	expect(turn).toContain("웹 전용");
	expect(turn).not.toContain("[mailguard]");
	expect(turn).not.toContain('(thread "');
	expect(eventTarget(inbox.findLast(e => e.text === "요약해 줘")!)).toBe(`mail:${key}`);
});
