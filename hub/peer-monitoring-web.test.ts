import { afterAll, describe, expect, test } from "bun:test";
import { advanceTimers, fakeHub, json, waitFor, type View } from "./test-web.ts";

// 모니터링 shows this computer's items and every peer's together (web/js/34-peer-monitoring.js): a peer row names its computer in the subtitle,
// keeps one status on the right like every row (꺼짐 > 연결 안 됨 > its own), says 연결 안 됨 for a peer that does not answer, the peer's reports in 감시 소식 and the machine name beside each detail title. Headless; the peers are fixtures.
const MINI = "http://mini.test";
const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 3, min)).toISOString();
const localMon = { name: "local-check", watch: "local-check", kind: "watch", last_run: at(10), last_result: "ok", next_run: at(40), every: "30분" };
const localNote = { id: "ln1", kind: "watch", tone: "ok", title: "orphan report", text: "로컬 소식이에요", ts: at(5), read: false };
const peerMon = { name: "peer-backup", watch: "peer-backup", kind: "watch", last_run: at(30), last_result: "changed", next_run: at(50), every: "1시간" };
const peerNote = { id: "pn1", kind: "watch", tone: "changed", title: "peer backup", text: "백업이 바뀌었어요", ts: at(30), read: false };
const peerFeed = { id: "pn2", kind: "watch", tone: "ok", title: "peer orphan", text: "피어 소식이에요", ts: at(31), read: false };
// One mail as both computers hold it: the native row and the peer's row must come out the same.
const MAIL = { subject: "회의 일정", from: "민수 <m@example.com>", source: "mail", at: at(20), summary: "내일 3시 회의예요", attachments: [{ name: "안건.pdf", size: 2048 }], html: true, suggest: { kind: "reply-draft", label: "답장 초안", ref: "d1", state: "draft" } };
const LAST = { ts: at(20), text: "회의 일정", from: "bot" };
const MAIL_APP = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], unread: 1, notices: [], needs: { drafts: 1, unread: 1, sentToday: 0 } };
const PEER_DOWN = "연결 끊김 · 10월 23일 21:29부터 · 다시 로그인 필요";
const KAKAO_APP = { key: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: ["kakao:"], unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 }, state: "disconnected", hint: PEER_DOWN };
const hits: string[] = [];
// Rows the Mac mini stores in room c1 after the page opened it (the page learns of them only by polling the room's head).
const c1More: Record<string, unknown>[] = [];
const acts: { action: string; args: Record<string, unknown> }[] = [];
const peers = [
	{
		name: "맥미니", url: MINI, online: true, stale: false,
		items: {
			name: "맥미니", rev: "r1", monitors: [peerMon], notices: [peerNote, peerFeed],
			integrations: [MAIL_APP, KAKAO_APP],
			conversations: [{ target: "mail:abc", unread: 1, read: null, mail: MAIL, last: LAST }],
		},
	},
	{ name: "서재", url: "http://study.test", online: false, stale: true, items: { name: "서재", rev: "r2", monitors: [{ name: "study-disk", kind: "watch", last_run: at(2), last_result: "ok" }, { name: "study-sync", kind: "watch", paused: true, last_run: at(2), last_result: "ok" }], notices: [], integrations: [], conversations: [] } },
	{ name: "창고", url: "http://store.test", online: false, stale: false, items: null },
];

// What the Mac mini answers behind /api/peer/proxy: the same shapes its own web app reads.
async function proxy(req: Request, url: URL): Promise<Response> {
	const p = url.searchParams.get("p") ?? "";
	if (req.method === "POST") {
		acts.push((await req.json()) as (typeof acts)[number]);
		return json({ id: "s1", state: "sending" });
	}
	hits.push(p);
	if (p.startsWith("/api/history")) return json({ events: [{ ts: at(20), kind: "mail", subject: MAIL.subject, from: MAIL.from, mail: "abc", conv: "mail:abc", html: true, attachments: MAIL.attachments, text: "민수 · 회의 일정\n\n내일 3시 회의예요" }] });
	if (p.startsWith("/api/mail/abc/body")) return new Response("<p>본문 <b>굵게</b> 입니다</p>", { headers: { "content-type": "text/html" } });
	if (p === "/api/kakao/rooms") return json({ on: true, rooms: [{ chatId: "c1", name: "가족", kind: "group", watched: true, autoDraft: false, unread: 0, lastAt: Date.parse(at(25)) }] });
	if (p === "/api/kakao/chat/c1/head") return json({ logId: String((c1More.at(-1) ?? { logId: "101" }).logId) });
	if (p.startsWith("/api/kakao/chat/c1")) {
		const after = new URL(p, "http://x").searchParams.get("after");
		const all = [
			{ logId: "100", sentAt: Date.parse(at(24)), fromMe: false, sender: "엄마", authorId: "a1", type: 1, text: "저녁 뭐 먹을래?" },
			{ logId: "101", sentAt: Date.parse(at(25)), fromMe: true, type: 1, text: "김치찌개" }, ...c1More];
		return json({ room: { chatId: "c1", name: "가족", kind: "group", group: true }, read: null, drafts: [], sends: [], kakaoUnread: 0, messages: after ? all.filter(m => Number(m.logId) > Number(after)) : all });
	}
	return json({});
}
const hub = fakeHub({
	slowTimers: true,
	api: (req, url) => {
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 1 });
		if (url.pathname === "/api/peers") return json([{ name: "맥북", url: `${hub.origin}`, self: true, online: true }, ...peers.map(p => ({ name: p.name, url: p.url, self: false, online: p.online }))]);
		if (url.pathname === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (url.pathname === "/api/monitors") return json({ items: [localMon] });
		if (url.pathname === "/api/notices") return json({ unread: 1, items: [localNote] });
		if (url.pathname === "/api/integrations") return json({ items: [MAIL_APP] });
		if (url.pathname === "/api/conversations") return json({ items: [{ target: "mail:loc", unread: 1, read: null, mail: MAIL, last: LAST }] });
		if (url.pathname === "/api/monitoring/peers") return json(peers);
		if (url.pathname === "/api/peer/proxy") return proxy(req, url);
	},
});

afterAll(() => hub.stop());
const open = async (width: number, height: number): Promise<View> => {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	return v;
};
const text = (v: View, expr: string) => v.evaluate(expr) as Promise<string>;
const rowOf = (key: string) => `[...document.querySelectorAll("#mon-side .cv-row")].find(r => r.dataset.k === ${JSON.stringify(key)})`;
const boot = async (width: number, height: number) => {
	const v = await open(width, height);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh`);
	await v.evaluate(`(go("monitoring"), 0)`);
	await waitFor(v, `PQ.loaded && ${rowOf(`p:${MINI}|m:peer-backup`)}`);
	return v;
};

describe("merged 모니터링", () => {
	test("a peer row has one status on the right and names its computer in the subtitle, an offline peer says 연결 안 됨, the feed lists the peer's report first", async () => {
		const v = await boot(1280, 800);
		// [status words on the right, subtitle, bars] of a row
		const row = async (key: string) => JSON.parse(await text(v, `(r => JSON.stringify([[...r.querySelectorAll(".cv-m .tag")].map(t => t.textContent), (r.querySelector(".cv-p") || {}).textContent || "", r.querySelectorAll(".mon-prog").length]))(${rowOf(key)})`)) as [string[], string, number];
		const backup = await row(`p:${MINI}|m:peer-backup`);
		expect(backup[0]).toEqual([await text(v, `monStatus(PQ.list[0].items.monitors[0]).text`)]);
		expect(backup[1]).toStartWith("맥미니에서 돌아요 · ");
		expect(backup[2]).toBe(0);   // a list row is a title and one sub line; the bar is in the monitor's own screen
		expect((await row(`p:${MINI}|i:mail`))[1]).toStartWith("맥미니에서 돌아요");
		expect((await row("m:local-check"))[0]).toHaveLength(1);
		// the other computer's disconnected app says so here too, not "확인할 것 없어요"
		const kakao = await row(`p:${MINI}|i:kakao`);
		expect(kakao[0]).toEqual(["연결 끊김"]);
		expect(kakao[1]).toBe(`맥미니에서 돌아요 · ${PEER_DOWN}`);
		// a computer that does not answer: 연결 안 됨 is the one status, and a paused watch there still says 꺼짐; neither draws a bar
		expect(await row("p:http://study.test|m:study-disk")).toEqual([["연결 안 됨"], "서재에서 돌아요 · 서재 연결 안 됨", 0]);
		expect(await row("p:http://study.test|m:study-sync")).toEqual([["꺼짐"], "서재에서 돌아요 · 서재 연결 안 됨", 0]);
		expect(await text(v, `${rowOf("p:http://store.test|off")}.querySelector(".cv-n").textContent`)).toBe("창고 모니터링");
		expect((await row("p:http://store.test|off"))[0]).toEqual(["연결 안 됨"]);
		await v.evaluate(`(go("monitoring", "notice"), 0)`);
		await waitFor(v, `$("#mon-tl .rc")`);
		const titles = JSON.parse(await text(v, `JSON.stringify([...document.querySelectorAll("#mon-tl .rc")].map(c => c.querySelector(".rc-title").textContent))`));
		expect(titles).toEqual(["피어 소식이에요", "로컬 소식이에요"]);
		expect(await text(v, `$("#mon-tl .rc .rc-hd .tag").textContent`)).toBe("맥미니");
	});

	test("the detail title names the machine that owns the item", async () => {
		const v = await boot(1280, 800);
		await v.evaluate(`(go("monitoring", "m:local-check"), 0)`);
		await waitFor(v, `$("#mon-head .cv-n").firstChild.textContent === "local check"`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥북");
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|m:peer-backup`)}), 0)`);
		await waitFor(v, `$("#mon-head .cv-n").firstChild.textContent === "peer backup"`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥미니");
		await waitFor(v, `$("#mon-tl .mon-lr")`);
		expect(await text(v, `$("#mon-tl .mon-lr:nth-child(2) .mon-l1").textContent`)).toBe("백업이 바뀌었어요");
		await v.evaluate(`(go("monitoring", "notice"), 0)`);
		await waitFor(v, `$("#mon-head .mon-pc")`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥북");
	});

	test("a peer mail row is the native mail row, and its original opens with HTML and files through the proxy", async () => {
		const v = await boot(1280, 800);
		await waitFor(v, `CONV.has("mail:loc") && INTG.items.length`);
		await v.evaluate(`(go("monitoring", "i:mail"), 0)`);
		await waitFor(v, `$("#mon-tl .mr")`);
		// data-t is the row's own conversation key (it names which mail slides in when it arrives), so it differs by machine
		const row = async () => (await text(v, `$("#mon-tl .mr").outerHTML`)).replace(/ data-t="[^"]*"/, "");
		const local = await row();
		expect(local).toContain("mr-clip");
		expect(local).toContain("mr-sum");
		expect(local).toContain("답장 초안 있음");
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|i:mail`)}), 0)`);
		await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-head .mon-pc").textContent === "맥미니" && $("#mon-tl .mr")`);
		expect(await row()).toBe(local);
		await v.evaluate(`($("#mon-tl .mr").click(), 0)`);
		await waitFor(v, `$(".mr-file")`);
		expect(await text(v, `$(".mr-fname").textContent`)).toBe("안건.pdf");
		expect(await text(v, `$(".mr-file").getAttribute("href")`)).toContain("/api/peer/proxy?pc=");
		expect(await text(v, `decodeURIComponent($(".mr-file").getAttribute("href"))`)).toContain("/api/mail/abc/files/0?dl=1");
		await waitFor(v, `$("#tl iframe.mb-frame") && $("#tl iframe.mb-frame").srcdoc.includes("굵게")`);
		expect(hits.some(h => h.startsWith("/api/mail/abc/body"))).toBe(true);
		expect(hits.some(h => h.startsWith("/api/history?target=mail%3Aabc"))).toBe(true);
	}, 20_000);

	test("a peer KakaoTalk room opens in the bubble view with the request bar, and a send goes to /api/peer/act", async () => {
		const v = await boot(1280, 800);
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|i:kakao`)}), 0)`);
		await waitFor(v, `$("#kk-rooms .kk-row")`);
		await v.evaluate(`($("#kk-rooms .kk-row").click(), 0)`);
		await waitFor(v, `$("#kk-in .kk-m.in .kk-bub") && $("#kk-form") && !$("#kk-foot").hidden`);
		expect(await text(v, `$("#kk-in .kk-m.in .kk-bub").textContent`)).toBe("저녁 뭐 먹을래?");
		expect(await text(v, `$("#kk-in .kk-m.me .kk-bub").textContent`)).toBe("김치찌개");
		// The bar asks the assistant (no draft here, the other computer cannot make a new one: nothing goes out); a send is the card's own 보내기 / 직접 수정.
		await v.evaluate(`(kkTa.value = "내일 간다고 해줘", kkSend(), 0)`);
		expect(acts.filter(a => a.args.op === "draft")).toEqual([]);
		await v.evaluate(`(kkSendText("좋아요"), 0)`);
		await waitFor(v, `$("#kk-in .kk-m.pend")`);
		expect(acts.filter(a => a.args.op === "send")).toEqual([{ action: "kakao", args: { op: "send", chatId: "c1", text: "좋아요" } }]);
	});

	test("a row the other computer stored shows up with the ~2 s head poll, once, without a stream event; leaving the pane stops the asking", async () => {
		const v = await boot(1280, 800);
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|i:kakao`)}), 0)`);
		await waitFor(v, `$("#kk-rooms .kk-row")`);
		await v.evaluate(`($("#kk-rooms .kk-row").click(), 0)`);
		await waitFor(v, `$("#kk-in .kk-m.me .kk-bub") && KK.peerT !== 0`);
		const heads = () => hits.filter(h => h === "/api/kakao/chat/c1/head").length;
		const afters = () => hits.filter(h => h.startsWith("/api/kakao/chat/c1?") && h.includes("after=")).length;
		const h0 = heads();
		c1More.push({ logId: "102", sentAt: Date.parse(at(26)), fromMe: false, sender: "엄마", authorId: "a1", type: 1, text: "다른 컴퓨터에 저장된 새 메시지" });
		await advanceTimers(v, 2000);   // the open peer room asks for its head every 2 s (KK_PEER_MS)
		await waitFor(v, `document.querySelector('#kk-tl [data-log="102"]')`);
		expect(heads()).toBeGreaterThan(h0);
		expect(await text(v, `String(document.querySelectorAll('#kk-tl [data-log="102"]').length)`)).toBe("1");
		// Nothing moved: the next poll asks for the head only, not for rows.
		await waitFor(v, `KK.peerHead === "c1:102" && !KK.peerBusy`);
		const a = afters(), h = heads();
		await v.evaluate(`kkPeerPoll()`);
		expect(heads()).toBe(h + 1);
		expect(afters()).toBe(a);
		// The pane is left: no poll runs.
		await v.evaluate(`(go("monitoring", "notice"), 0)`);
		await waitFor(v, `!KK.vis`);
		await v.evaluate(`kkPeerPoll()`);
		expect(heads()).toBe(h + 1);
	});
});

for (const [w, h] of [[390, 844], [1280, 800]] as const) {
	test(`a peer monitor's detail names its computer at ${w}px`, async () => {
		const v = await boot(w, h);
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|m:peer-backup`)}), 0)`);
		await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-head .mon-pc").textContent === "맥미니" && $("#mon-tl .mon-lr")`);
		if (w < 1100) expect(await text(v, `$("#title .mon-pc").textContent`)).toBe("맥미니");
	});
}
