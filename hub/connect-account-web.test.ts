import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, idleState, json, on } from "./test-web.ts";

// A fresh install with no model account shows one "계정 연결" row on home and in the empty chat; it opens the settings accounts screen
// and is gone once an account is connected. Read from /api/providers, the same list the settings accounts screen draws.
let accounts = 0;
const hub = fakeHub({
	state: idleState(),
	api: (_req, url) => {
		if (url.pathname === "/api/providers") return json({ providers: [{ id: "anthropic", name: "Claude", auth: accounts ? "oauth" : "none", can_login: true }], addable: null });
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		if (url.pathname === "/api/conversations") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
const view = await hub.view();
afterAll(() => hub.stop());
const { waitFor } = on(view);
const rows = (scope: string) => view.evaluate(`document.querySelectorAll(${JSON.stringify(`${scope} [data-connect-account]`)}).length`) as Promise<number>;
const boot = async () => {
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof NT !== "undefined" && NT.loaded && S && current === "home" && HOME_READY && P`);
};

describe("계정 연결 줄", () => {
	test("계정이 0개면 홈과 빈 채팅에 하나씩 있고, 누르면 설정 계정 화면이 열려요", async () => {
		accounts = 0;
		await boot();
		expect(await rows("#home-now")).toBe(1);
		expect(await rows("#home-cards")).toBe(0);
		await view.evaluate(`go("chat")`);
		await waitFor(`current === "chat" && document.querySelector("#tl .empty")`);
		expect(await rows("#tl")).toBe(1);
		await view.evaluate(`go("home")`);
		await waitFor(`current === "home" && document.querySelector("#home-now [data-connect-account]")`);
		await view.evaluate(`document.querySelector("#home-now [data-connect-account] button").click()`);
		await waitFor(`current === "accounts"`);
	});

	test("계정이 하나라도 연결돼 있으면 어디에도 없어요", async () => {
		accounts = 1;
		await boot();
		expect(await rows("#home-now")).toBe(0);
		await view.evaluate(`go("chat")`);
		await waitFor(`current === "chat" && document.querySelector("#tl .empty")`);
		expect(await rows("#tl")).toBe(0);
	});
});
