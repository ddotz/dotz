import { expect, test } from "bun:test";
import { broadcast, lastEventId, replayAfter } from "./events.ts";

test("a reconnect replays exactly the frames after the last seen id", () => {
	const seen = lastEventId();
	broadcast({ kind: "out", n: 1 });
	broadcast({ kind: "out", n: 2 });
	const missed = replayAfter(seen);
	expect(missed?.map(f => JSON.parse(f.split("data: ")[1]).n)).toEqual([1, 2]);
	expect(missed?.[1].startsWith(`id: ${lastEventId()}\n`)).toBe(true);
	expect(replayAfter(lastEventId())).toEqual([]);
});

test("ids from another boot or the future cannot be replayed", () => {
	expect(replayAfter("zzz-1")).toBeNull();
	expect(replayAfter(`${lastEventId().split("-")[0]}-999999999`)).toBeNull();
	expect(replayAfter("garbage")).toBeNull();
	expect(replayAfter(null)).toBeNull();
});
