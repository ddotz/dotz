import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source lints of web/css and web/js against the web/DESIGN.md rules, run on the real files by `bun hub/check.ts` and proven on planted CSS and JS in
// hub/design-rules-web.test.ts. audit*() is the same path for both, so a planted violation proves each check can fail.
//
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
	'04-files.css :root[data-theme="dark"] .hintrow', "04-files.css dialog.lbox::backdrop",
	"17-kakao.css .kk-av", '17-kakao.css :root[data-theme="dark"] .kk-av', "17-kakao.css .kk-chat", '17-kakao.css :root[data-theme="dark"] .kk-chat', "17-kakao.css .kk-video",
]);
// Literal times with no token to match: delays that wait for a close.
const DURATION_ALLOWED = new Set([
	"15-draft-original.css .od-orig[inert]",
	"15-draft-original.css .od-cwrap .od-orig[inert]", "15-draft-original.css .od-draftcol[inert], .od-cwrap .kk-draft[inert]",
]);
// [px font-sizes, px radii] per file: a ceiling, too many entries to name one by one.
const SIZE_ALLOWED: Record<string, [number, number]> = {
	"01-tokens.css": [11, 4], "02-cards-lists-tags.css": [12, 3], "03-base.css": [32, 16], "04-files.css": [54, 22],
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
export function parseCss(file: string, text: string): Rule[] {
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

export function auditCss(sheets: Source[]): string[] {
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
export function auditText(sources: Source[]): string[] {
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
export const realCss = () => readDir("css", ".css");
const realText = (): Source[] => [...readDir("js", ".js"), ["custom.js", readFileSync(join(webDir, "custom.js"), "utf8")], ["index.html", readFileSync(join(webDir, "index.html"), "utf8")]];

// The source lints of the real CSS and scripts, run by hub/check.ts. Each returns its findings; none needs a browser.
export const designRuleFindings = (): string[] => [...auditCss(realCss()), ...auditText(realText())];

// docs/ui-spec.md Motion: only transform and opacity move in a transition.
export function transitionFindings(): string[] {
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
	return found;
}

// A list inside a dialog sits in the dialog's own scrolling region and sets no height cap of its own.
export function dialogListFindings(): string[] {
	// the sheet body (.fs-body) is the scroller between title and footer; a max-height on a list inside it leaves an empty band and a second scroller
	const found: string[] = [];
	for (const [file, text] of realCss()) for (const r of parseCss(file, text)) {
		if (!/(^|[\s,])(\.pickbox|\.fs-body\s+\.(list|pickbox)|\.dbody\.fs-body\s+\.(list|pickbox))\b/.test(r.selector)) continue;
		for (const [k, v] of r.decls) if (k === "max-height" || k === "height") found.push(`${file} ${r.selector} ${k}: ${v}`);
	}
	return found;
}

// Icons are drawn at 14, 16 or 20px with a 1.75 or 2 stroke.
export function iconFindings(): string[] {
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
	return found;
}
