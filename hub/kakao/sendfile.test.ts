// sendfile.ts against a fake osascript (room.jxa.js answers by action): the self window is opened and verified, each file is pasted once
// and confirmed from the database before the next, and a press the database does not confirm is never repeated.
import { expect, test } from "bun:test";
import { sendFilesToSelf } from "./sendfile.ts";
import type { Msg, Runner } from "./types.ts";

const me = (logId: string, type: number): Msg => ({ logId, chatId: "777", authorId: "1", sender: "미설", text: "", type, sentAt: 0, fromMe: true });

function fake(answer: (req: any) => object) {
	const reqs: any[] = [];
	const runner: Runner = async (_argv, opts) => {
		const req = JSON.parse(opts?.stdin ?? "{}");
		reqs.push(req);
		return { code: 0, stdout: JSON.stringify(answer(req)), stderr: "" };
	};
	return { runner, reqs };
}
const window = (req: any) => (req.action === "rows" ? { ok: true, opened: true } : req.action === "probe" ? { ok: true, windows: [{ title: "미설", self: true }] } : { ok: true });
const room = { chatId: "777", name: "미설", kind: "self" as const, members: 1 };
let clock = 0;
const deps = (runner: Runner) => ({ runner, sleep: async (ms: number) => void (clock += ms), now: () => clock });

test("each file is pasted once into the verified self window and confirmed from the database before the next", async () => {
	const log: Msg[] = [me("10", 1)];
	const { runner, reqs } = fake(req => {
		if (req.action === "attach") log.push(me(String(10 + log.length), req.path.endsWith(".png") ? 2 : 18));
		return window(req);
	});
	const r = await sendFilesToSelf({ files: ["/x/a.hwpx", "/x/b.png"], room, all: [room], messages: async n => log.slice(-n) }, deps(runner));
	expect(r).toMatchObject({ ok: true, sent: 2 });
	expect(reqs.filter(q => q.action === "attach").map(q => [q.path, q.front])).toEqual([["/x/a.hwpx", false], ["/x/b.png", false]]);
	expect(reqs.at(-1)).toEqual({ action: "close", name: "미설" });
});

test("no dialog in the background retries once in front; an unconfirmed press stops without pressing again", async () => {
	const { runner, reqs } = fake(req => (req.action === "attach" ? (req.front ? { ok: true, pressed: true } : { ok: false, why: "no_dialog" }) : window(req)));
	const r = await sendFilesToSelf({ files: ["/x/a.png", "/x/b.png"], room, all: [room], messages: async () => [me("10", 1)] }, deps(runner));
	expect(r.ok).toBe(false);
	expect(r.sent).toBe(0);
	expect(reqs.filter(q => q.action === "attach").map(q => q.front)).toEqual([false, true]);
});

test("a window that is not the self chat is refused before anything is pasted", async () => {
	const { runner, reqs } = fake(req => (req.action === "probe" ? { ok: true, windows: [{ title: "미설", members: 5 }] } : window(req)));
	const r = await sendFilesToSelf({ files: ["/x/a.png"], room, all: [room], messages: async () => [] }, deps(runner));
	expect(r.ok).toBe(false);
	expect(reqs.some(q => q.action === "attach")).toBe(false);
});
