// A web-only install (no Discord bot token): worklog and alert posts are web posts, so the web app (notices, push) has them and the
// send reports them delivered, instead of a Discord send that can only fail and is dropped from the send ledger (hub/outbound.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as discord from "./discord.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { alert, out, progress, send, sends } from "./outbound.ts";

// Another test file in the same run may have configured Discord: this file is the install without it.
const was = discord.status.enabled;
beforeAll(() => void (discord.status.enabled = false));
afterAll(() => void (discord.status.enabled = was));

const seen: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && (e.target === "worklog" || e.target === "alert") && String(e.text).includes("웹 전용") && seen.push(e)));
const chats: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && String(e.text).includes("웹 대화") && chats.push(e)));

test("worklog and alert posts reach the web and count as delivered when Discord is not configured", async () => {
	expect(await out("worklog", "[done] 웹 전용 작업 기록")).toEqual({ delivered: true });
	expect(await out("alert", "[fail] 웹 전용 알림")).toEqual({ delivered: true });
	expect(await progress("worklog", "lane:web-only", "[run] 웹 전용 진행")).toEqual({ delivered: true });
	alert("웹 전용 게이트웨이 알림");
	expect(seen.map(e => `${e.target}:${e.text}`)).toEqual([
		"worklog:[done] 웹 전용 작업 기록",
		"alert:[fail] 웹 전용 알림",
		"worklog:[run] 웹 전용 진행",
		"alert:웹 전용 게이트웨이 알림",
	]);
	expect(sends.items().filter(i => i.text.includes("웹 전용"))).toEqual([]);
});

test("lane, chat, work channel and thread sends reach the web and count as delivered when Discord is not configured", async () => {
	for (const t of ["lane:web-only", "main", "ch:1", "th:1"]) expect(await out(t, `[done] 웹 대화 ${t}`)).toEqual({ delivered: true });
	// A lane's own report / note / notice (hub/lanewire.ts) is in the web already; its send is not a Discord send that can only fail.
	expect(await send("lane:web-only", "[done] 웹 대화 레인 보고")).toEqual({ delivered: true });
	expect(chats.map(e => e.text)).toEqual(["lane:web-only", "main", "ch:1", "th:1"].map(t => `[done] 웹 대화 ${t}`));
	expect(sends.items().filter(i => i.text.includes("웹 대화"))).toEqual([]);
});
