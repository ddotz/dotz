import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, idleState, run, waitFor, type View } from "./test-web.ts";

// web/DESIGN.md rules that only eyes used to check, measured on the real web/ CSS and JS. Everything is a static read except one accent per
// screen, which depends on what a screen draws and so is counted in the headless page. audit() is the same path for the real files and for the
// planted cases at the bottom, so a planted violation proves the check can fail.
//
// Checked:
// - stripe: a one-sided border of 2px+, a one-sided inset shadow, or a full-height pseudo bar of 4px or less, in an accent or status color or a
//   literal hue. Stricter than "on rounded surfaces": the radius usually sits in another rule, and DESIGN.md wants selection as a fill anyway.
// - status: --ok / --warn / --err only under a selector that names a state, never in a script.
// - color: no literal color outside the :root tokens. Pure black and white are exempt: scrims, masks and knobs on photos have no token.
// - duration: no literal transition or animation time (--m-fast / --m-base / --m-slow).
// - size: no new px font-size (--fs-*) or px radius above 4px (--r-*; the smallest token is 6px, so a thin bar has none to use).
// - emoji: no emoji-presentation character in web/js, web/css or index.html.
// - space: every px length in padding*, margin*, gap, row-gap and column-gap (var() contents removed, calc() included) is a token: 0 is fine, a px
//   literal off the scale (2 4 6 8 12 16 20 24 32 40 48) is off-scale, an on-scale px literal is raw (--sp-*). A declaration followed by
//   /* nudge: <reason> */ is excused (1px line compensation, optical nudge), at most 3 per file. The same px in strings of
//   web/js, custom.js and index.html (inline style, CSS text) is counted too; the mail iframe CSS (const MB_CSS in 11-mailbody.js) is its own document and is exempt.
// - select: no native <select> in web/js, custom.js or index.html; every choice list is selectButton() in 03-menu.js.
// - accent: at most one accent-filled control (24px or wider, so a status dot does not count) on each main screen of a fixture page.
//
// Not checked, because a reading would not be reliable:
// - Whether a state-named class sits on the right element, or a tint is too large: that is about the rendered screen, not the rule text.
// - A second accent used through an allowed token (--accent on text, a heading tick): "sparing" needs eyes; only filled controls are counted.
// - Accent count in fixture states this page does not draw (decision cards, sheets, full settings pages).
// - Whether a spacing step is the right one for its job (DESIGN.md Shape and space): only the scale is read. em, %, vw and auto lengths, scroll-margin,
//   and a px value built in a script (`${n}px`, camelCase style keys) are not counted.
// - font-size in em (relative on purpose), named CSS colors, currentColor stripes, CSS inside JS strings (custom.js, the mail iframe),
//   and 3-digit hex in JS, which cannot be told from an id selector such as "#add".
// - A horizontal accent underline: the selected nav tab uses one on a square surface; bare ⚠ or ▶ without the emoji selector render as text.

// Existing violations, so only new ones fail. A fix removes the entry; never add one to get a new rule past this test.
// Selectors under a status color that name no state word; most are real status text, kept because a rename would touch markup.
const STATUS_ALLOWED = new Set([
	".ds-ey", ".ds-rl", "#tl > [data-ts] > .al-x:hover", ".upd-block", ".fc-card .dup, .hs-ft .dup", ".mon-banner", ".mon-banner .ic", ".mon-banner-tx b",
	".lg-e::before", ".lr.er .lb", ".mb-txt .mt-nt .up", ".mr-todo b", ".dr-none .ic", ".as-why", ".ended .erow .edel:hover", ".pausenote", ".cchip.capi",
	".ni .nnb", ".conn", "#bell-n", ".pl-nb", ".md .mlist-b", ".cv-task .ct-bar span",
	".hneeds .hn-h .sup", ".oerr", ".au .ferr",
]);
// Literal colors a fix would visibly change, as `file selector`: the ulw keyword rainbow, the raised dark toast and hint, the lightbox backdrops, and
// the KakaoTalk look (a per-person avatar hue, its unread yellow, the video placeholder).
const COLOR_ALLOWED = new Set([
	"03-base.css .sendrow.ulw", "03-base.css .ta-hl .ulw-kw", '03-base.css :root[data-theme="dark"] .ntf', '03-base.css :root[data-theme="dark"] .ntf:hover',
	'04-files.css :root[data-theme="dark"] .hintrow', "04-files.css dialog.lbox::backdrop", "04-files.css dialog.tbox::backdrop",
	"17-kakao.css .kk-av", '17-kakao.css :root[data-theme="dark"] .kk-av', "17-kakao.css .kk-chat", '17-kakao.css :root[data-theme="dark"] .kk-chat', "17-kakao.css .kk-video",
]);
// Literal times with no token to match: delays that wait for a close.
const DURATION_ALLOWED = new Set([
	"15-draft-original.css .od-orig[inert]",
	"15-draft-original.css .od-cwrap .od-orig[inert]", "15-draft-original.css .od-draftcol[inert], .od-cwrap .kk-draft[inert]",
]);
// [px font-sizes, px radii] per file: a ceiling, too many entries to name one by one.
const SIZE_ALLOWED: Record<string, [number, number]> = {
	"01-tokens.css": [11, 4], "02-cards-lists-tags.css": [12, 3], "03-base.css": [32, 16], "04-files.css": [59, 25],
	"05-log.css": [36, 18], "06-harness.css": [22, 3], "07-chat.css": [23, 5], "08-project-sessions.css": [6, 0],
	"09-notices.css": [5, 1], "10-conversations.css": [8, 4], "11-peers.css": [0, 4], "13-code-shell.css": [2, 6],
	"14-overlay.css": [1, 0], "15-draft-original.css": [2, 5], "15-reply-card.css": [3, 0], "15-reply.css": [2, 2],
	"15-settings-pages.css": [2, 1], "15-settings-phone.css": [0, 1], "16-result-card.css": [67, 7],
	"17-kakao.css": [8, 9], "18-app-settings.css": [2, 1], "18-comments.css": [3, 1], "19-volume.css": [10, 0],
	"20-apps.css": [4, 0], "20-mail-box.css": [25, 14], "20-mail-thread.css": [7, 4], "20-monitoring.css": [7, 2],
	"20-projects.css": [4, 2], "21-picker.css": [1, 3], "22-shell.css": [7, 3],
};
const SPACE_NUDGES = 3;
// Lines of a script that are another document's CSS, not the app's: the mail iframe stylesheet.
const SPACE_JS_EXEMPT: Record<string, RegExp> = { "11-mailbody.js": /^const MB_CSS\b/ };
// Lines with a color literal: the mail iframe is its own white document, the terminal carries the ANSI palette.
const JS_COLOR_ALLOWED: Record<string, number> = { "11-mailbody.js": 1, "36-shell.js": 3 };

type Rule = { file: string; selector: string; decls: [prop: string, value: string, nudge?: string][] };
type Source = [file: string, text: string];

// Rules of a stylesheet. The selector of a rule inside @media is the inner one; comments and quoted text (data: URLs) never split a rule.
// A `/* nudge: reason */` comment becomes a marker (\u0001 + index) after the declaration it follows, which endDecl turns into that declaration's third
// element instead of a declaration of its own, so no other rule ever sees it.
function parseCss(file: string, text: string): Rule[] {
	const reasons: string[] = [];
	const src = text.replace(/\/\*\s*nudge:([\s\S]*?)\*\//g, (_, why: string) => (why.trim() ? `;\u0001${reasons.push(why.trim()) - 1};` : "")).replace(/\/\*[\s\S]*?\*\//g, "");
	const rules: Rule[] = [];
	const open: string[] = [];
	let decls: Rule["decls"] = [];
	let buf = "", quote = "", parens = 0;
	const endDecl = () => {
		const mark = buf.trim().match(/^\u0001(\d+)$/);
		if (mark) { const last = decls.at(-1); if (last) last[2] = reasons[+mark[1]]; buf = ""; return; }
		const at = buf.indexOf(":");
		if (at >= 0) decls.push([buf.slice(0, at).trim().toLowerCase(), buf.slice(at + 1).trim()]);
		buf = "";
	};
	for (const c of src) {
		if (quote) { if (c === quote) quote = ""; buf += c; }
		else if (c === '"' || c === "'") { quote = c; buf += c; }
		else if (c === "(" || c === ")") { parens += c === "(" ? 1 : -1; buf += c; }
		else if (parens) buf += c;
		else if (c === ";") endDecl();
		else if (c === "{") { open.push(buf.trim().replace(/\s+/g, " ")); buf = ""; decls = []; }
		else if (c === "}") {
			endDecl();
			if (decls.length) rules.push({ file, selector: open.at(-1) ?? "", decls });
			open.pop();
			decls = [];
		}
		else buf += c;
	}
	return rules;
}

const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\([^)]*\)/gi;
const isBlackOrWhite = (c: string) => /^#(0{3,4}|f{3,4}|0{6}|f{6}|0{8}|f{8})$/i.test(c) || /^rgba?\(\s*(0[\s,]+0[\s,]+0|255[\s,]+255[\s,]+255)\b/i.test(c);
const hues = (value: string) => (value.match(LITERAL) ?? []).filter(c => !isBlackOrWhite(c));
const colored = (value: string) => /var\(--(accent|ok|warn|err|unreplied)\b/.test(value) || hues(value).length > 0;
const TOKEN_SCOPE = /^:root(\[[^\]]*\])?$/;
const STATE_WORD = /(?:^|[^a-z0-9])(ok|done|sent|success|warn|warning|err|error|fail|failed|bad|invalid|alert|att|ask|need|danger|down)(?![a-z0-9])/i;

function stripes(r: Rule): string[] {
	const found: string[] = [];
	const get = (p: string) => r.decls.find(([k]) => k === p)?.[1];
	for (const [prop, value] of r.decls) {
		const side = /^border-(left|right|top|bottom|inline-start|inline-end|block-start|block-end)$/.test(prop);
		if (side && colored(value) && parseFloat(value) >= 2) found.push(`${prop}: ${value}`);
		if (prop === "box-shadow") for (const m of value.matchAll(/inset\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+0(?:px)?\s+(?:0(?:px)?\s+)?([^,]*)/g))
			if ((m[1] !== "0" || m[2] !== "0") && colored(m[3])) found.push(`box-shadow: ${m[0]}`);
	}
	const tall = (get("top") !== undefined && get("bottom") !== undefined) || get("height") === "100%";
	if (/::(before|after)/.test(r.selector) && get("position") === "absolute" && tall && parseFloat(get("width") ?? "") <= 4 && colored(get("background") ?? get("background-color") ?? ""))
		found.push(`full-height bar ${get("width")}`);
	return found;
}

const SPACE_PROP = /^(?:(?:padding|margin)(?:-[a-z-]+)?|gap|row-gap|column-gap)$/;
const SCALE_PX = new Set([2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48]);
function stripVars(s: string): string {
	let out = "";
	for (let i = 0; i < s.length;) {
		if (s.startsWith("var(", i) && !/[\w-]/.test(s[i - 1] ?? "")) {
			let depth = 0, j = i + 3;
			for (; j < s.length; j++) if (s[j] === "(") depth++; else if (s[j] === ")" && --depth === 0) break;
			i = j + 1;
		} else out += s[i++];
	}
	return out;
}
// [off-scale, raw] px lengths of a spacing value; 0, em, %, vw and auto are not counted.
function spacePx(value: string): [number, number] {
	let off = 0, raw = 0;
	for (const m of stripVars(value).matchAll(/(?<![\w.])-?(\d*\.?\d+)px\b/g)) {
		const px = parseFloat(m[1]);
		if (px === 0) continue;
		if (SCALE_PX.has(px)) raw++; else off++;
	}
	return [off, raw];
}
const spaceCount = (file: string, off: number, raw: number) => off + raw ? [`space: ${file} has ${off} off-scale and ${raw} raw px spacing values; use --sp-*`] : [];

function auditCss(sheets: Source[]): string[] {
	const out: string[] = [];
	const sizes = new Map<string, [number, number]>();
	const spaces = new Map<string, [off: number, raw: number, nudges: number]>();
	for (const [file, text] of sheets) for (const r of parseCss(file, text)) {
		if (!spaces.has(file)) spaces.set(file, [0, 0, 0]);
		const at = `${file} ${r.selector}`;
		for (const s of stripes(r)) out.push(`stripe: ${at} ${s}`);
		const keyframes = /^(from|to|[\d.]+%)/.test(r.selector);
		for (const [prop, value, nudge] of r.decls) {
			if (prop === "content") continue;
			if (SPACE_PROP.test(prop) && !keyframes) {
				const [off, raw] = spacePx(value);
				const n = spaces.get(file)!;
				if (off + raw && nudge) n[2]++;
				else { n[0] += off; n[1] += raw; }
			}
			if (/var\(--(ok|warn|err)\b/.test(value) && !STATE_WORD.test(r.selector) && !keyframes && !STATUS_ALLOWED.has(r.selector)) out.push(`status: ${at} ${prop}: ${value}`);
			if (!(prop.startsWith("--") && TOKEN_SCOPE.test(r.selector)) && hues(value).length && !COLOR_ALLOWED.has(at)) out.push(`color: ${at} ${prop}: ${value}`);
			if (/^(transition|animation)/.test(prop) && !prop.endsWith("-name") && !prop.endsWith("-property") && value.replace(/var\([^)]*\)/g, "").match(/(^|[\s,])(?!0m?s\b)[\d.]+m?s\b/) && !DURATION_ALLOWED.has(at)) out.push(`duration: ${at} ${prop}: ${value}`);
			const n = sizes.get(file) ?? [0, 0];
			if (prop === "font-size" && /^[\d.]+px/.test(value)) n[0]++;
			if (/^border(-[a-z]+)*-radius$/.test(prop) && value.match(/[\d.]+px/g)?.some(px => parseFloat(px) > 4)) n[1]++;
			sizes.set(file, n);
		}
	}
	for (const [file, [fonts, radii]] of sizes) {
		const [maxFonts, maxRadii] = SIZE_ALLOWED[file] ?? [0, 0];
		if (fonts > maxFonts) out.push(`size: ${file} has ${fonts} px font-sizes, allowed ${maxFonts}; use --fs-*`);
		if (radii > maxRadii) out.push(`size: ${file} has ${radii} px radii, allowed ${maxRadii}; use --r-*`);
	}
	for (const [file, [off, raw, nudges]] of spaces) {
		if (nudges > SPACE_NUDGES) out.push(`space: ${file} has ${nudges} nudges, allowed ${SPACE_NUDGES}; use --sp-*`);
		out.push(...spaceCount(file, off, raw));
	}
	return out;
}

const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;
const JS_LITERAL = /#[0-9a-f]{6}\b|\b(?:rgb|hsl)a?\(/i;
function auditText(sources: Source[]): string[] {
	const out: string[] = [];
	for (const [file, text] of sources) {
		const isJs = file.endsWith(".js");
		const lines = text.split("\n");
		let spaceOff = 0, spaceRaw = 0;
		for (const line of lines) {
			if (/^\s*\/\//.test(line) || SPACE_JS_EXEMPT[file]?.test(line)) continue;
			const code = line.replace(/\/\*.*?\*\//g, "").replace(/\$\{[^}]*\}/g, "");
			for (const m of code.matchAll(/(?<![\w-])(?:(?:padding|margin)(?:-[a-z-]+)?|gap|row-gap|column-gap)\s*:\s*["'`]?([^;"'`}]*)/g)) {
				const [off, raw] = spacePx(m[1]);
				spaceOff += off; spaceRaw += raw;
			}
		}
		out.push(...spaceCount(file, spaceOff, spaceRaw));
		lines.forEach((line, i) => {
			if (EMOJI.test(line)) out.push(`emoji: ${file}:${i + 1} ${line.match(EMOJI)?.[0]}`);
			if (isJs && /var\(--(ok|warn|err)\b/.test(line) && file !== "custom.js") out.push(`status: ${file}:${i + 1} in a script`);
			if (/el\(["'`]select["'`]|<select[\s>]|createElement\(["'`]select/.test(line) && !/^\s*\/\//.test(line)) out.push(`select: ${file}:${i + 1} native <select>; use selectButton()`);
		});
		const colors = isJs ? lines.filter(l => !/^\s*\/\//.test(l) && JS_LITERAL.test(l)).length : 0;
		if (colors > (JS_COLOR_ALLOWED[file] ?? 0)) out.push(`color: ${file} has ${colors} lines with a color literal, allowed ${JS_COLOR_ALLOWED[file] ?? 0}`);
	}
	return out;
}

const webDir = join(import.meta.dir, "..", "web");
const readDir = (dir: string, ext: string): Source[] => readdirSync(join(webDir, dir)).filter(f => f.endsWith(ext)).sort().map(f => [f, readFileSync(join(webDir, dir, f), "utf8")]);
const realCss = () => readDir("css", ".css");
const realText = (): Source[] => [...readDir("js", ".js"), ["custom.js", readFileSync(join(webDir, "custom.js"), "utf8")], ["index.html", readFileSync(join(webDir, "index.html"), "utf8")]];

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
	test("the real CSS and scripts have no new violation", () => {
		expect([...auditCss(realCss()), ...auditText(realText())]).toEqual([]);
	});

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

	test("only transform and opacity move in a transition", () => {
		// docs/ui-spec.md Motion: transform and opacity only. A progress bar grows in width; the board cards, the split panes' drop zone and the original-draft panel are placed by script or by layout, so they move their box.
		const BOX = ["left", "top", "width", "height"];
		const EXCEPT: Record<string, string[]> = {
			".bar i": ["width"], ".tr-bar > span": ["width"],
			".bi": [...BOX, "box-shadow"], ".bi.bdrag": ["box-shadow"], ".board.narrow .bi": ["box-shadow"], ".board.narrow .bi.bdrag": ["box-shadow"], ".bph": BOX, ".pn-zone": BOX,
			".fs-card.tall.od-host": ["width"], ".od-cwrap .od-orig": ["flex-basis", "margin"],
		};
		const found: string[] = [];
		for (const [file, text] of realCss()) for (const r of parseCss(file, text)) for (const [k, v] of r.decls) {
			if (k !== "transition" && k !== "transition-property") continue;
			const props = v.split(/,(?![^(]*\))/).map(s => s.trim().split(/\s+/)[0]!);
			for (const prop of props) if (!["transform", "opacity", "visibility", "none"].includes(prop) && !EXCEPT[r.selector]?.includes(prop)) found.push(`${file} ${r.selector} ${prop}`);
		}
		expect(found).toEqual([]);
	});

	test("a list inside a dialog sits in the dialog's own scrolling region and sets no height cap of its own", () => {
		// the sheet body (.fs-body) is the scroller between title and footer; a max-height on a list inside it leaves an empty band and a second scroller
		const found: string[] = [];
		for (const [file, text] of realCss()) for (const r of parseCss(file, text)) {
			if (!/(^|[\s,])(\.pickbox|\.fs-body\s+\.(list|pickbox)|\.dbody\.fs-body\s+\.(list|pickbox))\b/.test(r.selector)) continue;
			for (const [k, v] of r.decls) if (k === "max-height" || k === "height") found.push(`${file} ${r.selector} ${k}: ${v}`);
		}
		expect(found).toEqual([]);
	});

	test("icons are drawn at 14, 16 or 20px with a 1.75 or 2 stroke", () => {
		const found: string[] = [];
		for (const [file, text] of realCss()) for (const r of parseCss(file, text)) {
			// only rules whose drawn subject is the svg: ".lead:has(> .ic)" sizes the box around it
			const bare = r.selector.replace(/:(?:has|is|not|where)\([^)]*\)/g, "");
			if (!bare.split(",").some(s => /(?:^|[\s>+~])(?:svg(?:\.ic)?|\.ic)\b[^\s>+~]*$/.test(s.trim()))) continue;
			for (const [k, v] of r.decls) {
				if ((k === "width" || k === "height") && /^\d+(\.\d+)?px$/.test(v) && ![14, 16, 20].includes(parseFloat(v))) found.push(`${file} ${r.selector} ${k} ${v}`);
				if (k === "stroke-width" && ![1.75, 2].includes(parseFloat(v))) found.push(`${file} ${r.selector} stroke-width ${v}`);
			}
		}
		expect(found).toEqual([]);
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
