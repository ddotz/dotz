// 모니터링 앱 화면의 한 열: 머리 카드, 그 아래 카드, 섹션 제목이 왼쪽·오른쪽 끝을 같이 써요 (web/css/20-monitoring.css). 412와 1280에서 실제 사각형을 재요.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.EDGE_SHOTS;
const json = (v: unknown) => Response.json(v);
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const monitors = [
	{ name: "카카오톡 새 소식", kind: "watch", watch: "kakao-new", scope: "app", last_run: at(-1), next_run: at(1), last_ok: at(-1), last_result: "ok" },
	{ name: "가격 페이지", kind: "watch", watch: "price-page", scope: "plain", last_run: at(-2), next_run: at(2), last_ok: at(-2), last_result: "ok" },
	{ name: "로그인 유지", kind: "watch", watch: "login-keep", scope: "plain", last_run: at(-3), next_run: at(3), last_ok: at(-60), last_result: "fail", fails: 2 },
];
const notices = [{ id: "n1", kind: "watch", cls: "log", tone: "", watch: "가격 페이지", src: "alert", open: "alert", at: at(-2), title: "가격 페이지: 바뀐 곳은 없어요.", text: "가격 페이지: 바뀐 곳은 없어요.", read: true }];
const integrations = [{ key: "kakao", app: "kakao", label: "카카오톡", kind: "app", icon: "chat", conv: [], own: ["kakao-new"], unread: 0, unreplied: 0, notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } }];
const rooms = [{ chatId: "r1", name: "나와의 채팅", kind: "direct", hint: "전체 경로 보이게 수정", watched: true, unread: 0, lastAt: Date.now() - 60_000 }];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {} });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: notices });
		if (url.pathname === "/api/monitors") return json({ items: monitors });
		if (url.pathname === "/api/integrations") return json({ items: integrations, available: [] });
		if (url.pathname === "/api/kakao/rooms") return json({ on: true, rooms });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
afterAll(() => { server.stop(true); });

const waitFor = (view: InstanceType<typeof Bun.WebView>, expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
type Box = { l: number; r: number };
const edges = async (view: InstanceType<typeof Bun.WebView>, sels: string[]) =>
	JSON.parse(await view.evaluate(`JSON.stringify(${JSON.stringify(sels)}.flatMap(s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { s, l: r.left, r: r.right }; })))`) as string) as (Box & { s: string })[];

describe.each([[412, 844], [1280, 800]])("모니터링 앱 칸 at %ipx", (width, height) => {
	const view = new Bun.WebView({ width, height });
	afterAll(() => view.close());
	const open = async (key: string, ready: string) => {
		await view.navigate(`http://127.0.0.1:${server.port}/`);
		await waitFor(view, `typeof monItems === "function" && monItems().some(i => i.key === ${JSON.stringify(key)})`);
		await view.evaluate(`(go("monitoring", ${JSON.stringify(key)}), 0)`);
		await waitFor(view, `(${ready}) && !document.getAnimations().length`);
	};
	const shot = async (name: string) => { if (SHOTS) await Bun.write(join(SHOTS, `${name}-${width}.png`), await view.screenshot({ format: "png" })); };
	const headShown = width >= 1100;

	// The rooms are the app's panel (the left column on a wide window, the one column on a phone): its state and room cards share the panel's width and its
	// title and + 추가 its edges. On a wide window the head card is the content column's, to the right of the panel (the boxes against 채팅: kakao-comments-two-pane-web).
	test("카카오톡: 감시 상태와 대화방 카드가 방 목록 칸과 한 폭이고 제목과 + 추가도 같은 끝에 서요, 넓은 창의 머리는 그 오른쪽 칸에", async () => {
		await open("i:kakao", `document.querySelector("#kk-rooms .kk-own") && document.querySelector("#kk-rooms .kk-watch .kk-row")${headShown ? ` && document.querySelector("#mon-head .mon-hdwrap")` : ""}`);
		await shot("kakao");
		const cards = await edges(view, ["#kk-rooms", "#kk-rooms .kk-own", "#kk-rooms .kk-watch"]);
		expect(cards.length).toBe(3);
		const [one] = cards;
		for (const c of cards) expect({ s: c.s, l: c.l, r: c.r }).toEqual({ s: c.s, l: one.l, r: one.r });
		const [title] = await edges(view, ["#kk-rooms .kk-views .mr-f"]), [add] = await edges(view, ["#kk-add-btn"]);
		expect(title.l).toBe(one.l);
		expect(add.r).toBe(one.r);
		const head = await edges(view, ["#mon-head .mon-hdwrap"]);
		expect(head.length).toBe(headShown ? 1 : 0);
		if (headShown) expect(head[0].l).toBeGreaterThan(one.r);
	});

	test("카카오톡: 보기 알약이 지켜보는 방을 거르고, 빈 보기는 그렇다고 말해요", async () => {
		const rows = `document.querySelectorAll("#kk-rooms .kk-row").length`;
		expect(await view.evaluate(rows)).toBe(1);
		await view.evaluate(`(document.querySelector('#kk-rooms [data-view="unreplied"]').click(), 0)`);
		expect(await view.evaluate(rows)).toBe(0);
		expect(await view.evaluate(`document.querySelector("#kk-empty").textContent`)).toBe("미답장 대화방이 없어요");
		await view.evaluate(`(document.querySelector('#kk-rooms [data-view="all"]').click(), 0)`);
		expect(await view.evaluate(rows)).toBe(1);
	});

	test("예약 문구가 프롬프트 전체여도 경로와 명령 없이 사람 말만 보여요", async () => {
		const human = (s: string) => view.evaluate(`monHuman(${JSON.stringify(s)})`);
		expect(await human("주간 점검 시간이에요. ~/notes/README.md대로 돌려요. `bun ~/notes/collect.ts`로 모아요.")).toBe("주간 점검 시간이에요");
		expect(await human("주간 점검 확인(state.json weekly-1104, w…")).toBe("주간 점검 확인");
		expect(await human("피드백 데일리 보고: ssh -o BatchMode=yes host python3 - 24 < ~/.dotz/x.py")).toBe("피드백 데일리 보고");
		expect(await human("ssh -o BatchMode=yes host uptime")).toBe("");
		expect(await human("18시 릴리스 확인(state after-1800-release)")).toBe("18시 릴리스 확인");
		expect(await human("Next.js 새 버전(14.2)을 확인해요")).toBe("Next.js 새 버전(14.2)을 확인해요");
	});

	test("모니터 상세: 머리 카드와 확인 기록 카드가 한 폭이고 제목은 카드 왼쪽 끝에서 시작해요", async () => {
		await open("m:가격 페이지", `document.querySelector("#mon-tl > .mon-log")${headShown ? ` && document.querySelector("#mon-head .mon-hdwrap")` : ""}`);
		await shot("monitor");
		const cards = await edges(view, ["#mon-head .mon-hdwrap", "#mon-tl > .mon-topcard", "#mon-tl > .mon-log"]);
		expect(cards.length).toBe(2);
		const [one] = cards;
		for (const c of cards) expect({ s: c.s, l: c.l, r: c.r }).toEqual({ s: c.s, l: one.l, r: one.r });
		const [title] = await edges(view, ["#mon-tl > .mon-sec"]);
		expect(title.l).toBe(one.l);
		expect(title.r).toBe(one.r);
		const gaps = JSON.parse(await view.evaluate(`JSON.stringify((() => { const s = document.querySelector("#mon-tl > .mon-sec"), b = s.getBoundingClientRect(), p = s.previousElementSibling; return { below: s.nextElementSibling.getBoundingClientRect().top - b.bottom, above: p ? b.top - p.getBoundingClientRect().bottom : null }; })())`) as string);
		expect(gaps).toEqual({ below: 8, above: headShown ? null : 24 });
	});

	test("마지막 정상: 정상인 모니터에는 없고, 실패 뒤에만 나와요", async () => {
		const log = `document.querySelector("#mon-tl > .mon-log").innerText`;
		await open("m:가격 페이지", `document.querySelector("#mon-tl > .mon-log")`);
		expect(await view.evaluate(log)).not.toContain("마지막 정상");
		await open("m:로그인 유지", `document.querySelector("#mon-tl > .mon-log")`);
		expect(await view.evaluate(log)).toContain("마지막 정상");
	});
});
