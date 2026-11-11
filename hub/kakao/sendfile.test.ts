// sendfile.ts against a fake osascript (room.jxa.js answers by action): the self window is opened and verified, each file is pasted once
// and confirmed from the database before the next, and a press the database does not confirm is never repeated.
import { expect, test } from "bun:test";
import { sendFilesToSelf } from "./sendfile.ts";
import type { Msg, Runner } from "./types.ts";

const me = (logId: string, type: number): Msg => ({ logId, chatId: "777", authorId: "1", sender: "나", text: "", type, sentAt: 0, fromMe: true });

function fake(answer: (req: any) => object) {
	const reqs: any[] = [];
	const runner: Runner = async (_argv, opts) => {
		const req = JSON.parse(opts?.stdin ?? "{}");
		reqs.push(req);
		return { code: 0, stdout: JSON.stringify(answer(req)), stderr: "" };
	};
	return { runner, reqs };
}
const window = (req: any) => (req.action === "rows" ? { ok: true, rows: 1, scanned: 1, hits: [{ index: 0, texts: ["나"] }], stopped: "found" } : req.action === "probe" ? { ok: true, windows: [{ title: "나", self: true }] } : { ok: true });
const room = { chatId: "777", name: "나", kind: "self" as const, members: 1 };
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
	expect(reqs.filter(q => q.action === "attach").map(q => q.path)).toEqual(["/x/a.hwpx", "/x/b.png"]);
	expect(reqs.at(-1)).toEqual({ action: "close", name: "나" });
});

test("no dialog in the background stops with the reason: no second try, nothing to the front, no later file", async () => {
	const { runner, reqs } = fake(req => (req.action === "attach" ? { ok: false, why: "no_dialog" } : window(req)));
	const r = await sendFilesToSelf({ files: ["/x/a.png", "/x/b.png"], room, all: [room], messages: async () => [me("10", 1)] }, deps(runner));
	expect(r).toMatchObject({ ok: false, sent: 0 });
	expect(r.reason).toContain("앞으로 가져오지");
	expect(reqs.filter(q => q.action === "attach")).toHaveLength(1);
	expect(JSON.stringify(reqs)).not.toContain("front");
});

test("an unconfirmed press stops without pressing again, and a killed script says the clipboard may not be back", async () => {
	const reqs: any[] = [];
	const runner: Runner = async (_argv, opts) => {
		const req = JSON.parse(opts?.stdin ?? "{}");
		reqs.push(req);
		if (req.action === "attach") return { code: 137, stdout: "", stderr: "" };
		return { code: 0, stdout: JSON.stringify(window(req)), stderr: "" };
	};
	const r = await sendFilesToSelf({ files: ["/x/a.png", "/x/b.png"], room, all: [room], messages: async () => [me("10", 1)] }, deps(runner));
	expect(r).toMatchObject({ ok: false, sent: 0 });
	expect(r.warning).toBeDefined();
	expect(reqs.filter(q => q.action === "attach")).toHaveLength(1);
});

test("a database room of the same name refuses before any window is opened", async () => {
	const { runner, reqs } = fake(window);
	const twin = { chatId: "101", name: "나", kind: "direct" as const };
	const r = await sendFilesToSelf({ files: ["/x/a.png"], room, all: [room, twin], messages: async () => [] }, deps(runner));
	expect(r.ok).toBe(false);
	expect(reqs).toEqual([]);
});

test("a closed list window is reported, not opened: KakaoTalk would come to the front", async () => {
	const { runner, reqs } = fake(req => (req.action === "rows" ? { ok: false, step: "list", why: "no_list" } : window(req)));
	const r = await sendFilesToSelf({ files: ["/x/a.png"], room, all: [room], messages: async () => [] }, deps(runner));
	expect(r.ok).toBe(false);
	expect(reqs.some(q => q.action === "openlist" || q.action === "attach")).toBe(false);
});

test("the owner's own open window with their text stays open", async () => {
	const { runner, reqs } = fake(req => (req.action === "rows" ? { ok: true, opened: true } : req.action === "attach" ? { ok: false, why: "owner_text" } : window(req)));
	const r = await sendFilesToSelf({ files: ["/x/a.png"], room, all: [room], messages: async () => [] }, deps(runner));
	expect(r.ok).toBe(false);
	expect(reqs.some(q => q.action === "close")).toBe(false);
});

test("a window that is not the self chat is refused before anything is pasted", async () => {
	const { runner, reqs } = fake(req => (req.action === "probe" ? { ok: true, windows: [{ title: "나", members: 5 }] } : window(req)));
	const r = await sendFilesToSelf({ files: ["/x/a.png"], room, all: [room], messages: async () => [] }, deps(runner));
	expect(r.ok).toBe(false);
	expect(reqs.some(q => q.action === "attach")).toBe(false);
});
