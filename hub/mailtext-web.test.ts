import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { appAsset, indexPage } from "./webapp.ts";

// Plain-text mail (web/js/11-mailtext.js) in a headless browser: market-quote runs as a table, "label :text" bullets, the caption line. Set MT_SHOTS=<dir> to keep screenshots.
const SHOTS = process.env.MT_SHOTS ?? "";
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
		return url.pathname.startsWith("/api/") ? Response.json({}) : new Response("not found", { status: 404 });
	},
});
const views: InstanceType<typeof Bun.WebView>[] = [];
afterAll(() => {
	for (const v of views) v.close();
	server.stop(true);
});

const MAIL = [
	"[금리]",
	"- 샘플 지표 :안전선호 매수세가 거세게 유입된 가운데 일제히 하락했습니다. 주간 고용지표가 호조를 보인 가운데 원자재 가격은 급등했지만 약세 재료로 전혀 작용하지 않았습니다.",
	"2yr 4.6440% (-0.1660) (L: 4.6120 / H: 4.8120)",
	"5yr 4.7730% (+0.1800) (L: 4.7450 / H: 4.9510)",
	"10yr 4.9550% (-0.1670) (L: 4.9380 / H: 5.1190)",
	"- 주요국가 10년물 금리",
	"",
	"가나 3.3623% (-0.0693)",
	"다라 5.3380% (+0.0417)",
	"마바 2.0100%",
	"",
	"- 요약: 오늘 지표는 전반적으로 낮아졌고 변동 폭은 제한적이었습니다.",
].join("\n");

async function open(width: number) {
	const v = new Bun.WebView({ width, height: 900 });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/?light`);
	await v.evaluate(`new Promise(res => { const f = () => typeof mailTextNode === "function" ? res(true) : setTimeout(f, 20); f(); })`);
	await v.evaluate(`(() => {
		cancelAnimationFrame(monRaf); renderMonitoring = () => {};
		document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "stage", style: "max-width:560px;margin:0 auto;padding:12px" }));
		document.querySelector("#stage").append(mailTextNode(${JSON.stringify(MAIL)}));
		return true;
	})()`);
	return v;
}

for (const width of [390, 1440]) {
	test(`quote runs are tables and "label :text" bullets bold the label at ${width}px`, async () => {
		const v = await open(width);
		const got = JSON.parse(
			(await v.evaluate(`JSON.stringify((() => {
				const tbl = [...document.querySelectorAll("#stage table.mt-nt")];
				const rows = t => [...t.querySelectorAll("tbody tr")].map(r => [...r.children].map(c => ({ t: c.textContent, c: c.className })));
				return {
					n: tbl.length, cap: tbl.map(t => t.querySelector("caption")?.textContent ?? null), th: tbl.map(t => [...t.querySelectorAll("th")].map(c => c.textContent)),
					rows: tbl.map(rows), color: [...tbl[0].querySelectorAll("td.dn, td.up")].map(c => getComputedStyle(c).color),
					align: getComputedStyle(tbl[0].querySelector("td.num")).textAlign, tab: getComputedStyle(tbl[0].querySelector("td.num")).fontVariantNumeric,
					lb: [...document.querySelectorAll("#stage li .mt-lb")].map(b => [b.textContent, getComputedStyle(b).fontWeight, b.nextSibling.textContent + b.parentNode.textContent.slice(b.textContent.length, b.textContent.length + 6)]),
					over: document.documentElement.scrollWidth > innerWidth, plain: document.querySelector("#stage").innerText.includes("2yr 4.6440% (-0.1660)"),
				};
			})())`)) as string,
		) as { n: number; cap: (string | null)[]; th: string[][]; rows: { t: string; c: string }[][][]; color: string[]; align: string; tab: string; lb: string[][]; over: boolean; plain: boolean };
		expect(got.n).toBe(2);
		// a run with L/H: five columns (label | value | change | low | high), signed change classes
		expect(got.cap).toEqual([null, "주요국가 10년물 금리"]);
		expect(got.th[0]).toEqual(["", "", "", "L", "H"]);
		expect(got.rows[0].map(r => r.map(c => c.t))).toEqual([
			["2yr", "4.6440%", "-0.1660", "4.6120", "4.8120"],
			["5yr", "4.7730%", "+0.1800", "4.7450", "4.9510"],
			["10yr", "4.9550%", "-0.1670", "4.9380", "5.1190"],
		]);
		expect(got.rows[0].map(r => r[2].c)).toEqual(["num dn", "num up", "num dn"]);
		expect(new Set(got.color).size).toBe(2);
		expect(got.align).toBe("right");
		expect(got.tab).toContain("tabular-nums");
		// a mixed run keeps blank cells; no header when there is no L/H column
		expect(got.th[1]).toEqual([]);
		expect(got.rows[1].map(r => r.map(c => c.t))).toEqual([
			["가나", "3.3623%", "-0.0693"],
			["다라", "5.3380%", "+0.0417"],
			["마바", "2.0100%", ""],
		]);
		expect(got.rows[1].map(r => r[2].c)).toEqual(["num dn", "num up", "num"]);
		// "label :text" bullet: bold label, then the text
		expect(got.lb.map(l => [l[0], l[1]])).toEqual([["샘플 지표:", "600"], ["요약:", "600"]]);
		expect(got.plain).toBe(false);
		expect(got.over).toBe(false);
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await Bun.write(`${SHOTS}/mailtext-${width}.png`, await v.screenshot());
		}
	}, 30_000);
}

test("a 'label :text' bullet parses to label and text, the words kept", async () => {
	const v = await open(390);
	const ul = JSON.parse((await v.evaluate(`JSON.stringify(mtParse("- 지표 : 이 문장은 스무 자를 넘기는 긴 설명 문장입니다"))`)) as string) as { t: string; items: { k: string; v: string }[] }[];
	expect(ul[0].items[0]).toEqual({ k: "지표", v: "이 문장은 스무 자를 넘기는 긴 설명 문장입니다" });
}, 30_000);
