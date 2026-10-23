import { afterAll, beforeAll, expect, test } from "bun:test";
import { onEmit, type HubEvent } from "./events.ts";
import { bursts, inboxText, sendWeb } from "./intake.ts";
import { listMonitors } from "./monitors.ts";
import { addWatch, allWatches, removeWatch, startWatches } from "./watch.ts";

// A message in a monitor's conversation is an inbox turn on this gateway, tagged with the monitor (name, label, type, state, last output),
// so the orchestrator has the context without asking. Drives the real web send path (hub/intake.ts sendWeb) up to the burst it queues.
const inbox: HubEvent[] = [];
beforeAll(() => {
	startWatches(() => {});
	onEmit(e => void (e.kind === "message" && e.source === "web" && inbox.push(e)));
	const w = addWatch({ name: "login-cartier-com", label: "까르띠에 로그인 유지", session_url: "https://www.cartier.com/ko-kr/login", refresh_hours: 6, every_minutes: 30, on: "fail", to: "alert" }, "");
	const live = allWatches().find(x => x.id === w.id)!;
	Object.assign(live.state, { fails: 3, kind: "login", kindFails: 3, lastRun: "2026-10-23T05:32:00.000Z", lastOk: "2026-10-23T03:02:00.000Z", last: "DOTZ_FAIL login\n로그인 화면이 다시 나왔어요" });
});
afterAll(() => { for (const w of allWatches()) removeWatch(w.id); });

test("the monitor list carries the status words the detail header shows", () => {
	const m = listMonitors().find(x => x.watch === "login-cartier-com")!;
	expect(m).toMatchObject({ kind: "watch", last_result: "fail", fails: 3, last_ok: "2026-10-23T03:02:00.000Z", keeper: true });
	expect(m.last_output).toContain("로그인이 풀렸어요");
});

test("a message to the monitor's conversation becomes an inbox turn tagged with the monitor", async () => {
	await sendWeb({ settings: "w:login-cartier-com", channel: "web", text: "다시 로그인해 줘", mode: "default", login: "hyuns" });
	const [target, b] = [...bursts].find(([, x]) => x.events.some(e => e.text === "다시 로그인해 줘"))!;
	clearTimeout(b.timer);
	bursts.delete(target);
	expect(target).toBe("settings:w:login-cartier-com");
	expect(inbox.findLast(e => e.text === "다시 로그인해 줘")!.channel).toBe("settings:w:login-cartier-com");
	const turn = inboxText(b.events[0]!);
	for (const s of ["login-cartier-com", "까르띠에 로그인 유지", "로그인 유지", "실패 3번 연속", "로그인이 풀렸어요", "[settings:w:login-cartier-com]", "다시 로그인해 줘"]) expect(turn).toContain(s);
});
