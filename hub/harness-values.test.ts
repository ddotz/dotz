// 구성 view facts are this install's values (owner 2026-10-21: "구성내에도 하드코딩된 항목들이 많은데 이런것도 다 변수처리로 수정해야함.
// 사용자별로 다르게"): the harness catalog holds wording only, every number comes in as a parameter from config.json or the
// module constant that uses it, and a feature that is off or absent on this install says so.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE } from "./config.ts";
import { harnessGraph } from "./harness.ts";
import { CATALOGS, msg } from "./i18n.ts";
import { loadGuardConfig } from "../extension/guard-config.ts";

// Leaves that may hold a digit, with why.
const ALLOWED = new Set([
	"settings.lanes.max_rss_gb.hint", // "set 0 to turn it off": zero is the off switch, not a value of this install
	"nodes.mail.summary", // "at ${hour}:00": the minutes of a clock time, the hour is injected
]);

// The text of a catalog leaf outside its ${...} placeholders (a function leaf: its source).
function literalText(v: unknown): string {
	// Function sources print non-ASCII as \xNN / \uNNNN escapes: decode them so "·" is not read as digits.
	const src = (typeof v === "function" ? v.toString() : String(v)).replace(/\\x([0-9a-f]{2})|\\u\{?([0-9a-f]{4,5})\}?/gi, (_, x, u) => String.fromCodePoint(parseInt(x ?? u, 16))).replace(/\bvoid 0\b/g, "undefined"); // the transpiler's undefined
	let out = "";
	for (let i = 0; i < src.length; i++) {
		if (src[i] === "$" && src[i + 1] === "{") {
			let depth = 0;
			for (i++; i < src.length; i++) {
				if (src[i] === "{") depth++;
				else if (src[i] === "}" && --depth === 0) break;
			}
			continue;
		}
		out += src[i];
	}
	return out;
}
function leaves(o: unknown, path: string[] = []): [string, unknown][] {
	if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => leaves(v, [...path, k]));
	return [[path.join("."), o]];
}

test("the 구성 catalog has no number of its own: every value is injected (en and ko)", () => {
	for (const [lang, c] of Object.entries(CATALOGS)) {
		const fixed = leaves(c.harness).filter(([p, v]) => !ALLOWED.has(p) && /\d/.test(literalText(v)));
		expect(fixed.map(([p, v]) => `${lang} ${p}: ${literalText(v).slice(0, 80)}`)).toEqual([]);
	}
});

const original = readFileSync(CONFIG_FILE, "utf8");
afterEach(() => writeFileSync(CONFIG_FILE, original));
const withConfig = async (patch: Record<string, unknown>) => {
	writeFileSync(CONFIG_FILE, JSON.stringify({ ...JSON.parse(original), ...patch }));
	const g = await harnessGraph({ light: true });
	const fact = (node: string, label: string) => g.nodes.find(n => n.id === node)!.facts.find(f => f.label === label)?.value;
	return { g, fact, node: (id: string) => g.nodes.find(n => n.id === id)! };
};

test("구성 facts follow this install's config: web access, mail off, merge window, guard limits", async () => {
	const N = msg().harness.nodes, c = msg().harness.common;
	const local = await withConfig({ web: { port: 7499 }, zele: { enabled: false }, gateway: { coalesce_ms: 1234 }, guard: { max_brief_chars: 5000, ask_before_expensive: true, expensive_models: ["pricey"] } });
	expect(local.fact("web", N.web.access)).toBe(N.web.accessValue(false, 0));
	expect(local.node("web").summary).toBe(N.web.summary(false));
	expect(local.node("mail").summary).toBe(c.disabled);
	expect(local.node("mail").status).toBe("off");
	expect(local.fact("gateway", N.gateway.merge)).toStartWith("1234ms");
	const g = loadGuardConfig();
	expect(g.max_brief_chars).toBe(5000);
	expect(local.fact("guard", N.guard.briefing)).toBe(N.guard.briefingValue(5000, g.max_fence_lines, g.worker_answer_chars));
	expect(local.fact("guard", N.guard.expensive)).toBe(N.guard.expensiveValue("pricey"));

	const tailnet = await withConfig({ web: { port: 7499, tailscale_https_port: 8443, allow_logins: ["a@github", "b@github"] }, guard: {} });
	expect(tailnet.fact("web", N.web.access)).toBe(N.web.accessValue(true, 2));
	expect(tailnet.fact("guard", N.guard.expensive)).toBe(N.guard.expensiveOff);
});
