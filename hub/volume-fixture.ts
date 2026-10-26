// A fake hub with a lot piled up, for the web tests and screenshots of the lists at volume (hub/*volume*-web.test.ts): 180+ notices
// (open decisions, [ask] reports, failures, routine reports, the same watch over and over), 100 projects with unread messages, sessions
// with a question waiting, apps with drafts. Every endpoint the web asks for answers from memory; nothing is written anywhere.
// `serve()` returns the server and the mutable store, so a test can mark items read through the page and see what the page sent.
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

export type FixNotice = Record<string, unknown> & { id: string; kind: string; tone: string; title: string; text: string; read: boolean; ts: string; updated: string; at?: string };

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
let seq = 0;
const id = (p: string) => `${p}-${String(++seq).padStart(3, "0")}`;
function report(title: string, minutesAgo: number, text: string, o: Partial<FixNotice> = {}): FixNotice {
	const t = at(minutesAgo);
	return { id: id("w"), kind: "watch", tone: "", title, text, open: "alert", src: "alert", read: false, ts: t, updated: t, at: t, ...o };
}
function decision(n: number, to: string, minutesAgo: number, title: string, text: string, o: Partial<FixNotice> = {}): FixNotice {
	const t = at(minutesAgo);
	return { id: id("d"), kind: "decision", tone: "ask", title, text, open: to, src: to, read: false, ts: t, updated: t, at: t,
		decision: { options: [{ n: 1, label: "진행해요", rec: true, desc: "이대로 진행해요" }, { n: 2, label: "보류" }, { n: 3, label: "다르게", desc: "원하는 방식을 적어 주세요" }], to, reply_to: t, group: 1, state: "open" }, ...o };
}

/** Projects ch:1001 .. ch:1100 (the work channels) and the sessions. */
export const PROJECTS = Array.from({ length: 100 }, (_, i) => ({ id: String(1001 + i), name: `프로젝트 ${i + 1}` }));
export const projectTarget = (i: number) => `ch:${PROJECTS[i]!.id}`;

/** 180+ notices: the feed's own sources (no monitor row owns them), the monitors' reports, the asks and the failures. Newest first is the hub's order. */
export function notices(): FixNotice[] {
	seq = 0;
	const list: FixNotice[] = [];
	// 감시 소식 (no monitor of that name below): a schedule, a watch the owner removed last week, a dead server, a news watch, a stock watch that asks.
	for (let i = 0; i < 15; i++) list.push(report("예약", 60 * i + 7, i % 2 ? "아침 브리핑을 보냈어요" : "주간 보고 정리를 실행했어요", { read: i > 2 }));
	for (let i = 0; i < 25; i++) list.push(report("환율 감시", 35 * i + 3, `환율 감시: 결과가 바뀌었어요\n달러 ${1380 + (i % 3)}원`, { read: i > 5 }));
	for (let i = 0; i < 10; i++) list.push(report("옛 서버 감시", 30 * i + 11, "옛 서버 감시: 확인하지 못했어요\n연결이 되지 않아요 (ECONNREFUSED)", { tone: "fail", read: i > 1 }));
	for (let i = 0; i < 30; i++) list.push(report("뉴스 키워드 감시", 20 * i + 5, `뉴스 키워드 감시: 결과가 바뀌었어요\n새로 생겼어요: 기사 ${i + 1}건`, { read: i > 8 }));
	for (let i = 0; i < 20; i++) list.push(i % 7 === 2
		? report("재고 감시", 40 * i + 9, "재고 감시: 재고가 5개 남았어요. 주문할까요?", { tone: "ask" })
		: report("재고 감시", 40 * i + 9, "재고 감시: 결과가 바뀌었어요\n남은 수량 12개", { read: i > 4 }));
	// Under the monitor rows (titles match /api/monitors): routine reports, two failures, two asks, a server that keeps failing.
	for (let i = 0; i < 30; i++) list.push(i % 11 === 3
		? report("NAS 디스크 감시", 45 * i + 2, "NAS 디스크 감시: 확인하지 못했어요\n스크립트가 1 로 끝났어요", { tone: "fail", read: i > 4 })
		: report("NAS 디스크 감시", 45 * i + 2, `NAS 디스크 감시: 결과가 바뀌었어요\n남은 공간 ${40 - i}%`, { read: i > 6 }));
	for (let i = 0; i < 20; i++) list.push(report("node security updates", 90 * i + 4, "node security updates: 결과가 바뀌었어요\n보안 업데이트 3개", { read: i > 2 }));
	for (let i = 0; i < 20; i++) list.push(i % 9 === 1
		? report("블로그 댓글 감시", 50 * i + 6, "블로그 댓글 감시: 새 댓글에 답글을 달까요?", { tone: "ask" })
		: report("블로그 댓글 감시", 50 * i + 6, `블로그 댓글 감시: 결과가 바뀌었어요\n새 댓글 ${i + 1}개`, { read: i > 3 }));
	for (let i = 0; i < 15; i++) list.push(report("서버 응답 감시", 30 * i + 1, "서버 응답 감시: 확인하지 못했어요\n응답이 없어요 (timeout)", { tone: "fail", read: i > 0 }));
	// Open decisions in twelve projects, three loose [ask] alerts, six failure alerts, work log lines, session results.
	for (let i = 0; i < 12; i++) list.push(decision(i, projectTarget(i * 7), 25 * i + 8, `프로젝트 ${i * 7 + 1}: 배포할까요?`, `테스트가 모두 통과했어요. 지금 배포할까요?\n\n결정:\n1) 진행해요\n2) 보류\n3) 다르게`));
	for (let i = 0; i < 3; i++) { const t = at(70 * i + 12); list.push({ id: id("a"), kind: "alert", tone: "ask", title: `계정 ${i + 1} 로그인이 풀렸어요`, text: "다시 로그인할까요?", open: "alert", src: "alert", read: false, ts: t, updated: t, at: t }); }
	for (let i = 0; i < 6; i++) { const t = at(55 * i + 14); list.push({ id: id("f"), kind: "alert", tone: "fail", title: `세션 ${i + 1}이 멈췄어요`, text: "빌드가 실패해서 멈췄어요. 로그를 확인해 주세요", open: "alert", src: "alert", read: i > 1, ts: t, updated: t, at: t }); }
	for (let i = 0; i < 10; i++) { const t = at(100 * i + 16); list.push({ id: id("l"), kind: "worklog", tone: "", title: "작업 기록", text: `프로젝트 ${i + 1}의 밤 정리를 마쳤어요`, open: "worklog", src: "worklog", read: i > 3, ts: t, updated: t, at: t }); }
	for (let i = 0; i < 5; i++) { const t = at(120 * i + 18); list.push({ id: id("r"), kind: "result", tone: "done", title: `세션 ${i + 1}`, text: "끝났어요", open: `lane:s${i + 1}`, src: `lane:s${i + 1}`, read: i > 1, ts: t, updated: t, at: t }); }
	return list.sort((a, b) => b.updated.localeCompare(a.updated));
}

export const MONITORS = [
	{ name: "NAS 디스크 감시", watch: "nas-disk", kind: "watch", last_run: at(2), last_result: "changed", next_run: at(-28), every: "30분마다", fails: 0, last_ok: at(2) },
	{ name: "node security updates", watch: "node-security-updates", kind: "watch", last_run: at(4), last_result: "ok", next_run: at(-86), every: "90분마다", fails: 0 },
	{ name: "블로그 댓글 감시", watch: "blog-comments", kind: "watch", last_run: at(6), last_result: "changed", next_run: at(-44), every: "50분마다", fails: 0 },
	{ name: "서버 응답 감시", watch: "server-ping", kind: "watch", last_run: at(1), last_result: "fail", next_run: at(-29), every: "30분마다", fails: 15, last_ok: at(460), last_output: "응답이 없어요 (timeout)" },
	{ name: "아침 브리핑", kind: "schedule", last_run: at(67), last_result: "ok", next_run: at(-1373), every: "1일마다" },
];
export const INTEGRATIONS = [
	{ key: "mail", label: "메일", kind: "app", icon: "mail", conv: ["mail:"], unread: 4, notices: [], needs: { drafts: 2, unread: 4, sentToday: 1 } },
	{ key: "kakao", label: "카카오톡", kind: "app", icon: "kakao", conv: [], unread: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } },
];
export const LANES = Array.from({ length: 6 }, (_, i) => ({ name: `s${i + 1}`, title: `세션 ${i + 1}`, status: i < 2 ? "idle" : i < 4 ? "working" : "idle", startedAt: at(300), home: projectTarget(i * 3),
	...(i < 2 ? { pendingAsk: { at: at(10 + i), text: "어느 쪽으로 할까요?" }, lastText: "[ask] 어느 쪽으로 할까요?" } : { lastText: "작업 중이에요" }) }));

/** The conversations: the main chat, 알림, 작업내역, every project (70 of them unread), the sessions. */
export function conversations() {
	const items: Record<string, unknown>[] = [
		{ target: "main", unread: 3, read: at(50), last: { ts: at(5), text: "정리를 마쳤어요. 확인해 주세요", from: "bot" } },
		{ target: "alert", unread: 5, read: at(200), last: { ts: at(12), text: "계정 1 로그인이 풀렸어요", from: "bot" } },
		{ target: "worklog", unread: 2, read: at(300), last: { ts: at(16), text: "프로젝트 1의 밤 정리를 마쳤어요", from: "bot" } },
	];
	PROJECTS.forEach((p, i) => {
		const unread = i % 10 === 9 ? 0 : (i * 7) % 41 + 1;
		items.push({ target: `ch:${p.id}`, unread, read: at(600), last: { ts: at(9 * i + 3), text: i % 7 === 0 ? "테스트가 모두 통과했어요. 지금 배포할까요?" : `${p.name}의 ${i % 3 === 0 ? "빌드를 고쳤어요" : "문서를 정리했어요"}`, from: "bot" } });
	});
	for (const l of LANES) items.push({ target: `lane:${l.name}`, unread: 1, read: at(100), last: { ts: at(20), text: l.lastText, from: "session" } });
	return { items };
}
export const state = (unread: number) => ({ name: "dotz", orchestrator: { status: "idle" }, lanes: LANES, terminals: {}, channels: { work: Object.fromEntries(PROJECTS.map(p => [p.id, p.name])) }, discord: {}, notices_unread: unread });
export const custom = () => ({ projects: [{ key: "builtin:custom", name: "커스텀", builtin: true }, ...PROJECTS.map((p, i) => ({ key: `ch:${p.id}`, name: p.name, lanes: LANES.filter(l => l.home === `ch:${p.id}`).map(l => ({ name: l.name, title: l.title, live: true, status: l.status, waiting: !!l.pendingAsk })), ...(i % 13 === 5 ? { paused: true } : {}) }))] });

export type Store = { notices: FixNotice[]; reads: string[][]; answers: { id: string; n: number }[]; runs: string[]; readPosts: { target: string; ts: string }[]; failRead: boolean };

/** The fake hub. `store` is what the page changed; a test reads it after driving the page. */
export function serve(): { server: ReturnType<typeof Bun.serve>; store: Store; url: string } {
	const store: Store = { notices: notices(), reads: [], answers: [], runs: [], readPosts: [], failRead: false };
	const unread = () => store.notices.filter(n => !n.read).length;
	const json = (v: unknown, status = 200) => Response.json(v, { status });
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url), p = url.pathname;
			if (p === "/") return indexPage(req);
			const asset = appAsset(req, p);
			if (asset) return asset;
			if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
			if (p === "/api/state") return json(state(unread()));
			if (p === "/api/notices" && req.method === "GET") {
				const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 300));
				// The hub's order (hub/notices.ts listNotices): open decisions, then unread, then newest.
				const open = (n: FixNotice) => n.kind === "decision" && (n.decision as { state: string }).state === "open";
				const sorted = [...store.notices].sort((a, b) => Number(open(b)) - Number(open(a)) || Number(a.read) - Number(b.read) || b.updated.localeCompare(a.updated));
				return json({ items: sorted.slice(0, limit), unread: unread() });
			}
			if (p === "/api/notices/read" && req.method === "POST") {
				const b = (await req.json()) as { ids?: string[]; all?: boolean };
				if (store.failRead) return json({ error: "저장하지 못했어요" }, 500);
				const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
				store.reads.push(ids);
				const needs = (n: FixNotice) => !n.read && (n.tone === "ask" || (n.kind === "decision" && (n.decision as { state: string }).state === "open"));
				for (const n of store.notices) if (!n.read && !needs(n) && (b.all === true || ids.includes(n.id))) n.read = true;
				return json({ unread: unread() });
			}
			const m = /^\/api\/notices\/([^/]+)\/(answer|ignore|unignore)$/.exec(p);
			if (m && req.method === "POST") {
				const n = store.notices.find(x => x.id === decodeURIComponent(m[1]!));
				if (!n) return json({ error: "없어요" }, 404);
				const b = (await req.json().catch(() => ({}))) as { n?: number };
				if (m[2] === "answer") { store.answers.push({ id: n.id, n: Number(b.n) }); n.read = true; if (n.decision) (n.decision as Record<string, unknown>).state = "answered"; (n.decision as Record<string, unknown> | undefined) && ((n.decision as Record<string, unknown>).answer = `${b.n}) 답`); }
				else if (m[2] === "ignore") { n.read = true; n.ignored = true; if (n.decision) (n.decision as Record<string, unknown>).state = "ignored"; }
				else { n.read = false; delete n.ignored; if (n.decision) (n.decision as Record<string, unknown>).state = "open"; }
				return json({ ok: true, item: n, ids: [n.id], unread: unread() });
			}
			if (p === "/api/monitors") return json({ items: MONITORS });
			if (p === "/api/integrations") return json({ items: INTEGRATIONS });
			if (p === "/api/conversations") return json(conversations());
			if (p === "/api/custom") return json(custom());
			if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
			if (p === "/api/activity") return json({ items: [], more: false, history: false });
			if (p === "/api/update") return json({ settings: { auto_apply: false } });
			if (p === "/api/read" && req.method === "POST") { store.readPosts.push((await req.json()) as { target: string; ts: string }); return json({ ok: true }); }
			const run = /^\/api\/watches\/([^/]+)\/run$/.exec(p);
			if (run && req.method === "POST") { store.runs.push(decodeURIComponent(run[1]!)); return json({ ok: true }); }
			return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
		},
	});
	return { server, store, url: `http://127.0.0.1:${server.port}` };
}

/** A page expression that resolves once `cond` holds (polled per frame, 10 s at most). */
export const until = (cond: string, what: string, ms = 10_000) =>
	`new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = !!(${cond}); } catch {} if (ok) res(true); else if (Date.now() - t0 > ${ms}) rej(new Error(${JSON.stringify(what)})); else requestAnimationFrame(tick); }; tick(); })`;
