import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommentAdapter, RawComment } from "./comments/contract.ts";
import { appOf, createEngine } from "./comments/engine.ts";
import { createCommentsWeb } from "./comments/web.ts";
import { appEntries, commentOwner, integrationAvailable, integrationContext, integrationItems } from "./integrations.ts";
import { fakeHub, json, waitFor, run, type View } from "./test-web.ts";

// Two website comment sources as two apps at 390px (web/js/30-monitoring-comments.js): each row opens its own comment view with only its site's posts. Headless
// Bun.WebView against a stub gateway that runs the real comment routes and the real app list on a temp data dir. Screenshots go to SITE_INSTANCE_SHOTS if set.
const SHOTS = process.env.SITE_INSTANCE_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const NOW = Date.now();
const data = mkdtempSync(join(tmpdir(), "site-inst-web-"));
const put = (rel: string, text: string) => { mkdirSync(join(data, rel, ".."), { recursive: true }); writeFileSync(join(data, rel), text); };
put("custom/apps.json", JSON.stringify({
	"site-mapia": { app: "site", label: "마피아", filter: { source: "mapia" } },
	"site-indi": { app: "site", label: "인디스쿨", filter: { source: "indi" } },
}));
const SITES: Record<string, { label: string; post: string; text: string }> = {
	"site-mapia": { label: "마피아", post: "마피아 규칙 질문", text: "첫 판은 몇 명부터 할 수 있나요?" },
	"site-indi": { label: "인디스쿨", post: "인디스쿨 수업 자료", text: "자료 파일은 어디서 받나요?" },
	"site-old": { label: "예전 사이트", post: "예전 글", text: "이 글은 아직 열려 있나요?" },
};
const dir = join(data, "custom", "comments");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: Object.fromEntries(Object.entries(SITES).map(([key, s]) => [key, { key, kind: "website", label: s.label, watch: ["*"], autoDraft: false }])) }));
const adapter: CommentAdapter = {
	kind: "website",
	list: async s => ({ comments: [{ native: `${s.key}-1`, thread: `p-${s.key}`, author: "방문자", text: SITES[s.key]!.text, postTitle: SITES[s.key]!.post, at: NOW - 60_000 } satisfies RawComment] }),
	reply: async () => ({ ok: true }),
	posts: async () => [],
};
const engine = createEngine({ dir, now: () => NOW, collector: "m", adapters: { website: adapter }, owner: src => commentOwner(appEntries(data), appOf(src), src.key) });
await engine.collect({ force: true });
const comments = createCommentsWeb({ engine, broadcast: () => {} });

const view = () => {
	const ctx = integrationContext(data, ["comments-site"]), items = integrationItems(ctx, [], {}, 100, undefined, [], NOW, engine.needs());
	return { items, available: integrationAvailable(items, ctx) };
};
const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/peers") return json([{ name: "맥북", url: `${hub.origin}`, self: true, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json([]);
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors" || p === "/api/conversations") return json({ items: [] });
		if (p === "/api/integrations") return json(view());
		if (p === "/api/app-templates") return json({ items: [] });
		const res = await comments.route(req, url, p.split("/").filter(Boolean));
		if (res) return res;
	},
});

afterAll(() => { hub.stop(); rmSync(data, { recursive: true, force: true }); });
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const shot = async (v: View, name: string) => { if (SHOTS) { await waitFor(v, `document.getAnimations().every(a => a.playState !== "running")`); await Bun.write(join(SHOTS, name), await v.screenshot()); } };
const rowOf = (key: string) => `[...document.querySelectorAll("#mon-side .cv-row")].find(r => r.dataset.k === ${JSON.stringify(key)})`;
const boot = async (): Promise<View> => {
	const v = await hub.view({ width: 390, height: 844 });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh && INTG.items.length`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await run(v, `go("monitoring")`);
	await waitFor(v, `PQ.loaded && ${rowOf("i:site-mapia")} && ${rowOf("i:site-indi")} && CM.apps.has("site-mapia")`);
	return v;
};
const threads = (v: View) => q<string[]>(v, `return [...document.querySelectorAll("#cm-rooms .kk-row .cv-n")].map(n => n.textContent)`);

describe("웹사이트 댓글 앱 인스턴스 at 390px", () => {
	test("the app list shows each site as its own app and the default site app for the rest", async () => {
		const v = await boot();
		const names = await q<string[]>(v, `return [...document.querySelectorAll("#mon-side .cv-row")].filter(r => /^i:site/.test(r.dataset.k)).map(r => r.dataset.k + "=" + r.querySelector(".cv-n").textContent)`);
		expect(names).toEqual(["i:site=웹사이트 댓글", "i:site-mapia=마피아", "i:site-indi=인디스쿨"]);
		await shot(v, "01-site-apps-list.png");
	}, 20_000);

	test("each site app opens its own comment view with only its posts", async () => {
		const v = await boot();
		await run(v, `go("monitoring", "i:site-mapia")`);
		await waitFor(v, `MON.sel === "i:site-mapia" && CM.app === "site-mapia" && document.querySelector("#cm-rooms .kk-row")`);
		expect(await threads(v)).toEqual(["마피아 규칙 질문"]);
		await run(v, `document.querySelector("#cm-rooms .kk-row").click()`);
		await waitFor(v, `document.querySelector("#cm-in .kk-m")`);
		expect(await q(v, `return document.querySelector("#cm-in").textContent.includes("첫 판은 몇 명부터")`)).toBe(true);
		await shot(v, "02-site-app-opened.png");
		await run(v, `go("monitoring", "i:site-indi")`);
		await waitFor(v, `CM.app === "site-indi" && document.querySelector("#cm-rooms .kk-row .cv-n").textContent === "인디스쿨 수업 자료"`);
		expect(await threads(v)).toEqual(["인디스쿨 수업 자료"]);
		await run(v, `go("monitoring", "i:site")`);
		await waitFor(v, `CM.app === "site" && document.querySelector("#cm-rooms .kk-row .cv-n").textContent === "예전 글"`);
		expect(await threads(v)).toEqual(["예전 글"]);
	}, 30_000);
});
