import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { run, waitFor } from "../hub/test-web.ts";

// The public demo (site/demo) answers every /api call itself (demo-api.js). A settings screen that reads an answer the real hub shapes differently
// goes blank. Headless Bun.WebView on the committed demo files, served from a temp port; nothing here touches the owner's browser.
const ROOT = join(import.meta.dir, "..", "site");
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		let p = new URL(req.url).pathname;
		if (p.endsWith("/")) p += "index.html";
		const f = Bun.file(join(ROOT, p));
		return f.size ? new Response(f) : new Response("not found", { status: 404 });
	},
});
afterAll(() => server.stop(true));

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); });
const text = async (v: View, sel: string) => JSON.parse((await v.evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).innerText)`)) as string) as string;

const open = async (width: number, page: string): Promise<View> => {
	const v = new Bun.WebView({ width, height: width < 600 ? 844 : 800 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/demo/`);
	await waitFor(v, `typeof go === "function" && NM.loaded`);
	await run(v, `go(${JSON.stringify(page)})`);
	return v;
};

test.each([390, 1280])("pressing 새 버전 확인 in the demo leaves the update screen with its heading and status at %ipx", async width => {
	const v = await open(width, "update");
	await waitFor(v, `document.querySelector("#update .btn.inrow")`);
	await run(v, `document.querySelector("#update .btn.inrow").click()`);
	await waitFor(v, `UPD.checking === false && UPD.info && UPD.info.lastCheck !== undefined`);
	const screen = await text(v, "#update");
	expect(screen).toContain("앱 버전");
	expect(screen).toContain("최신 버전이에요");
});

test("a toggle on the update screen keeps the screen and shows the new value", async () => {
	const v = await open(390, "update");
	await waitFor(v, `document.querySelector('#update [aria-label="새 버전 자동 적용"]')`);
	await run(v, `document.querySelector('#update [aria-label="새 버전 자동 적용"]').click()`);
	await waitFor(v, `document.querySelector('#update [aria-label="새 버전 자동 적용"]').getAttribute("aria-checked") === "true"`);
	expect(await text(v, "#update")).toContain("앱 버전");
});

test("a toggle on the notification screen is answered with the class list the screen reads back", async () => {
	const v = await open(390, "notifications");
	await waitFor(v, `document.querySelector('#notifications [aria-label="진행 알림"]')`);
	await run(v, `document.querySelector('#notifications [aria-label="진행 알림"]').click()`);
	await waitFor(v, `APPN.v && APPN.v.log === true`, 3000);
	await waitFor(v, `document.querySelector('#notifications [aria-label="진행 알림"]').getAttribute("aria-checked") === "true"`);
	expect(await text(v, "#notifications")).toContain("알림 종류");
});
