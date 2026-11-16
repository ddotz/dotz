import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// 모니터링 > 카카오톡 (web/js/30-kakao.js) at 1280: the quiet "대화방을 골라 주세요" line (.kk-note) belongs to the room list with no room picked, so it
// must not stay drawn behind or over an app-settings pane (web/js/32-app-settings.js) opened from the same app. Names are placeholders.
const hub = fakeHub({
	stream: "fake",
	api: async (_req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/reply/queue") return json({ items: [], counts: {}, triageMin: 1, undoSec: 10 });
		if (p === "/api/integrations") return json({ items: [{ key: "kakao", label: "카카오톡", icon: "chat", kind: "app", conv: [], notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } }] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [{ chatId: "100", name: "가나다 모임", kind: "group", watched: true, autoDraft: false, unread: 0, lastAt: Date.UTC(2026, 9, 22, 1) }] });
		if (p === "/api/integrations/kakao/settings") return json({ key: "kakao", fields: [] });
	},
});
afterAll(() => { hub.stop(); });

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const boot = async (v: View) => {
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `go("monitoring", "i:kakao")`);
	await waitFor(v, `!$("#kk").hidden && KK.loaded && document.querySelector(".kk-rooms .kk-lh") && document.querySelector(".kk-note")`);
};
// Is any .kk-note drawn at all, and does a drawn one overlap the settings pane?
const note = (v: View) => q<{ drawn: boolean; overPane: boolean }>(v, `
	const pane = document.querySelector("#as-pane"), pr = pane && pane.getBoundingClientRect();
	const drawn = [...document.querySelectorAll(".kk-note")].filter(n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== "hidden"; });
	return { drawn: drawn.length > 0, overPane: !!pr && drawn.some(n => { const r = n.getBoundingClientRect(); return r.left < pr.right && r.right > pr.left && r.top < pr.bottom && r.bottom > pr.top; }) }`);

describe("the room-list line over an app-settings pane at 1280x800", async () => {
	const v = await hub.view({ width: 1280, height: 800 });

	test("with no room picked the line shows; the settings pane takes it away; closing the pane brings it back", async () => {
		await boot(v);
		expect((await note(v)).drawn).toBe(true);
		await run(v, `asScreen("kakao")`);
		await waitFor(v, `document.querySelector("#as-pane .as-card") && document.querySelector("#v-monitoring").classList.contains("as-on")`);
		expect(await note(v)).toEqual({ drawn: false, overPane: false });
		await run(v, `document.querySelector("#back").click()`);
		await waitFor(v, `!document.querySelector("#as-pane .as-card")`);
		expect((await note(v)).drawn).toBe(true);
	});
});
