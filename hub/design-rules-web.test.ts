import { afterAll, describe, expect, test } from "bun:test";
import { auditCss, auditText, parseCss, realCss } from "./design-rules.ts";
import { ev, fakeHub, idleState, run, waitFor, type View } from "./test-web.ts";

// The planted-rule checker tests and the rendered checks of web/DESIGN.md (accent count, tap size, type scale, contrast). The CSS source lints that read the real
// files run in `bun hub/check.ts` (hub/design-rules.ts); the checker itself is proven on planted violations below.

const hub = fakeHub({ state: idleState({ lanes: [{ name: "a", status: "working", goal: "x" }], notices_unread: 2 }) });
afterAll(() => hub.stop());

// Accent-filled controls showing on the current screen; the probe reads the token as the page resolves it.
const ACCENT_FILLS = `(() => {
	const probe = document.createElement("i"); probe.style.background = "var(--accent)"; document.body.append(probe);
	const accent = getComputedStyle(probe).backgroundColor; probe.remove();
	return [...document.querySelectorAll("body *")].filter(e => {
		const b = e.getBoundingClientRect(), s = getComputedStyle(e);
		return s.backgroundColor === accent && s.visibility === "visible" && b.width >= 24 && b.height > 0 && b.top < innerHeight;
	}).map(e => e.tagName + "." + (e.className || e.id));
})()`;
const SCREENS = ["home", "chat", "projects", "monitoring", "settings"];
const painted = (v: View) => v.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => 0)`);
async function openPage(): Promise<View> {
	const v = await hub.view({ width: 390, height: 844 }, "/");
	await waitFor(v, `!!document.querySelector("#nav .ni")`);
	return v;
}
// Visible app bar icon buttons and the size of the area that answers a tap on them: elementFromPoint walked out from the center along both axes.
const APPBAR_HITS = `[...document.querySelectorAll(".appbar .ib")].filter(e => e.getBoundingClientRect().width > 0).map(e => {
	const b = e.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
	const reach = (dx, dy) => { let n = 0; while (n < 30 && e.contains(document.elementFromPoint(cx + dx * (n + 1), cy + dy * (n + 1)))) n++; return n; };
	return [e.id || e.className, reach(-1, 0) + reach(1, 0) + 1, reach(0, -1) + reach(0, 1) + 1];
})`;
async function auditAccent(v: View, screen: string): Promise<string[]> {
	await painted(v);
	const fills = await ev<string[]>(v, ACCENT_FILLS);
	return fills.length > 1 ? [`accent: ${screen} fills ${fills.length} controls: ${fills.join(", ")}`] : [];
}

describe("web/DESIGN.md rules", () => {
	test("each main screen fills at most one control with the accent", async () => {
		const v = await openPage();
		const found: string[] = [];
		for (const screen of SCREENS) {
			await run(v, `go(${JSON.stringify(screen)})`);
			await waitFor(v, `!document.querySelector("#v-${screen}").hidden`);
			found.push(...await auditAccent(v, screen));
		}
		expect(found).toEqual([]);
	});

	test("app bar icon buttons answer a tap over 44px on a phone", async () => {
		const v = await openPage();
		const hits: [string, number, number][] = [];
		for (const screen of SCREENS) {
			await run(v, `go(${JSON.stringify(screen)})`);
			await waitFor(v, `!document.querySelector("#v-${screen}").hidden`);
			await painted(v);
			hits.push(...await ev<[string, number, number][]>(v, APPBAR_HITS));
		}
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.filter(([, w, h]) => w < 44 || h < 44).map(([id, w, h]) => `${id} ${w}x${h}`)).toEqual([]);
	});

	test("the bell count, a chat title and a dialog title draw on the Type scale", async () => {
		const v = await openPage();
		await run(v, `go("chat", "main")`);
		await waitFor(v, `document.querySelector("#appbar.cvconv") && CV.placed`);
		await run(v, `const n = document.querySelector("#bell-n"); n.hidden = false; n.textContent = "3"`);
		await painted(v);
		const sizes = await ev<Record<string, number>>(v, `(() => {
			const dt = document.createElement("h2"); dt.className = "dtitle"; dt.textContent = "제목"; document.body.append(dt);
			const px = e => parseFloat(getComputedStyle(e).fontSize);
			const out = { "#bell-n": px(document.querySelector("#bell-n")), "#title": px(document.querySelector("#title")), ".dtitle": px(dt) };
			dt.remove();
			return out;
		})()`);
		// DESIGN.md Type: 11 to 16 for tags, meta, rows and card titles, 20 to 22 for page and sheet titles
		const off = Object.entries(sizes).filter(([, px]) => !(px >= 11 && px <= 16 || px >= 20 && px <= 22)).map(([el, px]) => `${el} ${px}px`);
		expect(off).toEqual([]);
	});

	test("the source line, reply name, initials, step numbers and model picker keep a line height of 1.3 or more", async () => {
		const v = await openPage();
		const ratios = await ev<Record<string, number>>(v, `(() => {
			const host = document.createElement("div");
			host.id = "models";
			host.innerHTML = '<div class="rc-hd"><span class="rc-src">a</span></div><div class="rq-hd rq-who"><span class="rq-meta"><b class="rq-wt">a</b></span></div><span class="kk-av">지</span><span class="hm-no">1</span><div class="fb-item"><span class="fb-n">1</span></div><div class="col mt"><div class="mt-top"><div class="mt-filter"><div class="tf"><button class="sel"><span class="val">a</span></button></div></div></div></div>';
			document.body.append(host);
			const ratio = s => { const c = getComputedStyle(host.querySelector(s)); return parseFloat(c.lineHeight) / parseFloat(c.fontSize); };
			const out = Object.fromEntries([".rc-src", ".rq-wt", ".kk-av", ".hm-no", ".fb-n", ".sel .val"].map(s => [s, Math.round(ratio(s) * 100) / 100]));
			host.remove();
			return out;
		})()`);
		// docs/ui-spec.md: line height at least 1.3 times the text size (DESIGN.md Type pairs, e.g. 13/18, 12/16)
		expect(Object.entries(ratios).filter(([, r]) => !(r >= 1.3)).map(([s, r]) => `${s} ${r}`)).toEqual([]);
	});

	test("the usage card keeps its title as the one bold text, the limit values stay lighter", async () => {
		const v = await openPage();
		const bold = await ev<string[]>(v, `(() => {
			const host = document.createElement("div");
			host.id = "usage";
			const lim = '<div class="lim"><div class="kv"><span class="k">a</span><b>64% 남음</b></div></div>';
			host.innerHTML = '<div class="card"><div class="ch"><h3>Claude 구독</h3></div>' + lim + lim + '</div>';
			document.body.append(host);
			const out = [...host.querySelectorAll("h3, b")].filter(e => parseInt(getComputedStyle(e).fontWeight) >= 600).map(e => e.tagName.toLowerCase());
			host.remove();
			return out;
		})()`);
		// docs/ui-principles.md 1 and docs/ui-spec.md 카드: one bold text in a card
		expect(bold).toEqual(["h3"]);
	});

	test("the open mail's top bar shares the corners of the card it sits flush in", async () => {
		const v = await openPage();
		const radii = await ev<string[]>(v, `(() => {
			const host = document.createElement("div");
			host.className = "tl-in";
			host.innerHTML = '<div class="bm alert rc mopen"><div class="mtop"></div></div>';
			document.body.append(host);
			const top = e => ["borderTopLeftRadius", "borderTopRightRadius"].map(k => getComputedStyle(e)[k]);
			const out = [top(host.querySelector(".bm")), top(host.querySelector(".mtop"))].map(a => a.join(" "));
			host.remove();
			return out;
		})()`);
		// docs/ui-spec.md: the outer corner is the inner corner plus the gap, and a flush bar has no gap
		expect(radii[1]).toBe(radii[0]);
	});

	test("text pairs of the tokens reach 4.5:1 in both themes", () => {
		const rules = parseCss("01-tokens.css", realCss().find(([f]) => f === "01-tokens.css")![1]);
		const theme = (scope: string) => {
			const out = new Map<string, string>();
			for (const r of rules) if (r.selector === scope) for (const [k, v] of r.decls) out.set(k, v);
			return (name: string) => out.get(`--${name}`)!;
		};
		const rgb = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
		const lum = (c: string) => { const [r, g, b] = rgb(c).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
		const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
		const tint = (c: string, over: string, pct: number) => "#" + rgb(c).map((v, i) => Math.round(v * pct + rgb(over)[i]! * (1 - pct)).toString(16).padStart(2, "0")).join("");
		const low: string[] = [];
		const check = (what: string, fg: string, bg: string) => { const n = ratio(fg, bg); if (n < 4.5) low.push(`${what} ${fg}/${bg} ${n.toFixed(2)}`); };
		const warnTag = parseCss("02-cards-lists-tags.css", realCss().find(([f]) => f === "02-cards-lists-tags.css")![1]).find(r => r.selector === ".tag.warn")!;
		const warnInk = /var\(--([\w-]+)\)/.exec(warnTag.decls.find(([k]) => k === "color")![1])![1]!;
		for (const [name, t] of [["light", theme(":root")], ["dark", theme(':root[data-theme="dark"]')]] as const) {
			for (const s of ["bg", "layer", "row-sel", "hover"]) check(`${name} fg-3 on ${s}`, t("fg-3"), t(s));
			check(`${name} warn on bg`, t("warn"), t("bg"));
			// the .tag.warn word sits right on whichever surface holds its row, hovered or selected too (web/DESIGN.md 상태·필터·화면 탭): its text token has to clear 4.5 on every one
			for (const s of ["bg", "layer", "card", "card-hover", "hover", "row-sel"]) check(`${name} .tag.warn text on ${s}`, t(warnInk), t(s));
			check(`${name} bg on warn`, t("bg"), t("warn"));
			if (name === "dark") check(`${name} on-accent on accent`, t("on-accent"), t("accent")); // the light blue button (white on #3182f6, 3.7) is the brand blue and stays
			check(`${name} on-err on err`, t("on-err"), t("err"));
		}
		const dark = theme(':root[data-theme="dark"]');
		for (const s of ["layer", "row-sel"]) for (const pct of [0.12, 0.14]) check(`dark accent on a ${Math.round(pct * 100)}% accent tint over ${s}`, dark("accent"), tint(dark("accent"), dark(s), pct));
		expect(low).toEqual([]);
		const fill = parseCss("01-tokens.css", realCss().find(([f]) => f === "01-tokens.css")![1]).find(r => r.selector === ".btn.danger.fill")!;
		expect(fill.decls.find(([k]) => k === "color")?.[1]).toBe("var(--on-err)");
	});

	const planted: [string, string, string][] = [
		["stripe", "colored one-sided border", `.planted { border-left: 3px solid var(--accent); border-radius: var(--r-card); }`],
		["stripe", "colored inset edge", `.planted { box-shadow: inset 3px 0 0 var(--warn); }`],
		["stripe", "full-height bar", `.planted::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 3px; background: var(--ok); }`],
		["status", "status color on a plain surface", `.planted { background: color-mix(in srgb, var(--ok) 14%, var(--card)); }`],
		["color", "literal hue", `.planted { color: #3182f6; }`],
		["color", "literal in a token fallback", `.planted { color: var(--warn, #d9822b); }`],
		["duration", "literal time", `.planted { transition: opacity 200ms var(--m-ease); }`],
		["size", "new px font-size", `.planted { font-size: 13px; }`],
		["size", "new px radius", `.planted { border-radius: 12px; }`],
		["space", "off-scale px", `.planted { padding: 10px; }`],
		["space", "raw px on the scale", `.planted { margin-top: 8px; }`],
		["space", "off-scale px inside calc", `.planted { padding-bottom: calc(var(--sp-2) + 10px); }`],
		["space", "bare 1px with no nudge", `.planted { gap: 1px; }`],
		["space", "logical padding", `.planted { padding-inline: 0 14px; }`],
		["space", "nudge without a reason", `.planted { margin-top: 1px; /* nudge: */ }`],
		["space", "4th nudge", `.planted { margin-top: 1px; /* nudge: a */ } .p2 { margin-top: 1px; /* nudge: b */ } .p3 { margin-top: 1px; /* nudge: c */ } .p4 { margin-top: 1px; /* nudge: d */ }`],
	];
	test.each(planted)("a planted %s fails: %s", (rule, _name, css) => {
		const found = auditCss([["planted.css", css]]);
		expect(found.some(f => f.startsWith(`${rule}: `))).toBe(true);
	});

	test.each([["space", `box.style.cssText = "margin-top:4px";`], ["space", `box.style.cssText = "padding:10px";`], ["select", `const s = el("select", { class: "fi" });`]])("a planted %s in a script fails: %s", (rule, js) => {
		expect(auditText([["planted.js", js]]).some(f => f.startsWith(`${rule}: `))).toBe(true);
	});

	test("off-scale and raw px are counted apart", () => {
		expect(auditCss([["planted.css", `.p { padding: 10px 4px; margin: calc(100% - 14px); }`]])).toEqual(["space: planted.css has 2 off-scale and 1 raw px spacing values; use --sp-*"]);
		expect(auditText([["planted.js", `a.style.cssText = "margin-top:4px"; b.innerHTML = '<i style="padding:10px;gap:2px">';`]])).toEqual(["space: planted.js has 1 off-scale and 2 raw px spacing values; use --sp-*"]);
	});

	test("a fourth nudge in one file fails, three do not", () => {
		const nudged = (n: number) => Array.from({ length: n }, (_, i) => `.n${i} { margin-top: 1px; /* nudge: line ${i} */ }`).join("\n");
		expect(auditCss([["planted.css", nudged(3)]])).toEqual([]);
		expect(auditCss([["planted.css", nudged(4)]])).toEqual(["space: planted.css has 4 nudges, allowed 3; use --sp-*"]);
	});

	test("the mail iframe stylesheet is exempt, other lines of that file are not", () => {
		const mb = `const MB_CSS = "body{padding:14px 16px}";`;
		expect(auditText([["11-mailbody.js", mb]])).toEqual([]);
		expect(auditText([["11-mailbody.js", `${mb}\nconst x = "padding:14px";`]])).toEqual([expect.stringContaining("1 off-scale")]);
	});

	test.each([["emoji", `el("span", { text: "🔥 끝났어요" })`], ["emoji", `el("span", { text: "⚠️ 확인" })`], ["color", `box.style.color = "#ff0000";`], ["status", `box.style.color = "var(--err)";`]])("a planted %s in a script fails: %s", (rule, js) => {
		expect(auditText([["planted.js", js]]).some(f => f.startsWith(`${rule}: `))).toBe(true);
	});

	test("planted extra accent buttons fail", async () => {
		const v = await openPage();
		await run(v, `go("chat")`);
		await waitFor(v, `!document.querySelector("#v-chat").hidden`);
		await run(v, `for (const n of [1, 2]) { const b = document.createElement("button"); b.className = "btn"; b.textContent = "또 있어요"; $("#v-chat").prepend(b); }`);
		const found = await auditAccent(v, "chat");
		expect(found.length).toBe(1);
		expect(found[0]).toContain("accent: chat fills");
	});

	test("allowed forms stay quiet", () => {
		const fine = `.tag.ok { color: var(--ok); } .card.att { background: color-mix(in srgb, var(--warn) 8%, var(--card)); }
			.chev::after { border-right: 1.5px solid var(--fg-3); } .quote { border-left: 2px solid var(--line); } .sep { box-shadow: inset 0 1px 0 var(--line); }
			.scrim { background: rgb(0 0 0 / .55); color: #fff; } .bar { border-radius: 2px; font-size: .9em; transition: opacity var(--m-fast) var(--m-ease), visibility 0s; }
			.sp { padding: 0 var(--sp-2); margin: 0 auto; gap: .5em; --pad: 5px; padding-bottom: calc(var(--sp-2) + env(safe-area-inset-bottom)); margin-left: calc(var(--sp-1) - 2%); }
			.nd { margin-top: 1px; /* nudge: 1px line compensation */ } .kf { padding: 0 var(--sp-1, 10px); } @keyframes k { from { padding: 3px; } }`;
		expect(auditCss([["fine.css", fine]])).toEqual([]);
		expect(auditText([["fine.js", `$("#add").click(); el("span", { text: "▶ 보기" }); box.style.cssText = "margin-top:var(--sp-1);padding:0 .5em;gap:0";`]])).toEqual([]);
	});
});
