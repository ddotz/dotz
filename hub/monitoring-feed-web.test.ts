import { afterAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { fakeHub, json } from "./test-web.ts";

// The 감시 소식 feed in a headless browser: newest report on top, older going down, at desktop and phone width.
const at = (minutesAgo: number) => new Date(Date.parse(now()) - minutesAgo * 60_000).toISOString();
const report = (id: string, minutesAgo: number, title: string, text: string) => ({ id, ts: at(minutesAgo), updated: at(minutesAgo), at: at(minutesAgo), kind: "watch", tone: "", title, open: "alert", src: "alert", read: true, text });
// Stored out of order on purpose: the page, not the file, decides what is on top.
const NOTICES = [
	report("b", 30, "샘플 가 감시", "샘플 가 감시: 결과가 바뀌었어요\n새로 생겼어요: 둘째"),
	report("c", 90, "샘플 나 감시", "샘플 나 감시: 결과가 바뀌었어요\n새로 생겼어요: 셋째"),
	report("a", 5, "샘플 다 감시", "샘플 다 감시: 결과가 바뀌었어요\n새로 생겼어요: 첫째"),
	// An app's report (the hub stamps `app`) is newest of all but never in the feed.
	{ ...report("z", 1, "샘플 앱 감시", "샘플 앱 감시: 결과가 바뀌었어요"), app: "mail" },
];

const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items: NOTICES, unread: 0 });
		if (url.pathname === "/api/monitors") return json({ items: [] });
	},
});
afterAll(() => hub.stop());

for (const width of [390, 1440]) {
	test(`the watch feed lists the newest report on top at ${width}px`, async () => {
		const v = await hub.view({ width, height: 900 });
		await v.navigate(`${hub.origin}/`);
		await v.evaluate(`(localStorage.setItem("dotz-theme", "light"), true)`);
		await v.navigate(`${hub.origin}/?light#monitoring/notice`);
		const got = JSON.parse(
			(await v.evaluate(`new Promise((res, rej) => {
				const t = setTimeout(() => rej(new Error("feed not drawn")), 10000);
				const tick = () => {
					const cards = document.querySelectorAll("#mon-tl > .bm.rc");
					if (cards.length >= 3) { clearTimeout(t); res(JSON.stringify({ src: [...cards].map(c => c.querySelector(".rc-src")?.textContent), top: document.querySelector("#mon-timeline").scrollTop })); }
					else requestAnimationFrame(tick);
				};
				tick();
			})`)) as string,
		) as { src: string[]; top: number };
		expect(got.src).toEqual(["샘플 다 감시", "샘플 가 감시", "샘플 나 감시"]);
		expect(got.top).toBe(0);
	});
}
