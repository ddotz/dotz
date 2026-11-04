// A chat turn in a project changes what its page shows (owner 2026-11-05: the page only ever showed the purpose set at creation). The real answer
// path (outbound.out), the real project detail (hub/custom.ts) and the real page; the only thing not real is the stream's transport.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { customRoute } from "./custom.ts";
import { type HubEvent, onBroadcast, onEmit } from "./events.ts";
import { out } from "./outbound.ts";
import { saveProject } from "./projects.ts";
import { ev, fakeHub, idleState, json, run, waitFor, type View } from "./test-web.ts";

const SHOTS = process.env.PROJECT_INFO_SHOTS;
const SHOTS_TAG = process.env.PROJECT_INFO_TAG ?? "after";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const work: Record<string, string> = { "7001": "윈도우-화면앱", "7002": "윈도우-화면앱" };
const deps = { lanes: () => [], channels: () => ({ work }), send: async () => {} };
const hub = fakeHub({
	stream: "fake",
	slowTimers: true,   // the page's 20 s refresh never runs here: only the stream can change the screen
	state: idleState({ channels: { work } }),
	api: async (req, url) => {
		if (url.pathname.startsWith("/api/custom")) return customRoute(req, url, deps);
		if (url.pathname === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (url.pathname === "/api/conversations" || url.pathname === "/api/monitors") return json({ items: [] });
		if (url.pathname === "/api/notices") return json({ unread: 0, items: [] });
	},
});
onBroadcast(e => hub.push(e));
const sent: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && sent.push(e)));
afterAll(() => { hub.stop(); });

const TURN = `레지스트리에 없는 키는 빼고, OCR은 PC 안에서 끝내기로 정리했어요.

<project-info>
summary: 회사 PC에서 쓸 화면 글자·표 복사 앱을 설계하는 중이에요. 코드는 아직 없어요.
decided: OCR은 AI 서버를 쓰지 않고 PC 안에서 끝낸다
next: 회사 PC에서 한국어 OCR이 깔려 있는지 확인
blocked: 사내 AI 서버 인증 방식을 형이 회사에서 확인해야 해요
result: 처리 경계를 문서로 정리했어요
file: 설계 메모 | ~/.dotz/projects/windows-screen-app/README.md
pref: 답은 결론부터 짧게
</project-info>`;

const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const text = (v: View) => ev<string>(v, `document.querySelector("#v-project").innerText`);

for (const [width, id] of [[390, "7001"], [1280, "7002"]] as const)
	test(`a chat turn in the project changes its page at once (${width}px)`, async () => {
		const key = `ch:${id}`;
		saveProject({ key, title: "윈도우 화면 앱", purpose: "Cracker를 참고한 윈도우용 화면 글자 복사·표 복사·번역 앱." });
		const v = await hub.view({ width, height: 844 });
		const opened = hub.nextStream();
		await v.navigate(`${hub.origin}/`);
		await opened;
		await waitFor(v, `typeof S !== "undefined" && S && typeof PRJ !== "undefined"`);
		await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle(); go("project", ${JSON.stringify(key)})`);
		await waitFor(v, `current === "project" && PM.D && document.querySelector("#v-project .pm-o")`);
		expect(await text(v)).not.toContain("PC 안에서 끝낸다");

		await out(key, TURN);
		await shot(v, `${SHOTS_TAG}-${width}.png`);
		// What the owner reads is the answer alone, and everything the page got came down the stream.
		expect(String(sent.find(e => e.target === key)?.text)).toBe("레지스트리에 없는 키는 빼고, OCR은 PC 안에서 끝내기로 정리했어요.");
		await waitFor(v, `document.querySelector("#v-project").innerText.includes("PC 안에서 끝낸다")`);
		await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`);
		await shot(v, `${SHOTS_TAG}-${width}.png`);
		const shown = await text(v);
		for (const fact of ["코드는 아직 없어요", "한국어 OCR이 깔려 있는지", "사내 AI 서버 인증 방식", "처리 경계를 문서로", "설계 메모"]) expect(shown).toContain(fact);
		expect(shown).not.toContain(".dotz");
		expect(await ev<number>(v, `document.documentElement.scrollWidth - innerWidth`)).toBeLessThanOrEqual(0);
	});
