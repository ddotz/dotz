// In-message charts (hub/chart.ts): a ```chart fence becomes a Chart element, the gateway checks and draws it (SVG for the web, PNG for Discord),
// a spec it refuses stays readable as JSON with a note, and ztd-charts never loads on the gateway start path.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chartFiles, chartRoute, checkChart } from "./chart.ts";
import { deriveSpec } from "./message-spec-derive.ts";
import { specChildren } from "./message-spec.ts";

const BAR = JSON.stringify({ type: "bar", data: [{ x: "1월", y: 3 }, { x: "2월", y: 5 }] });
const fence = (body: string) => `매출이에요.\n\n\`\`\`chart\n${body}\n\`\`\``;
const post = (spec: unknown, width?: number) => chartRoute(new Request("http://x/api/chart", { method: "POST", body: JSON.stringify({ spec, width }) }));

test("a chart fence is a Chart element; text that is not a JSON object is a json code block with a note", () => {
	const ok = deriveSpec(fence(BAR))!;
	expect(specChildren(ok).map(e => e.type)).toEqual(["Text", "Chart"]);
	expect(specChildren(ok)[1]!.props).toEqual({ spec: BAR });
	const bad = deriveSpec(fence("{not json"))!;
	expect(specChildren(bad).map(e => e.type)).toEqual(["Text", "Code", "Meta"]);
	expect(specChildren(bad)[1]!.props).toEqual({ code: "{not json", lang: "json" });
});

test("a valid spec draws an svg in both themes; an invalid one or a remote data source gets a note instead", async () => {
	const ok = (await (await post(BAR)).json()) as { ok: boolean; light: string; dark: string };
	expect(ok.ok).toBe(true);
	expect(ok.light.startsWith("<svg")).toBe(true);
	expect(ok.dark.startsWith("<svg")).toBe(true);
	expect(ok.light).not.toBe(ok.dark);
	// drawn at the width the page shows it, in 40 px steps
	expect(((await (await post(BAR, 351)).json()) as { light: string }).light).toContain('width="360"');
	const bad = (await (await post(JSON.stringify({ type: "nope", data: [] }))).json()) as { ok: boolean; note: string };
	expect(bad.ok).toBe(false);
	expect(bad.note).toContain("type");
	expect(await checkChart(JSON.stringify({ type: "bar", data: { url: "http://127.0.0.1/x.json" } }))).toMatchObject({ ok: false });
});

// The app's tokens per theme, read from the shipped stylesheet (the first block is light, the second dark).
const tokens = (() => {
	const css = readFileSync(join(import.meta.dir, "..", "web", "css", "01-tokens.css"), "utf8");
	const all = (name: string) => [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "g"))].map(m => m[1]!);
	return (i: 0 | 1) => ({ accent: all("accent")[i]!, fg: all("fg")[i]!, fg3: all("fg-3")[i]!, card: all("card")[i]! });
})();

const contrast = (a: string, b: string) => {
	const lum = (h: string) => {
		const [r, g, bl] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
	};
	const [x, y] = [lum(a), lum(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test("a chart is drawn in the app's colors, and its card title is no larger than the app's block titles", async () => {
	const spec = JSON.stringify({ type: "bar", data: [{ x: "1월", y: 3 }, { x: "2월", y: 5 }], options: { highlight: "2월" }, card: { title: "월별 매출" } });
	const r = (await (await post(spec)).json()) as { light: string; dark: string };
	for (const [i, svg, ztd] of [[0, r.light, "#0B8FD8"], [1, r.dark, "#D6FD70"]] as const) {
		const t = tokens(i);
		expect(svg.toLowerCase()).toContain(t.accent);
		expect(svg.toUpperCase()).not.toContain(ztd);
		// the 목록 block title (.md .mlist-h): 600 13px in --fg-3
		const title = /<text [^>]*>월별 매출<\/text>/.exec(svg)?.[0] ?? "";
		expect(Number(/font-size="([\d.]+)"/.exec(title)?.[1])).toBeLessThanOrEqual(13);
		expect(title.toLowerCase()).toContain(`fill="${t.fg3}"`);
		// every label keeps the 4.5:1 ztd-charts guarantees, here on the app's card
		const fills = [...svg.matchAll(/<text [^>]*fill="(#[0-9a-fA-F]{6})"[^>]*>[^<]/g)].map(m => m[1]!);
		expect(fills.length).toBeGreaterThan(3);
		for (const f of fills) expect(contrast(f, t.card)).toBeGreaterThanOrEqual(4.5);
	}
});

test("Discord: a chart fence leaves the text as a PNG attachment; a refused spec stays as a json block with its note", async () => {
	const ok = await chartFiles({ text: fence(BAR), files: [] });
	expect(ok.text).toBe("매출이에요.");
	expect(ok.files).toHaveLength(1);
	expect([...readFileSync(ok.files[0]!).subarray(1, 4)].map(c => String.fromCharCode(c)).join("")).toBe("PNG");
	const bad = await chartFiles({ text: fence('{"type":"nope","data":[]}'), files: [] });
	expect(bad.files).toEqual([]);
	expect(bad.text).toContain('```json\n{"type":"nope","data":[]}\n```\n-# ');
});

// Static imports only: what the gateway loads when it starts. hub/chart.ts must be reachable and load ztd-charts and resvg by dynamic import alone.
test("the gateway start path reaches hub/chart.ts but never imports ztd-charts, resvg or react statically", () => {
	const seen = new Set<string>(), heavy: string[] = [];
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm)) {
			const spec = (m[1] ?? m[2])!;
			if (/^(ztd-charts|@resvg\/|react)/.test(spec)) heavy.push(`${file}: ${spec}`);
			if (spec.startsWith(".") && /\.ts$/.test(spec)) walk(resolve(dirname(file), spec));
		}
	};
	walk(join(import.meta.dir, "main.ts"));
	expect(seen.has(join(import.meta.dir, "chart.ts"))).toBe(true);
	expect(heavy).toEqual([]);
});
