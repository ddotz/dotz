// A message that starts with "/" but names no command is an ordinary owner message on the server path every messenger and the web
// share (hub/intake.ts sendWeb): it reaches the session's burst or steer with its attachments and reply, and the gateway does not answer it (the burst or steer is the other branch of that one test).
import { expect, test } from "bun:test";
import { parseCommand } from "./control.ts";
import { onEmit, type HubEvent } from "./events.ts";
import { bursts, flush, sendWeb } from "./intake.ts";
import { orch } from "./orchestrator.ts";
import { inbox } from "./test-web.ts";

const PATH = "/Users/me/Downloads/분기 자료/2026년 2분기 자료/ 이거 자료파일 관리하는데 어떻게 할까";
const PLAIN = [PATH, "/tmp 폴더 정리해줘", "/foo bar", "/terminal ls", "/screen", "/tmp/a.txt", "/Foo"];
const seen = inbox<HubEvent>();
onEmit(e => void seen.push(e));
const cards = () => seen.filter(e => e.card);
const take = (text: string) => {
	const hit = [...bursts].find(([, b]) => b.events.some(e => e.text === text));
	if (!hit) return undefined;
	clearTimeout(hit[1].timer);
	bursts.delete(hit[0]);
	return hit[1].events[0];
};

test.each(PLAIN)("%s is not a command", text => expect(parseCommand(text)).toBeUndefined());

test.each(PLAIN)("%s goes to the session with no command card", async text => {
	await sendWeb({ channel: "web", text, mode: "default", login: "local" });
	expect(take(text)?.text).toBe(text);
});

test("a messenger's unknown word keeps its attachment and reply", async () => {
	const files = [{ name: "a.xlsx", type: "application/vnd.ms-excel", path: "/tmp/a.xlsx", size: 1 }];
	const reply = { id: "m1", author: "owner", content: "앞 메시지" };
	await sendWeb({ source: "slack", channel: "web", text: "/foo bar", mode: "default", login: "owner", files, reply } as Parameters<typeof sendWeb>[0]);
	const event = take("/foo bar");
	expect(event?.source).toBe("slack");
	expect(event?.attachments?.[0]?.name).toBe("a.xlsx");
	expect(event?.reply).toEqual(reply);
});

test("steering into a working session takes an unknown word too", async () => {
	seen.length = 0;
	const was = orch.status;
	orch.status = "working";
	process.env.DOTZ_NO_ORCHESTRATOR = "1";
	try {
		await sendWeb({ channel: "web", text: "/foo bar", mode: "steer", login: "local" });
		flush("web");
	} finally {
		orch.status = was;
		delete process.env.DOTZ_NO_ORCHESTRATOR;
	}
	expect(seen.filter(e => e.kind === "delivery")).toHaveLength(1);
});

test("a real command is still answered by the gateway, and its own argument error stays an error card", async () => {
	seen.length = 0;
	await sendWeb({ channel: "web", text: "/lanes", mode: "default", login: "local" });
	await sendWeb({ channel: "web", text: "/effort nosuchlane high", mode: "default", login: "local" });
	await seen.until(() => cards().length === 2);
	expect(take("/lanes")).toBeUndefined();
	expect(cards()[1]?.card?.tone).toBe("err");
});
