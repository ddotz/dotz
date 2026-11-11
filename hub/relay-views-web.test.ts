import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// 홈 / 프로젝트 / 모니터링 / 설정 while a messenger-only computer is the chosen one (web/js/44-relay-views.js), on the real page at 390px. The fake hub
// answers the relay's /status with a snapshot (or none) and the gateway's own routes with data that must never show while that computer is chosen.
const SELF = { name: "맥미니", self: true, online: true };
const WORK = { name: "work", url: "/#chat/relay:jandi:work", self: false, online: true, via: "jandi", key: "work", note: "잔디로 주고받아요" };
const RELAY = "/api/relay/jandi/work";
const OWN = "내 프로젝트";
const OWN_MON = "내 모니터";

const snapshot = () => ({
	at: Date.now() - 120_000,
	projects: [{ key: "dir:~/Code/site", name: "회사 사이트", note: "홈페이지를 고쳐요", live: 2 }],
	sessions: [{ name: "빌드 세션", status: "일하는 중", live: true }],
	monitors: [{ name: "배포 확인", kind: "web", result: "ok", last: "10분 전", next: "20분 후", summary: "문제 없어요" }],
	todos: { open: 3, items: ["문서 정리", "테스트 추가"] },
	notices: [{ at: "09:10", tone: "ok", title: "배포가 끝났어요" }],
});

let snap: object | null;
let groups: object[];
const hub = fakeHub({
	api: async (_req, url) => {
		const p = url.pathname;
		if (p === "/api/peers") return json([{ ...SELF, url: hub.origin }, WORK]);
		if (p === `${RELAY}/status`) return json(snap ? { snapshot: snap, received_at: Date.now() - 60_000 } : { snapshot: null });
		if (p === `${RELAY}/messages`) return json([]);
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], routines: [], links: [], projects: [{ key: "dir:~/Code/own", name: OWN, pinned: true, lanes: [], record: { title: OWN, purpose: OWN, updated: "2026-10-25T09:00:00.000Z" } }] });
		if (p === "/api/custom/computers") return json(groups);
		if (p === "/api/monitors") return json({ items: [{ name: OWN_MON, watch: "own", kind: "web", last_run: new Date().toISOString(), last_result: "ok" }] });
		return undefined;
	},
});
const view = await hub.view({ width: 390, height: 844 });
const { waitFor, ev, run } = on(view);
afterAll(() => hub.stop());

beforeEach(() => {
	snap = snapshot();
	groups = [{ name: "맥미니", self: true, online: true, keys: ["dir:~/Code/own"], remote: [] }];
});
afterEach(() => run("localStorage.clear()"));

async function open(hash = "") {
	await view.navigate("about:blank");
	await view.navigate(`${hub.origin}/${hash}`);
}
const pickRow = async (name: string) => {
	await run(`prOpen();`);
	await waitFor(`document.querySelectorAll(".pr-sheet .pr-row").length >= 2`);
	await run(`[...document.querySelectorAll(".pr-sheet .pr-row")].find(b => b.querySelector(".pr-t")?.textContent === ${JSON.stringify(name)}).click();`);
};
const relayOpen = async () => {
	await open();
	await waitFor(`PR.list.length === 2`);
	await pickRow("work");
	await waitFor(`target === "relay:jandi:work" && current === "chat"`);
};
const show = async (name: string) => {
	await run(`go(${JSON.stringify(name)})`);
	await waitFor(`current === ${JSON.stringify(name)} && document.querySelector("#v-${name} > .rv")`);
	return ev<string>(`document.querySelector("#v-${name} > .rv").textContent`);
};
const buttons = (name: string) => ev<string[]>(`[...document.querySelectorAll("#v-${name} > .rv button")].map(b => b.dataset.k)`);

describe("a relayed computer chosen, read-only screens", () => {
	test("홈 keeps the relay target and draws the snapshot: sessions, to-dos, notices, how old it is", async () => {
		await relayOpen();
		const text = await show("home");
		expect(await ev(`target`)).toBe("relay:jandi:work");
		for (const s of ["마지막 갱신", "빌드 세션", "문서 정리", "배포가 끝났어요", "읽기 전용이에요"]) expect(text).toContain(s);
		expect(await ev(`document.querySelector("#brand-name").textContent`)).toBe("work");
		expect(await buttons("home")).toEqual(["relay-chat"]);
	});

	test("프로젝트 lists its projects, not this computer's, without create or edit controls", async () => {
		await relayOpen();
		const text = await show("projects");
		expect(await ev(`target`)).toBe("relay:jandi:work");
		expect(text).toContain("회사 사이트");
		expect(text).toContain("홈페이지를 고쳐요");
		expect(text).not.toContain(OWN);
		expect(await buttons("projects")).toEqual(["relay-chat"]);
	});

	test("모니터링 lists its monitors, not this computer's, without run or pause buttons", async () => {
		await relayOpen();
		const text = await show("monitoring");
		expect(await ev(`target`)).toBe("relay:jandi:work");
		expect(text).toContain("배포 확인");
		expect(text).toContain("문제 없어요");
		expect(text).not.toContain(OWN_MON);
		expect(await buttons("monitoring")).toEqual(["relay-chat"]);
	});

	test("설정 gives way to a note, with the way back to this computer's settings", async () => {
		await relayOpen();
		const text = await show("settings");
		expect(text).toContain("채팅으로 요청해요");
		expect(await buttons("settings")).toEqual(["relay-chat", "relay-leave"]);
	});

	test("picking this computer again brings its own data back", async () => {
		await relayOpen();
		await show("home");
		await pickRow("맥미니");
		await waitFor(`target === "main" && !RELAY.cur`);
		await run(`go("projects")`);
		await waitFor(`document.querySelector("#v-projects .pl-row")`);
		expect(await ev<string>(`document.querySelector("#v-projects").textContent`)).toContain(OWN);
		expect(await ev(`!!document.querySelector(".rv")`)).toBe(false);
		await run(`go("home")`);
		await waitFor(`current === "home" && !document.querySelector("#v-home.rv-on")`);
	});

	test("a computer that has not sent its status yet shows how to turn it on", async () => {
		snap = null;
		await relayOpen();
		const text = await show("home");
		expect(text).toContain("아직 상태를 보내지 않았어요");
		expect(text).toContain("이 컴퓨터 상태를 잔디로 보내기");
		expect(text).not.toContain("마지막 갱신");
	});

	test("a relay computer's project in the 프로젝트 list opens its read-only projects", async () => {
		groups = [
			{ name: "맥미니", self: true, online: true, keys: ["dir:~/Code/own"], remote: [] },
			{ name: "work", self: false, online: true, relay: "relay:jandi:work", status_at: Date.now() - 60_000, keys: [], remote: [{ key: "dir:~/Code/site", name: "회사 사이트", note: "홈페이지를 고쳐요" }] },
		];
		await open("#projects");
		await waitFor(`document.querySelector("#pl-list .pl-pc")`);
		await waitFor(`[...document.querySelectorAll("#pl-list .pl-row .pl-n")].some(n => n.textContent === "회사 사이트")`);
		await run(`[...document.querySelectorAll("#pl-list .pl-row")].find(r => r.querySelector(".pl-n")?.textContent === "회사 사이트").click()`);
		await waitFor(`target === "relay:jandi:work" && current === "projects" && document.querySelector("#v-projects > .rv")`);
		const text = await ev<string>(`document.querySelector("#v-projects > .rv").textContent`);
		expect(text).toContain("회사 사이트");
		expect(text).not.toContain(OWN);
	});
});
