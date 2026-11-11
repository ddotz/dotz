import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { emit, maskedForDisk, recentEvents } from "./events.ts";

// Built at run time from a fake pattern, like hub/session-hygiene.test.ts.
const FAKE_GH = `ghp_${"A1b2".repeat(9)}`;
const lastLine = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8").trimEnd().split("\n").at(-1) as string);

test("a secret pasted into a message is masked in the inbox file, the id and the reply link are kept", () => {
	emit("inbox", { ts: "2098-01-01T00:00:00.000Z", kind: "message", source: "web", mid: "m-mask-1", reply_to: "2097-12-31T00:00:00.000Z", text: `배포 키는 ${FAKE_GH} 이거야` });
	const line = lastLine(paths.inbox);
	expect(line.text).toContain("[가림:github]");
	expect(line.text).not.toContain(FAKE_GH);
	expect([line.mid, line.reply_to]).toEqual(["m-mask-1", "2097-12-31T00:00:00.000Z"]);
	// The page and the listeners still get the event as it was sent.
	expect(recentEvents(5).find(e => e.mid === "m-mask-1")?.text).toContain(FAKE_GH);
});

test("a secret in the text of a burst part and in an answer is masked in the files too", () => {
	emit("inbox", { ts: "2098-01-01T00:00:01.000Z", kind: "message", source: "web", mid: "m-mask-2", text: "두 줄", parts: [{ text: "첫 줄" }, { text: `키 ${FAKE_GH}` }] });
	expect(JSON.stringify(lastLine(paths.inbox).parts)).not.toContain(FAKE_GH);
	emit("outbox", { ts: "2098-01-01T00:00:02.000Z", kind: "out", source: "orchestrator", target: "web", text: `토큰은 ${FAKE_GH}` });
	expect(lastLine(paths.outbox).text).not.toContain(FAKE_GH);
});

test("an event without a secret is written as it is", () => {
	const e = { ts: "2098-01-01T00:00:03.000Z", kind: "message", source: "web", mid: "m-mask-3", text: "커밋 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f 확인", parts: [{ text: "a" }] };
	expect(maskedForDisk(e)).toBe(e);
	emit("inbox", { ...e });
	expect(lastLine(paths.inbox)).toMatchObject({ mid: "m-mask-3", text: e.text, parts: [{ text: "a" }] });
});
