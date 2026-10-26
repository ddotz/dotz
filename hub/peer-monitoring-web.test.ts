import { afterAll, describe, expect, test } from "bun:test";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 모니터링 shows this computer's items and every peer's together (web/js/34-peer-monitoring.js): a machine chip on each peer row, '연결 안 됨'
// on a peer that does not answer, the peer's reports in 감시 소식 and the machine name beside each detail title. Headless; the peers are fixtures.
const SNAP = "/tmp/tm-shots";
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
	{ name: "서재", url: "http://study.test", online: false, stale: true, items: { name: "서재", rev: "r2", monitors: [{ name: "study-disk", kind: "watch", last_run: at(2), last_result: "ok" }], notices: [], integrations: [], conversations: [] } },
	{ name: "창고", url: "http://store.test", online: false, stale: false, items: null },
];

const json = (v: unknown, status = 200) => Response.json(v, { status });
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
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 1 });
		if (url.pathname === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }, ...peers.map(p => ({ name: p.name, url: p.url, self: false, online: p.online }))]);
		if (url.pathname === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (url.pathname === "/api/monitors") return json({ items: [localMon] });
		if (url.pathname === "/api/notices") return json({ unread: 1, items: [localNote] });
		if (url.pathname === "/api/integrations") return json({ items: [MAIL_APP] });
		if (url.pathname === "/api/conversations") return json({ items: [{ target: "mail:loc", unread: 1, read: null, mail: MAIL, last: LAST }] });
		if (url.pathname === "/api/monitoring/peers") return json(peers);
		if (url.pathname === "/api/peer/proxy") return proxy(req, url);
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const open = async (width: number, height: number): Promise<View> => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	return v;
};
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
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
	test("peer rows carry the machine chip, an offline peer says 연결 안 됨, the feed lists the peer's report first", async () => {
		const v = await boot(1280, 800);
		expect(await text(v, `${rowOf(`p:${MINI}|m:peer-backup`)}.querySelector(".tag").textContent`)).toBe("맥미니");
		expect(await text(v, `${rowOf(`p:${MINI}|i:mail`)}.querySelector(".tag").textContent`)).toBe("맥미니");
		expect(await text(v, `${rowOf("m:local-check")}.querySelectorAll(".tag").length + ""`)).toBe("0");
		// the other computer's disconnected app says so here too, not "확인할 것 없어요"
		expect(await text(v, `${rowOf(`p:${MINI}|i:kakao`)}.textContent`)).toContain(PEER_DOWN);
		const stale = await text(v, `[...${rowOf("p:http://study.test|m:study-disk")}.querySelectorAll(".tag")].map(t => t.textContent).join(",")`);
		expect(stale).toBe("서재,연결 안 됨");
		expect(await text(v, `${rowOf("p:http://store.test|off")}.querySelector(".cv-n").textContent`)).toBe("창고 · 연결 안 됨");
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
		await waitFor(v, `$("#mon-tl .rc")`);
		expect(await text(v, `$("#mon-tl .rc .rc-title").textContent`)).toBe("백업이 바뀌었어요");
		await v.evaluate(`(go("monitoring", "notice"), 0)`);
		await waitFor(v, `$("#mon-head .mon-pc")`);
		expect(await text(v, `$("#mon-head .mon-pc").textContent`)).toBe("맥북");
	});

	test("a peer mail row is the native mail row, and its original opens with HTML and files through the proxy", async () => {
		const v = await boot(1280, 800);
		await waitFor(v, `CONV.has("mail:loc") && INTG.items.length`);
		await v.evaluate(`(go("monitoring", "i:mail"), 0)`);
		await waitFor(v, `$("#mon-tl .mr")`);
		const local = await text(v, `$("#mon-tl .mr").outerHTML`);
		expect(local).toContain("mr-clip");
		expect(local).toContain("mr-sum");
		expect(local).toContain("답장 초안 있음");
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|i:mail`)}), 0)`);
		await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-head .mon-pc").textContent === "맥미니" && $("#mon-tl .mr")`);
		expect(await text(v, `$("#mon-tl .mr").outerHTML`)).toBe(local);
		await v.evaluate(`($("#mon-tl .mr").click(), 0)`);
		await waitFor(v, `$(".mr-file")`);
		expect(await text(v, `$(".mr-fname").textContent`)).toBe("안건.pdf");
		expect(await text(v, `$(".mr-file").getAttribute("href")`)).toContain("/api/peer/proxy?pc=");
		expect(await text(v, `decodeURIComponent($(".mr-file").getAttribute("href"))`)).toContain("/api/mail/abc/files/0?dl=1");
		await waitFor(v, `$("#tl iframe.mb-frame") && $("#tl iframe.mb-frame").srcdoc.includes("굵게")`);
		expect(hits.some(h => h.startsWith("/api/mail/abc/body"))).toBe(true);
		expect(hits.some(h => h.startsWith("/api/history?target=mail%3Aabc"))).toBe(true);
	}, 20_000);

	test("a peer KakaoTalk room opens in the bubble view with the composer, and a send goes to /api/peer/act", async () => {
		const v = await boot(1280, 800);
		await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|i:kakao`)}), 0)`);
		await waitFor(v, `$("#kk-rooms .kk-row")`);
		await v.evaluate(`($("#kk-rooms .kk-row").click(), 0)`);
		await waitFor(v, `$("#kk-in .kk-m.in .kk-bub") && $("#kk-form") && !$("#kk-foot").hidden`);
		expect(await text(v, `$("#kk-in .kk-m.in .kk-bub").textContent`)).toBe("저녁 뭐 먹을래?");
		expect(await text(v, `$("#kk-in .kk-m.me .kk-bub").textContent`)).toBe("김치찌개");
		await v.evaluate(`(kkTa.value = "좋아요", kkSend(), 0)`);
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
		await waitFor(v, `document.querySelector('#kk-tl [data-log="102"]')`, 6000);
		expect(heads()).toBeGreaterThan(h0);
		expect(await text(v, `String(document.querySelectorAll('#kk-tl [data-log="102"]').length)`)).toBe("1");
		// Nothing moved: the next poll asks for the head only, not for rows.
		await waitFor(v, `KK.peerHead === "c1:102" && !KK.peerBusy`, 6000);
		const a = afters(), h = heads();
		await v.evaluate(`kkPeerPoll()`);
		expect(heads()).toBe(h + 1);
		expect(afters()).toBe(a);
		// The pane is left: no poll runs.
		await v.evaluate(`(go("monitoring", "notice"), 0)`);
		await waitFor(v, `!KK.vis`);
		await v.evaluate(`kkPeerPoll()`);
		expect(heads()).toBe(h + 1);
	}, 20_000);
});

for (const [name, w, h] of [["390", 390, 844], ["desktop", 1280, 800]] as const) {
	describe(`screenshot at ${w}px`, () => {
		test("모니터링 with a peer item open", async () => {
			const v = await boot(w, h);
			await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|m:peer-backup`)}), 0)`);
			await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-head .mon-pc").textContent === "맥미니" && $("#mon-tl .rc")`);
			if (w >= 1100) await Bun.write(`${SNAP}/monitor-${name}.png`, await v.screenshot());
			else {
				await v.evaluate(`(go("monitoring"), 0)`);
				await waitFor(v, `$("#mon-side .cv-row")`);
				await Bun.write(`${SNAP}/monitor-${name}-list.png`, await v.screenshot());
				await v.evaluate(`(go("monitoring", ${JSON.stringify(`p:${MINI}|m:peer-backup`)}), 0)`);
				await waitFor(v, `$("#mon-head .mon-pc") && $("#mon-tl .rc")`);
				expect(await text(v, `$("#title .mon-pc").textContent`)).toBe("맥미니");
				await Bun.write(`${SNAP}/monitor-${name}.png`, await v.screenshot());
			}
			expect(await Bun.file(`${SNAP}/monitor-${name}.png`).exists()).toBe(true);
		});
	});
}
