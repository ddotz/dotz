import { afterAll, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { advance } from "./runtime/test-clock.ts";
import { noticeKey, parseBlock, startPeerStreams, toastWorthy } from "./peer-stream.ts";

// Two simulated hubs: A is a fake gateway (its event stream and its notice list), B is this process's real events.ts stream plus startPeerStreams
// following A. What a page on B would hear is read from B's own /api/events body.
const open = (id: string, extra: object = {}) => ({ id, kind: "decision", tone: "ask", title: "배포할까요?", read: false, at: `at-${id}`, decision: { state: "open", reply_to: `at-${id}` }, ...extra });

const aStreams = new Set<ReadableStreamDefaultController<string>>();
let aCounts = { unread: 0, items: [] as object[] };
let aConnects = 0;
const sendA = (e: object) => { for (const c of aStreams) c.enqueue(`data: ${JSON.stringify(e)}\n\n`); };
const hubA = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === "/api/notices") return Response.json(aCounts);
		if (pathname !== "/api/events") return new Response("no", { status: 404 });
		let ctl!: ReadableStreamDefaultController<string>;
		aConnects++;
		return new Response(new ReadableStream<string>({
			start(c) { ctl = c; aStreams.add(c); c.enqueue(`id: a-0\nevent: reset\ndata: {}\n\n`); },
			cancel() { aStreams.delete(ctl); },
		}), { headers: { "Content-Type": "text/event-stream" } });
	},
});
const A = { name: "맥미니", url: `http://127.0.0.1:${hubA.port}`, self: false };

const heard: Array<Record<string, any>> = [];
const reader = (sseResponse().body as ReadableStream<Uint8Array>).getReader();
(async () => {
	const dec = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buf += typeof value === "string" ? value : dec.decode(value);
		let i: number;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const b = parseBlock(buf.slice(0, i));
			buf = buf.slice(i + 2);
			if (b && b.event === "message") heard.push(b.data as Record<string, any>);
		}
	}
})();
// The suite's clock is manual (hub/runtime/test-clock.ts): each advance yields to the event loop, so the sockets run, and moves the debounce and reconnect timers by hand.
const tick = () => advance(25);
const until = async (pred: () => boolean) => {
	const deadline = performance.now() + 8000;
	while (!pred()) {
		if (performance.now() > deadline) throw new Error(`timeout; heard ${JSON.stringify(heard)}`);
		await tick();
	}
};
const ofKind = (k: string) => heard.filter(f => f.kind === k);
// Every debounce that fired reads A once and is heard as one peer_counts frame (no reconnect happens before the last test). One tick
// runs every debounce already armed, so after it the counts are settled once each fired read is heard: no read is left in flight to
// answer a later wait (a read still in flight from an earlier frame let the next test's wait end one frame early).
const settled = async () => {
	await tick();
	await until(() => ofKind("peer_counts").length === fired);
};
// A's stream is ordered: once this notice's frame is handled and the counts are settled, everything sent before it has been handled.
const handled = async (id: string) => {
	sendA({ kind: "notice", item: { id, kind: "worklog", tone: "run", title: "표시", read: false }, unread: 0 });
	await until(() => ofKind("peer_notice_done").some(f => f.ids[0] === id));
	await settled();
};
// Counts every arming of the debounce: a frame that reads A again is seen here even when a later frame's debounce replaces it.
const DEBOUNCE_MS = 17;
const clockSetTimeout = globalThis.setTimeout;
let armed = 0, fired = 0;
globalThis.setTimeout = ((fn: () => void, ms?: number) => {
	if (ms !== DEBOUNCE_MS) return clockSetTimeout(fn, ms);
	armed++;
	return clockSetTimeout(() => { fired++; fn(); }, ms);
}) as typeof setTimeout;

// The idle timeout is off: the manual clock runs far ahead of the real sockets here.
const stop = startPeerStreams({ computers: async () => [A, { name: "나", url: "http://127.0.0.1:1", self: true }], countsDebounceMs: DEBOUNCE_MS, scanMs: 60_000, backoffMs: [20], idleMs: 2 ** 50 });
afterAll(() => { stop(); globalThis.setTimeout = clockSetTimeout; reader.cancel().catch(() => {}); hubA.stop(true); });

test("which notices toast, and a question with its [ask] twin is one matter", () => {
	expect(toastWorthy(open("1"))).toBe(true);
	expect(toastWorthy(open("1", { read: true }))).toBe(false);
	expect(toastWorthy(open("1", { decision: { state: "ignored" } }))).toBe(false);
	expect(toastWorthy({ id: "w", kind: "worklog", tone: "run", read: false })).toBe(false);
	expect(toastWorthy({ id: "r", kind: "result", tone: "done", read: false })).toBe(true);
	expect(toastWorthy({ id: "m", kind: "message", tone: "", read: false })).toBe(false);
	expect(noticeKey(open("1"))).toBe(noticeKey({ id: "t", kind: "alert", tone: "ask", at: "at-1" }));
	expect(parseBlock(": ping")).toBeUndefined();
	expect(parseBlock('id: x\nevent: reset\ndata: {"a":1}')).toEqual({ event: "reset", data: { a: 1 } });
});

test("a new notice on A reaches B's stream once, named for A, then A's counts follow; reads update the counts", async () => {
	await until(() => aStreams.size === 1);
	aCounts = { unread: 1, items: [open("d1")] };
	const item = open("d1");
	sendA({ kind: "notice", item, unread: 1 });
	await until(() => ofKind("peer_counts").length >= 1);
	// the same question again, and its twin alert: no second toast frame
	sendA({ kind: "notice", item, unread: 1 });
	sendA({ kind: "notice", item: { id: "t1", kind: "alert", tone: "ask", title: "배포할까요?", read: false, at: "at-d1" }, unread: 2 });
	aCounts = { unread: 2, items: [open("d1")] };
	await until(() => ofKind("peer_counts").some(c => c.unread === 2));
	const notices = ofKind("peer_notice");
	expect(notices).toHaveLength(1);
	expect(notices[0]).toMatchObject({ peer: { name: "맥미니", url: A.url }, id: "d1", key: "at-d1", notice: "decision", tone: "ask", title: "배포할까요?", to: "" });
	expect(ofKind("peer_counts").at(-1)).toMatchObject({ url: A.url, name: "맥미니", online: true, unread: 2, need: 1 });

	// answered on A: read + closed; B's numbers follow without a new toast
	aCounts = { unread: 0, items: [{ ...open("d1"), decision: { state: "answered" } }] };
	sendA({ kind: "notice_read", ids: ["d1", "t1"], unread: 0 });
	await until(() => ofKind("peer_counts").some(c => c.unread === 0 && c.need === 0));
	expect(ofKind("peer_notice")).toHaveLength(1);

	// what A answered or read takes its toast away here: one done frame per change, with the ids
	expect(ofKind("peer_notice_done").at(-1)).toMatchObject({ url: A.url, ids: ["d1", "t1"] });
	sendA({ kind: "notice", item: { ...open("d1", { read: true }), decision: { state: "answered", to: "mail:k1" } }, unread: 0 });
	await until(() => ofKind("peer_notice_done").some(f => f.ids.length === 1 && f.ids[0] === "d1"));

	// a progress line and an already-read notice never toast
	sendA({ kind: "notice", item: { id: "w1", kind: "worklog", tone: "run", title: "시작", read: false }, unread: 1 });
	sendA({ kind: "notice", item: open("d2", { read: true }), unread: 0 });
	await handled("m1");
	expect(ofKind("peer_notice")).toHaveLength(1);
});

test("a state change on A (a mail answered, a draft sent, a room read) makes B read A again: its counts and the merged monitoring follow at once", async () => {
	await until(() => aStreams.size === 1);
	for (const kind of ["mail_unreplied", "comment_send", "kakao_draft", "read"]) {
		const before = ofKind("peer_counts").length, arms = armed;
		sendA({ kind, target: "mail:k1" });
		await until(() => armed > arms);
		await settled();
		expect(ofKind("peer_counts").length).toBeGreaterThan(before);
	}
	const before = armed;
	sendA({ kind: "activity", source: "orchestrator", type: "tool" });
	await handled("m2");
	expect(armed - before).toBe(1);   // the marker's own, none for the activity
});

test("a peer's own peer_* frames and a lost connection: nothing is forwarded as a notice, the stream reconnects and the chip goes offline then back", async () => {
	sendA({ kind: "peer_notice", peer: { name: "다른 곳", url: "http://x" }, id: "z", title: "되돌아온 프레임" });
	await handled("m3");
	expect(ofKind("peer_notice")).toHaveLength(1);

	const connects = aConnects;
	const counts = ofKind("peer_counts").length;
	for (const c of [...aStreams]) { c.close(); aStreams.delete(c); }
	await until(() => aConnects > connects && aStreams.size === 1);
	await until(() => ofKind("peer_counts").length > counts);
});
