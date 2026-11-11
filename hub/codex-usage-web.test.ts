import { afterAll, beforeEach, expect, test } from "bun:test";
import { fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

// 사용량 → the Codex card's 리셋권 row in a headless Bun.WebView against a fake hub: the count and expiry are drawn, 사용 is off with none
// held or no limit reached, and POST /api/quota/reset-credit goes out only from the confirm step's 리셋권 쓰기, never from 사용 or 취소.
const ACCOUNT = "me@example.com";
const EXPIRES = Date.parse("2030-01-15T00:00:00Z");
let resets = { held: 2, usable: true, expires_at: EXPIRES as number | null };
type KindRow = { kind: string; left: number; expires_at: number | null; usable: boolean; grant_id?: string };
let claude: { held: number; usable: boolean; expires_at: number | null; kinds: KindRow[]; grant?: { id: string; kind: string } } | undefined;
const quota = () => ({
	fetched_at: Date.now(),
	providers: [
		{ provider: "anthropic", account: ACCOUNT, plan: "Max 5x", resets: claude, limits: [{ id: "5h", label: "Claude 5 Hour", window: "5h", used: 30, limit: 100, remaining: 70, unit: "percent", resets_at: null, status: "ok" }] },
		{
			provider: "codex", name: "Codex", account: ACCOUNT, plan: "Plus", resets,
			limits: [
				{ id: "codex:5h", label: "5시간 한도", window: "5h", used: 100, limit: 100, remaining: 0, unit: "percent", resets_at: null, status: "exhausted" },
				{ id: "codex:7d", label: "7일 한도", window: "7d", used: 64, limit: 100, remaining: 36, unit: "percent", resets_at: null, status: "ok" },
			],
		},
	],
	unavailable: [],
});
const posts = inbox<unknown>();
const quotaReads = inbox<string>();
let refusal: { error: string; outcome: string; left: number } | undefined;
const hub = fakeHub({
	api: async (req, url) => {
		if (url.pathname === "/api/quota" && req.method === "GET") {
			quotaReads.push(url.search);
			return json(quota());
		}
		if (url.pathname === "/api/quota/reset-credit" && req.method === "POST") {
			posts.push(await req.json());
			if (refusal) return json(refusal, 409);
			resets = { ...resets, held: resets.held - 1, usable: false };
			return json({ ok: true, outcome: "reset", left: resets.held });
		}
	},
});
afterAll(() => hub.stop());

let v: View;
const q = async <T = unknown>(code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const row = () => q<{ count: string; sub: string; off: boolean } | null>(`const r = document.querySelector("#usage .lim.rc"); return r && { count: r.querySelector("b").textContent, sub: r.querySelector(".sup")?.textContent ?? "", off: r.querySelector("button").disabled };`);
async function open(r: typeof resets) {
	resets = r;
	posts.length = 0;
	v ??= await hub.view({ width: 390, height: 844 });
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/#usage`);
	await opened;
	await waitFor(v, `typeof go === "function" && typeof S !== "undefined" && S`);
	await run(v, `go("usage")`);
	await waitFor(v, `document.querySelector("#usage .lim.rc")`, 5000);
}
beforeEach(() => void (posts.length = 0));

test("the Codex card draws how many 리셋권 it holds and when the nearest one expires", async () => {
	await open({ held: 2, usable: true, expires_at: EXPIRES });
	const r = await row();
	expect(r).toMatchObject({ count: "2개", off: false });
	expect(r?.sub).toContain("만료");
	// one date shape on the screen: the read time in the bar is not the dotted "11. 9. 오전 07:00" shape beside the expiry's "11월 26일 (목)"
	expect(await q<string>(`return document.querySelector("#usage .card .ch .sup").textContent`)).not.toMatch(/\d+\. \d+\./);
	expect(await q(`return document.querySelector("#usage .lim.rc").closest(".card").querySelector("h3").textContent`)).toBe("Codex · Plus");
	// the one 새로고침 rides in the first card's head: no bar of its own above the cards
	expect(await q(`return { bar: !!document.querySelector("#usage .tools-bar"), inFirstHead: !!document.querySelector("#usage .grid > .card:first-child > .ch > .btn.inrow") }`)).toEqual({ bar: false, inFirstHead: true });
});

test("사용 is off with none held, and with some held but no limit reached", async () => {
	await open({ held: 0, usable: false, expires_at: null });
	expect(await row()).toEqual({ count: "0개", sub: "", off: true });
	await open({ held: 2, usable: false, expires_at: EXPIRES });
	const r = await row();
	expect(r?.off).toBe(true);
	expect(r?.sub).toContain("한도에 걸리면 쓸 수 있어요");
	expect(posts.length).toBe(0);
});

test("사용 only opens the confirm step; 취소 sends nothing, 리셋권 쓰기 sends one confirmed use and the row reads again", async () => {
	await open({ held: 2, usable: true, expires_at: EXPIRES });
	await run(v, `document.querySelector("#usage .lim.rc button").click()`);
	await waitFor(v, `document.querySelector("dialog.cf")`);
	const dlg = await q<{ title: string; body: string }>(`const d = document.querySelector("dialog.cf"); return { title: d.querySelector(".dtitle").textContent, body: d.querySelector(".dbody").textContent };`);
	expect(dlg.title).toBe("리셋권을 쓸까요?");
	expect(dlg.body).toContain("5시간 한도와 7일 한도");
	expect(dlg.body).toContain("1개 남아요");
	expect(posts.length).toBe(0);
	await run(v, `[...document.querySelectorAll("dialog.cf .dact button")].find(b => b.textContent === "취소").click()`);
	await waitFor(v, `!document.querySelector("dialog.cf")`);
	expect(posts.length).toBe(0);

	await run(v, `document.querySelector("#usage .lim.rc button").click()`);
	await waitFor(v, `document.querySelector("dialog.cf")`);
	await run(v, `[...document.querySelectorAll("dialog.cf .dact button")].find(b => b.textContent === "리셋권 쓰기").click()`);
	await posts.until(p => p.length === 1, 5000, "one reset-credit POST");
	expect(posts).toEqual([{ account: ACCOUNT, confirm: true }]);
	await waitFor(v, `document.querySelector("#usage .lim.rc b")?.textContent === "1개"`);
	expect((await row())?.off).toBe(true);
	expect(posts.length).toBe(1);
});

const KINDS: KindRow[] = [
	{ kind: "주간", left: 1, expires_at: EXPIRES, usable: true, grant_id: "weekly-1" },
	{ kind: "Fable", left: 3, expires_at: EXPIRES + 86_400_000, usable: true, grant_id: "fable-1" },
];
const claudeRows = () => q<{ label: string; count: string; off: boolean }[]>(`return [...document.querySelectorAll("#usage .card:first-child .lim.rc")].map(r => ({ label: r.querySelector(".k").textContent, count: r.querySelector("b").textContent, off: r.querySelector("button").disabled }));`);
const useKind = async (label: string) => {
	await run(v, `[...document.querySelectorAll("#usage .card:first-child .lim.rc")].find(r => r.querySelector(".k").textContent.startsWith(${JSON.stringify(label)})).querySelector("button").click()`);
	await waitFor(v, `document.querySelector("dialog.cf")`);
	await run(v, `[...document.querySelectorAll("dialog.cf .dact button")].find(b => b.textContent === "리셋권 쓰기").click()`);
};

test("a Claude card draws one 리셋권 row per kind, and each 사용 sends its own grant", async () => {
	claude = { held: 4, usable: true, expires_at: EXPIRES, kinds: KINDS, grant: { id: "weekly-1", kind: "주간" } };
	await open({ held: 2, usable: true, expires_at: EXPIRES });
	const rows = await claudeRows();
	expect(rows.map(r => r.count)).toEqual(["1개", "3개"]);
	expect(rows.map(r => r.off)).toEqual([false, false]);
	await useKind("Fable");
	await posts.until(p => p.length === 1, 5000, "Fable POST");
	await waitFor(v, `!document.querySelector("dialog.cf")`);
	await useKind("주간");
	await posts.until(p => p.length === 2, 5000, "weekly POST");
	expect(posts).toEqual([
		{ provider: "anthropic", account: ACCOUNT, grant_id: "fable-1", confirm: true },
		{ provider: "anthropic", account: ACCOUNT, grant_id: "weekly-1", confirm: true },
	]);
});

test("a kind that is not usable has its 사용 off while the other stays on", async () => {
	claude = { held: 4, usable: true, expires_at: EXPIRES, kinds: [{ ...KINDS[0]!, usable: false, grant_id: undefined }, KINDS[1]!], grant: { id: "fable-1", kind: "Fable" } };
	await open({ held: 2, usable: true, expires_at: EXPIRES });
	expect((await claudeRows()).map(r => r.off)).toEqual([true, false]);
	claude = undefined;
});

test("a refused Claude 리셋권 shows the refusal in a toast that fits a 390px phone, and the usage is read again", async () => {
	claude = { held: 4, usable: true, expires_at: EXPIRES, kinds: KINDS, grant: { id: "weekly-1", kind: "주간" } };
	refusal = { error: "리셋이 적용되지 않았고, 리셋권도 쓰지 않았어요 (이 접속 방식으로는 쓸 수 없다고 해요)", outcome: "ineligible", left: 4 };
	await open({ held: 2, usable: true, expires_at: EXPIRES });
	quotaReads.length = 0;
	await useKind("Fable");
	await posts.until(p => p.length === 1, 5000, "refused POST");
	await waitFor(v, `document.querySelector(".snack.bad")`);
	const snack = await q<{ text: string; left: number; right: number; width: number; scroll: number; client: number }>(`const n = document.querySelector(".snack"), r = n.getBoundingClientRect(); return { text: n.textContent, left: r.left, right: r.right, width: innerWidth, scroll: n.scrollWidth, client: n.clientWidth };`);
	expect(snack.text).toBe(refusal.error);
	expect(snack.left).toBeGreaterThanOrEqual(0);
	expect(snack.right).toBeLessThanOrEqual(snack.width);
	expect(snack.scroll).toBeLessThanOrEqual(snack.client);
	await waitFor(v, `document.querySelector("#usage .lim.rc")`);
	await quotaReads.until(r => r.includes("?fresh=1"), 5000, "the usage read again after the refusal");
	expect((await claudeRows()).map(r => r.count)).toEqual(["1개", "3개"]);
	refusal = undefined;
	claude = undefined;
});
