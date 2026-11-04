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
//   /* nudge: <reason> */ is excused (1px line compensation, optical nudge), at most 3 per file. Counted per file against SPACE_ALLOWED; a count
//   below the baseline fails too, so the entry only shrinks. The same px in strings of web/js, custom.js and index.html (inline style, CSS text)
//   is counted against SPACE_JS_ALLOWED; the mail iframe CSS (const MB_CSS in 11-mailbody.js) is its own document and is exempt.
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
	".ni .nnb", ".conn", "#bell-n", ".pl-nb", '.pm-step[aria-checked="true"] .pm-ck', ".md .mlist-b", ".cv-task .ct-bar span",
	".hneeds .hn-h .sup", ".oerr", ".au .ferr",
]);
// Literal colors a fix would visibly change, as `file selector`: the ulw keyword rainbow, the raised dark toast and hint, the lightbox backdrops, and
// the KakaoTalk look (a per-person avatar hue, its unread yellow, the video placeholder).
const COLOR_ALLOWED = new Set([
	"03-base.css .sendrow.ulw", "03-base.css .ta-hl .ulw-kw", '03-base.css :root[data-theme="dark"] .ntf', '03-base.css :root[data-theme="dark"] .ntf:hover',
	'04-files.css :root[data-theme="dark"] .hintrow', "04-files.css dialog.lbox::backdrop", "04-files.css dialog.tbox::backdrop",
	"17-kakao.css .kk-av", '17-kakao.css :root[data-theme="dark"] .kk-av', "17-kakao.css .kk-chat", '17-kakao.css :root[data-theme="dark"] .kk-chat', "17-kakao.css .kk-video",
]);
// Literal times with no token to match: highlights of over a second, delays that wait for a close, and two sheet openings between tokens.
const DURATION_ALLOWED = new Set([
	"09-notices.css .nt-hl::after", "14-overlay.css .menu.msheet", "14-overlay.css dialog.pal[open]::backdrop", "15-draft-original.css .od-orig[inert]",
	"15-draft-original.css .od-cwrap .od-orig[inert]", "15-draft-original.css .od-draftcol[inert], .od-cwrap .kk-draft[inert]", "15-reply.css [data-rid].rp-flash",
	"17-kakao.css .kk-m.kk-hl .kk-bub, .kk-m.kk-hl .kk-media, .kk-m.kk-hl .kk-sticker",
]);
// [px font-sizes, px radii] per file: a ceiling, too many entries to name one by one.
const SIZE_ALLOWED: Record<string, [number, number]> = {
	"01-tokens.css": [0, 0], "02-cards-lists-tags.css": [0, 0], "03-base.css": [0, 0], "04-files.css": [0, 0],
	"05-log.css": [0, 0], "06-harness.css": [0, 0], "07-chat.css": [0, 0], "08-project-sessions.css": [0, 0],
	"09-notices.css": [0, 0], "10-conversations.css": [0, 0], "11-peers.css": [0, 0], "13-code-shell.css": [0, 0],
	"14-overlay.css": [1, 0], "15-draft-original.css": [0, 0], "15-reply-card.css": [0, 0], "15-reply.css": [0, 0],
	"15-settings-pages.css": [0, 0], "15-settings-phone.css": [0, 0], "15-triage.css": [0, 0], "16-result-card.css": [0, 0],
	"17-kakao.css": [0, 0], "18-app-settings.css": [0, 0], "18-comments.css": [0, 0], "19-volume.css": [0, 0],
	"20-apps.css": [0, 0], "20-mail-box.css": [0, 0], "20-mail-thread.css": [0, 0], "20-monitoring.css": [0, 0],
	"20-projects.css": [0, 0], "21-picker.css": [0, 0], "22-shell.css": [7, 3],
};
// [off-scale, raw] px spacing values per file (see space above), as SIZE_ALLOWED: a ceiling and, because the number is exact, a floor.
const SPACE_ALLOWED: Record<string, [number, number]> = {
	"01-tokens.css": [11, 0], "02-cards-lists-tags.css": [6, 0], "03-base.css": [41, 0], "04-files.css": [37, 0],
	"05-log.css": [42, 0], "06-harness.css": [22, 0], "07-chat.css": [21, 0], "07-messengers.css": [0, 0],
	"08-project-sessions.css": [3, 0], "09-notices-screen.css": [0, 0], "09-notices.css": [6, 0], "10-conversations.css": [12, 0],
	"11-peers.css": [6, 0], "13-code-shell.css": [5, 0], "14-overlay.css": [0, 0], "15-draft-original.css": [6, 0],
	"15-reply-card.css": [11, 0], "15-reply.css": [2, 0], "15-settings-pages.css": [3, 0], "15-settings-phone.css": [3, 0],
	"15-triage.css": [14, 0], "16-result-card.css": [37, 0], "17-kakao.css": [32, 0], "18-app-settings.css": [5, 0],
	"18-comments.css": [12, 0], "19-volume.css": [4, 0], "20-apps.css": [2, 0], "20-canvas.css": [0, 0],
	"20-mail-box.css": [8, 0], "20-mail-thread.css": [6, 0], "20-monitoring.css": [5, 0], "20-projects.css": [4, 0],
	"21-picker.css": [3, 0], "22-shell.css": [8, 0],
};
// The same per script file: literal padding / margin / gap px in strings.
const SPACE_JS_ALLOWED: Record<string, [number, number]> = {
	"08-home.js": [0, 0], "19-project-main.js": [1, 0], "21-providers.js": [0, 0], "25-settings-accounts.js": [0, 0],
	"26-settings-runtime.js": [0, 0], "37-api-budget.js": [0, 0], "custom.js": [28, 0],
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
function spaceBaseline(file: string, off: number, raw: number, allowed: Record<string, [number, number]>, table: string): string[] {
	const [maxOff, maxRaw] = allowed[file] ?? [0, 0];
	const has = `${file} has ${off} off-scale and ${raw} raw px spacing values`;
	if (off > maxOff || raw > maxRaw) return [`space: ${has}, allowed ${maxOff} and ${maxRaw}; use --sp-*`];
	if (off < maxOff || raw < maxRaw) return [`space: ${has}, below the baseline ${maxOff} and ${maxRaw}; lower its entry in ${table}`];
	return [];
}

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
		out.push(...spaceBaseline(file, off, raw, SPACE_ALLOWED, "SPACE_ALLOWED"));
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
		out.push(...spaceBaseline(file, spaceOff, spaceRaw, SPACE_JS_ALLOWED, "SPACE_JS_ALLOWED"));
		lines.forEach((line, i) => {
			if (EMOJI.test(line)) out.push(`emoji: ${file}:${i + 1} ${line.match(EMOJI)?.[0]}`);
			if (isJs && /var\(--(ok|warn|err)\b/.test(line) && file !== "custom.js") out.push(`status: ${file}:${i + 1} in a script`);
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

	test.each([["space", `box.style.cssText = "margin-top:4px";`], ["space", `box.style.cssText = "padding:10px";`]])("a planted %s in a script fails: %s", (rule, js) => {
		expect(auditText([["planted.js", js]]).some(f => f.startsWith(`${rule}: `))).toBe(true);
	});

	test("off-scale and raw px are counted apart", () => {
		expect(auditCss([["planted.css", `.p { padding: 10px 4px; margin: calc(100% - 14px); }`]])).toEqual(["space: planted.css has 2 off-scale and 1 raw px spacing values, allowed 0 and 0; use --sp-*"]);
		expect(auditText([["planted.js", `a.style.cssText = "margin-top:4px"; b.innerHTML = '<i style="padding:10px;gap:2px">';`]])).toEqual(["space: planted.js has 1 off-scale and 2 raw px spacing values, allowed 0 and 0; use --sp-*"]);
	});

	test("a fourth nudge in one file fails, three do not", () => {
		const nudged = (n: number) => Array.from({ length: n }, (_, i) => `.n${i} { margin-top: 1px; /* nudge: line ${i} */ }`).join("\n");
		expect(auditCss([["planted.css", nudged(3)]])).toEqual([]);
		expect(auditCss([["planted.css", nudged(4)]])).toEqual(["space: planted.css has 4 nudges, allowed 3; use --sp-*"]);
	});

	test("a count below the baseline fails and names the entry", () => {
		const css = Object.entries(SPACE_ALLOWED).find(([, n]) => n[0] + n[1] > 0)!;
		expect(auditCss([[css[0], `.clean { padding: 0 var(--sp-2); }`]])).toEqual([expect.stringContaining("below the baseline")]);
		const js = Object.entries(SPACE_JS_ALLOWED).find(([, n]) => n[0] + n[1] > 0)!;
		expect(auditText([[js[0], `el("span", {})`]])).toEqual([expect.stringContaining("below the baseline")]);
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
