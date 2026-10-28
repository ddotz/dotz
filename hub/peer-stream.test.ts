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
// The suite's clock is manual (hub/runtime/test-clock.ts): real time passes for the sockets, the debounce and reconnect timers are advanced by hand.
const tick = async () => { await Bun.sleep(5); await advance(25); };
const until = async (pred: () => boolean) => {
	const deadline = performance.now() + 8000;
	while (!pred()) {
		if (performance.now() > deadline) throw new Error(`timeout; heard ${JSON.stringify(heard)}`);
		await tick();
	}
};
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const ofKind = (k: string) => heard.filter(f => f.kind === k);

const stop = startPeerStreams({ computers: async () => [A, { name: "나", url: "http://127.0.0.1:1", self: true }], countsDebounceMs: 10, scanMs: 60_000, backoffMs: [20] });
afterAll(() => { stop(); reader.cancel().catch(() => {}); hubA.stop(true); });

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
	expect(notices[0]).toMatchObject({ peer: { name: "맥미니", url: A.url }, id: "d1", key: "at-d1", notice: "decision", tone: "ask", title: "배포할까요?" });
	expect(ofKind("peer_counts").at(-1)).toMatchObject({ url: A.url, name: "맥미니", online: true, unread: 2, need: 1 });

	// answered on A: read + closed; B's numbers follow without a new toast
	aCounts = { unread: 0, items: [{ ...open("d1"), decision: { state: "answered" } }] };
	sendA({ kind: "notice_read", ids: ["d1", "t1"], unread: 0 });
	await until(() => ofKind("peer_counts").some(c => c.unread === 0 && c.need === 0));
	expect(ofKind("peer_notice")).toHaveLength(1);

	// a progress line and an already-read notice never toast
	sendA({ kind: "notice", item: { id: "w1", kind: "worklog", tone: "run", title: "시작", read: false }, unread: 1 });
	sendA({ kind: "notice", item: open("d2", { read: true }), unread: 0 });
	await settle();
	expect(ofKind("peer_notice")).toHaveLength(1);
});

test("a state change on A (a mail answered, a draft sent, a room read) makes B read A again: its counts and the merged monitoring follow at once", async () => {
	await until(() => aStreams.size === 1);
	for (const kind of ["mail_unreplied", "comment_send", "kakao_draft", "read"]) {
		const before = ofKind("peer_counts").length;
		sendA({ kind, target: "mail:k1" });
		await until(() => ofKind("peer_counts").length > before);
	}
	const before = ofKind("peer_counts").length;
	sendA({ kind: "activity", source: "orchestrator", type: "tool" });
	await settle();
	expect(ofKind("peer_counts").length).toBe(before);
});

test("a peer's own peer_* frames and a lost connection: nothing is forwarded as a notice, the stream reconnects and the chip goes offline then back", async () => {
	sendA({ kind: "peer_notice", peer: { name: "다른 곳", url: "http://x" }, id: "z", title: "되돌아온 프레임" });
	await settle();
	expect(ofKind("peer_notice")).toHaveLength(1);

	const connects = aConnects;
	const counts = ofKind("peer_counts").length;
	for (const c of [...aStreams]) { c.close(); aStreams.delete(c); }
	await until(() => aConnects > connects && aStreams.size === 1);
	await until(() => ofKind("peer_counts").length > counts);
});
