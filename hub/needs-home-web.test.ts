import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 홈 답변 필요 (web/js/09-needs-you.js nyList, 08-home.js renderHomeNow) in a headless browser at 390 and 1280 against a fixture of every kind of
// item that can wait. Owner 2026-10-26: what the owner must do comes first, system notices the gateway handles are not asked, critical ones are
// marked. Screenshots go to NEEDS_SHOTS when it names a folder.
const SHOTS = process.env.NEEDS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const at = (m: number) => new Date(Date.UTC(2026, 9, 26, 1, m)).toISOString();
const dec = (id: string, m: number, title: string, to: string, extra: Record<string, unknown> = {}, d: Record<string, unknown> = {}) => ({
	id, kind: "decision", tone: "ask", title, text: title, open: to, src: to, at: at(m), ts: at(m), updated: at(m), read: false, ...extra,
	decision: { to, reply_to: at(m), group: 1, state: "open", options: [{ n: 1, label: "예", rec: true }, { n: 2, label: "아니요" }], ...d },
});
const notices = [
	dec("d-auth", 1, "구글 계정 로그인이 필요해요", "auth:google", { by: "gateway" }),
	dec("d-fail", 2, "메일 감시가 계속 실패해요", "alert", { by: "gateway", tone: "fail" }),
	dec("d-draft1", 3, "김민수 님께 답장 보낼까요?", "mail:m1", { by: "orchestrator" }, { draft: { to: "kim@example.com", body: "확인했어요" } }),
	dec("d-draft2", 4, "이영희 님께 답장 보낼까요?", "mail:m2", { by: "orchestrator" }, { draft: { to: "lee@example.com", body: "네" } }),
	dec("d-draft3", 5, "박지훈 님께 답장 보낼까요?", "mail:m3", { by: "orchestrator" }, { draft: { to: "park@example.com", body: "좋아요" } }),
	dec("d-q", 6, "회의실 어디로 잡을까요?", "main", { by: "orchestrator" }),
	{ id: "gw-update", kind: "alert", tone: "ask", by: "gateway", title: "게이트웨이 업데이트", text: "새 버전이 있어요. 업데이트할까요?", open: "alert", src: "alert", at: at(7), ts: at(7), updated: at(7), read: false },
	{ id: "gw-login", kind: "alert", tone: "ask", by: "gateway", title: "카카오톡 로그인", text: "카카오톡 로그인이 풀렸어요. 다시 로그인해 주세요", open: "alert", src: "alert", at: at(8), ts: at(8), updated: at(8), read: false },
];
const lanes = [
	...["alpha", "beta", "gamma"].map((name, i) => ({ name, status: "idle", live: true, alive: true, pendingAsk: { text: `${name} 세션: 어느 브랜치에 합칠까요?`, at: at(10 + i) } })),
	{ name: "limited", status: "rate-limited", live: true, alive: true },
];

const json = (v: unknown) => Response.json(v);
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
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes, terminals: {}, channels: { work: [] }, discord: {}, notices_unread: notices.length });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: notices.length, items: notices });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); server.stop(true); });
const waitFor = (expr: string, ms = 10_000) =>
	view.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(code: string): Promise<T> => JSON.parse((await view.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const LIST = `document.querySelector('#home-now [data-k="needs"]')`;
const rows = () => q<{ name: string; act: string; crit: boolean }[]>(`return [...${LIST}.children].filter(r => r.matches(".hr, .ntg, .srow, button, div") && r.querySelector(".hs, .sw, [data-k]")).filter(r => !r.matches('[data-k="ny-more"]')).map(r => ({ name: (r.querySelector(".nm") || r).textContent.trim(), act: (r.querySelector(".hs") || r.querySelector(".sw") || {}).textContent || "", crit: r.classList.contains("crit") }))`);
const boot = async (w: number, h: number) => {
	await view.resize?.(w, h);
	await view.evaluate(`(() => { try { localStorage.removeItem("dotz-ntf-done"); } catch {} })()`);
	await view.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && ${LIST}`);
	await view.evaluate(`(dotzTheme.get() === "dark" && dotzTheme.toggle(), 0)`);
};

for (const [w, h] of [[390, 844], [1280, 900]] as const) {
	describe(`답변 필요 at ${w}px`, () => {
		test("one list, critical first and marked, each row says what to do; gateway-handled notices and rate limits are not asked", async () => {
			await boot(w, h);
			expect(await q(`return document.querySelector("#home-now .hn-h .sup").textContent`)).toBe("10");
			const r = await rows();
			expect(r).toHaveLength(5);
			expect(r.slice(0, 3).map(x => x.crit)).toEqual([true, true, true]);
			expect(r.slice(3).every(x => !x.crit)).toBe(true);
			expect(r.slice(0, 3).map(x => x.act)).toEqual(["로그인", "선택", "로그인"]);   // newest first within a rank
			expect(r[3]!.act).toBe("보내기 확인");
			expect(await q(`return ${LIST}.textContent`)).not.toContain("업데이트");
			expect(await q(`return ${LIST}.textContent`)).not.toContain("한도 걸림");
			expect(await q(`return document.querySelector("#home-now .hn-h .tag.warn").textContent`)).toBe("중요 3");
			expect(await q(`return [...document.querySelectorAll(".hc-row .t")].map(e => e.textContent)`)).toContain("게이트웨이 업데이트");
			// the chat list's 답 필요 uses the same rule: the gateway's update question alone does not make its conversation wait
			expect(await q(`const keep = NT.items; NT.items = keep.filter(n => n.id === "gw-update"); try { return convNeeds("alert"); } finally { NT.items = keep; }`)).toBe(false);
			if (SHOTS) await Bun.write(join(SHOTS, `B-home-needs-${w}.png`), await view.screenshot());
		}, 15_000);

		test("a long list shows the top five and 더 보기 opens the rest; the count stays the item count", async () => {
			const more = `${LIST}.querySelector('[data-k="ny-more"]')`;
			expect(await q(`return ${more}.textContent`)).toBe("더 보기 · 5개");
			await view.evaluate(`${more}.click()`);
			await waitFor(`!${more} || ${more}.textContent === "접기"`);
			const r = await rows();
			expect(r).toHaveLength(10);
			expect(r.slice(-4).map(x => x.act)).toEqual(["선택", "답변", "답변", "답변"]);
			expect(await q(`return document.querySelector("#home-now .hn-h .sup").textContent`)).toBe("10");
			if (SHOTS) await Bun.write(join(SHOTS, `B-home-needs-open-${w}.png`), await view.screenshot());
			await view.evaluate(`${more}.click()`);
		});

		test("the session questions waiting at page open are one toast with their count, and it opens 홈", async () => {
			const cards = await q<string[]>(`return [...document.querySelectorAll(".ntf-box .ntf:not(.out) .nm")].map(e => e.textContent)`);
			expect(cards.filter(t => t.includes("답변 필요"))).toEqual(["답변 필요 3개"]);
			await view.evaluate(`go("projects")`);
			await view.evaluate(`[...document.querySelectorAll(".ntf-box .ntf:not(.out)")].find(c => c.textContent.includes("답변 필요 3개")).querySelector(".bd2").click()`);
			await waitFor(`current === "home"`);
		});
	});
}
