import { afterAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { fakeHub, json } from "./test-web.ts";
import { watchLine } from "./watchtext.ts";

// A watch report of changed items (one "<kind>: <owner/repo>#<n> <author> <title>" line each, neutral fixture text) opens in the 감시 소식 feed as
// one row per item: the kind as a small tag, the number and title in front, the repository and author muted. An item that only changed kind is not
// listed as gone, and the card's title counts what happened.
const PREV = ["새 이슈: sample/repo#67 user-c 셋째 샘플 제목", "새 이슈: sample/repo#68 user-d 넷째 샘플 제목", "새 이슈: sample/repo#69 user-e 다섯째 샘플 제목"].join("\n");
const CUR = ["이슈 갱신: sample/repo#65 user-a 첫째 샘플 제목이 조금 길어서 줄이 넘어가요", "이슈 갱신: sample/repo#66 user-b 둘째 샘플 제목", "이슈 갱신: sample/repo#67 user-c 셋째 샘플 제목", "이슈 갱신: sample/repo#69 user-e 다섯째 샘플 제목"].join("\n");
const ts = new Date(Date.parse(now()) - 5 * 60_000).toISOString();
const NOTICE = { id: "w1", ts, updated: ts, at: ts, kind: "watch", tone: "", title: "sample items", open: "alert", src: "alert", read: true, text: watchLine("sample-items", "match", CUR, { prev: PREV }) };

const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items: [NOTICE], unread: 0 });
		if (url.pathname === "/api/monitors") return json({ items: [] });
	},
});
afterAll(() => hub.stop());

const SHOTS = process.env.WATCH_CARD_SHOTS;   // a folder: the card at 390 and 1280 in light and dark is saved there

for (const [width, theme] of SHOTS ? [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const : [[390, "light"]] as const)
	test(`a changed-items report opens as rows with a counted title (${width}px ${theme})`, async () => {
		const v = await hub.view({ width, height: 900 });
		await v.navigate(`${hub.origin}/`);
		await v.evaluate(`(localStorage.setItem("dotz-theme", ${JSON.stringify(theme)}), true)`);
		await v.navigate(`${hub.origin}/?${theme}#monitoring/notice`);
		const got = JSON.parse(
			(await v.evaluate(`new Promise((res, rej) => {
				const t = setTimeout(() => rej(new Error("card not drawn")), 10000);
				const tick = () => {
					const card = document.querySelector('#mon-tl .bm.rc[data-nid="w1"]');
					if (card) {
						clearTimeout(t);
						const rows = [...card.querySelectorAll(".rc-row")];
						res(JSON.stringify({
							title: card.querySelector(".rc-title")?.textContent,
							heads: [...card.querySelectorAll(".rc-rows > .rc-sh")].map(h => h.textContent),
							rows: rows.map(r => ({ tag: r.querySelector(".tag")?.textContent ?? "", lead: r.querySelector("b")?.textContent ?? "", meta: r.querySelector(".rc-d")?.textContent ?? "", text: r.textContent.trim() })),
							joined: card.textContent.includes(" · 이슈 갱신"),
						}));
						return;
					}
					requestAnimationFrame(tick);
				};
				tick();
			})`)) as string,
		);
		if (SHOTS) {
			await v.evaluate(`(document.querySelector('#mon-tl [data-nid="w1"]').scrollIntoView({ block: "start" }), true)`);
			await Bun.write(`${SHOTS}/watch-card-${width}-${theme}.png`, await v.screenshot());
		}
		expect(got.title).toBe("이슈 갱신 4건 · 사라진 항목 1건");
		expect(got.joined).toBe(false);
		expect(got.rows).toEqual([
			{ tag: "이슈 갱신", lead: "#65 첫째 샘플 제목이 조금 길어서 줄이 넘어가요", meta: "sample/repo · user-a", text: expect.any(String) },
			{ tag: "이슈 갱신", lead: "#66 둘째 샘플 제목", meta: "sample/repo · user-b", text: expect.any(String) },
			{ tag: "이슈 갱신", lead: "#67 셋째 샘플 제목", meta: "sample/repo · user-c · 새 이슈에서 바뀜", text: expect.any(String) },
			{ tag: "", lead: "", meta: "외 1건", text: "외 1건" },
			{ tag: "새 이슈", lead: "#68 넷째 샘플 제목", meta: "sample/repo · user-d", text: expect.any(String) },
		]);
		expect(got.heads).toEqual(["사라졌어요"]);
	});
