import { afterAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { appAsset, indexPage } from "./webapp.ts";

// The 감시 소식 feed draws a report that names a mail with the mail row card (neutral fixtures), and a report whose item is unknown as text.
const at = (minutesAgo: number) => new Date(Date.parse(now()) - minutesAgo * 60_000).toISOString();
const report = (id: string, minutesAgo: number, title: string, text: string, item?: unknown) => ({ id, ts: at(minutesAgo), updated: at(minutesAgo), at: at(minutesAgo), kind: "watch", tone: "", title, open: "alert", src: "alert", read: true, text, ...(item ? { item } : {}) });
const RAW = "```원문\nMAIL 1001 html=True atts=1\nDOTZ_ITEM mail:sample/1001\n```";
const NOTICES = [
	report("m", 5, "샘플 메일 점검", `샘플 메일 점검: 찾던 내용이 나왔어요\n${RAW}`, {
		app: "mail", id: "sample/1001", key: "sample-1001",
		card: { subject: "분기 보고서 검토 요청", from: "김샘플 <sample@example.com>", source: "sample", at: at(7), summary: "첫째 줄 요약\n둘째 줄 요약", attachments: [{ name: "report.pdf", type: "application/pdf", size: 2048 }], html: true },
	}),
	report("f", 20, "샘플 상대 점검", "샘플 상대 점검: 찾던 내용이 나왔어요\n```원문\nDOTZ_ITEM mail:peer/9\n```", { app: "mail", id: "peer/9", card: { subject: "상대 게이트웨이 메일", from: "상대" } }),
	report("u", 40, "샘플 빈 점검", "샘플 빈 점검: 결과가 바뀌었어요\n새로 생겼어요: 샘플", { app: "mail", id: "peer/10" }),
];

const json = (v: unknown) => Response.json(v);
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		if (url.pathname === "/api/events") return new Response(new ReadableStream({}), { headers: { "content-type": "text/event-stream" } });
		if (url.pathname === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (url.pathname === "/api/notices") return json({ items: NOTICES, unread: 0 });
		if (url.pathname === "/api/monitors") return json({ items: [] });
		return url.pathname.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

test("the feed draws the mail row card for a mail report and text for an unknown item, at 390px", async () => {
	const v = new Bun.WebView({ width: 390, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
	await v.navigate(`http://127.0.0.1:${server.port}/?light#monitoring/notice`);
	const got = JSON.parse(
		(await v.evaluate(`new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error("feed not drawn")), 10000);
			const tick = () => {
				const cards = document.querySelectorAll("#mon-tl > .bm.rc");
				if (cards.length >= 3) {
					clearTimeout(t);
					const mail = cards[0], q = s => mail.querySelector(s)?.textContent ?? null;
					res(JSON.stringify({ mail: mail.classList.contains("mr"), button: mail.getAttribute("role"), src: q(".rc-src"), title: q(".rc-title"), sum: q(".mr-sum"), clip: q(".mr-clip"), time: !!mail.querySelector(".rc-time"), fold: q(".rc-raw summary"),
						peer: { mr: cards[1].classList.contains("mr"), button: cards[1].getAttribute("role"), src: cards[1].querySelector(".rc-src")?.textContent, title: cards[1].querySelector(".rc-title")?.textContent },
						plain: { mr: cards[2].classList.contains("mr"), text: cards[2].textContent } }));
				} else requestAnimationFrame(tick);
			};
			tick();
		})`)) as string,
	);
	if (process.env.WATCH_ITEM_SHOT) await Bun.write(process.env.WATCH_ITEM_SHOT, await v.screenshot());
	await v.evaluate(`(document.querySelector("#mon-tl > .bm.rc").click(), 0)`);
	expect(got.mail).toBe(true);
	expect(got.button).toBe("button");
	expect(got).toMatchObject({ src: "김샘플", title: "분기 보고서 검토 요청", sum: "첫째 줄 요약 둘째 줄 요약", clip: "1", time: true, fold: "원문 보기" });
	expect(got.peer).toMatchObject({ mr: false, button: null, src: "상대", title: "상대 게이트웨이 메일" });
	expect(got.plain.mr).toBe(false);
	expect(got.plain.text).toContain("새로 생겼어요: 샘플");
	const hash = await v.evaluate("location.hash");
	expect(String(hash)).toBe("#monitoring/c:mail%3Asample-1001");
});
