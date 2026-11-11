// In-message charts: a ```chart fence holding a ztd-charts JSON spec (docs/message-spec.md, Chart). ztd-charts checks and draws it, @resvg/resvg-js turns
// the SVG into a PNG for Discord. Both load on the first chart only (dynamic import), never on the gateway start path (hub/chart.test.ts). Drawings are
// cached under <data dir>/charts by hash of spec, theme and locale; the folder is kept under CACHE_BYTES, oldest first.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DATA_DIR, log } from "./config.ts";
import { lang } from "./i18n.ts";
import { baseLanguage } from "./language.ts";

export const CHART_DIR = join(DATA_DIR, "charts");
const CACHE_BYTES = 30 * 1024 * 1024;
const FONT_DIR = join(import.meta.dir, "..", "node_modules", "ztd-charts-cli", "fonts");
const FONTS = ["Regular", "Medium", "SemiBold", "Bold", "ExtraBold"].map(w => join(FONT_DIR, `Pretendard-${w}.otf`));
export type Theme = "light" | "dark";
export type ChartCheck = { ok: true; spec: Record<string, unknown> } | { ok: false; note: string };

const ko = () => baseLanguage(lang()) === "ko";
const locale = () => (ko() ? "ko-KR" : "en-US");
const NOTE = { ko: "차트 형식이 맞지 않아 JSON으로 보여 드려요", en: "The chart spec is not valid, so it is shown as JSON" };
const note = (why: string) => `${ko() ? NOTE.ko : NOTE.en}: ${why}`;

/** A fence body as a spec ztd-charts accepts, or the short note shown under the JSON. Data must be inline: a `{ url }` source is refused (the gateway fetches nothing for a chart). */
export async function checkChart(text: string): Promise<ChartCheck> {
	let spec: unknown;
	try {
		spec = JSON.parse(text);
	} catch {
		return { ok: false, note: note("JSON") };
	}
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, note: note("JSON") };
	const data = (spec as { data?: unknown }).data;
	if (data && typeof data === "object" && !Array.isArray(data) && "url" in data) return { ok: false, note: note("data.url") };
	const { validateSpec } = await import("ztd-charts/spec");
	const r = validateSpec(spec, { lang: ko() ? "ko" : "en" });
	if (!r.valid) return { ok: false, note: note(r.errors.slice(0, 2).map(e => `${e.path} ${e.message}`.trim()).join("; ")) };
	return { ok: true, spec: spec as Record<string, unknown> };
}

// The app's tokens (web/css/01-tokens.css, web/DESIGN.md) as ztd-charts theme tokens, so a chart reads as one of the message's cards: the card is --card
// with the --line-2 border of a 목록 block, the one highlighted item is --accent and the rest --line-2, labels are --fg-3 (5.4:1 on --card in both themes).
// Light only: the blue reaches 3.7:1 on white, so accent text is --fg and text on an accent fill is the dark ink of the dark theme's --on-accent (5.0:1).
const FONT = `Pretendard, "Pretendard Variable", -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif`;
const MONO = `ui-monospace, "SF Mono", "Geist Mono", SFMono-Regular, Menlo, Consolas, monospace`;
const APP_THEME = {
	light: {
		name: "dotz-light", bg: "#f2f4f6", panel: "#ffffff", ink: "#191f28", muted: "#616b78", dim: "#d1d6db", accent: "#3182f6", accentText: "#191f28", onAccent: "#121214",
		onInk: "#ffffff", line: "#d1d6db", line2: "#e5e8eb", neutral: "#d1d6db", neutralStrong: "#616b78", onNeutralStrong: "#ffffff", neutralSoft: "#e5e8eb", lift: "#f9fafb",
		tint: "rgba(49, 130, 246, 0.14)", fontFamily: FONT, monoFamily: MONO, radius: 12,
	},
	dark: {
		name: "dotz-dark", bg: "#121214", panel: "#1d1d21", ink: "#ececf0", muted: "#8e939c", dim: "#3d3d45", accent: "#6ca7ff", accentText: "#6ca7ff", onAccent: "#121214",
		onInk: "#1d1d21", line: "#3d3d45", line2: "#2b2b31", neutral: "#3d3d45", neutralStrong: "#8e939c", onNeutralStrong: "#1d1d21", neutralSoft: "#34343b", lift: "#232328",
		tint: "rgba(108, 167, 255, 0.14)", fontFamily: FONT, monoFamily: MONO, radius: 12,
	},
} as const;
// ztd-charts has no size tokens and draws the card title at 800 22px, the number 17px and the takeaway 800 17px. They become the 목록 block title
// (.md .mlist-h: 600 13px in --fg-3) and the chat body size (15px, 600), so the chart never outweighs the message around it.
const appSized = (svg: string, t: (typeof APP_THEME)[Theme]): string =>
	svg
		.replace(/font-size="22" font-weight="800" letter-spacing="-0.5" fill="[^"]*"/, `font-size="13" font-weight="600" fill="${t.muted}"`)
		.replace(/font-size="17" font-weight="700" fill="([^"]*)"/, `font-size="13" font-weight="600" fill="$1"`)
		.replace(/font-size="17" font-weight="800" letter-spacing="-0.3"/, `font-size="15" font-weight="600"`);

// The style version is part of the key, so drawings cached in an older look are drawn again.
const key = (text: string, theme: Theme, ext: string) => `${createHash("sha256").update(`${text}\n${theme}\n${locale()}\napp-theme-1`).digest("hex").slice(0, 16)}-${theme}.${ext}`;

// Oldest drawings go first once the folder passes CACHE_BYTES; a file another call removed meanwhile is already gone.
function prune(): void {
	const files = readdirSync(CHART_DIR).map(name => {
		const path = join(CHART_DIR, name);
		const st = statSync(path);
		return { path, size: st.size, at: st.mtimeMs };
	});
	let total = files.reduce((n, f) => n + f.size, 0);
	for (const f of files.sort((a, b) => a.at - b.at)) {
		if (total <= CACHE_BYTES) break;
		try {
			unlinkSync(f.path);
		} catch {
			// removed by a parallel prune: nothing left to do
		}
		total -= f.size;
	}
}

// A cached drawing, or a new one written under its hash (temp file + rename: Discord never attaches a half-written PNG).
async function cached(file: string, draw: () => Promise<Uint8Array | string>): Promise<string> {
	const path = join(CHART_DIR, file);
	// a hit is touched, so pruning drops the least recently used drawing, not one Discord is about to attach
	if (existsSync(path))
		try {
			utimesSync(path, new Date(), new Date());
			return path;
		} catch {
			// pruned meanwhile: draw it again
		}
	const out = await draw();
	mkdirSync(CHART_DIR, { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, out);
	renameSync(tmp, path);
	prune();
	return path;
}

async function svgOf(spec: Record<string, unknown>, theme: Theme, background: boolean, width?: number): Promise<string> {
	const { renderSpecToSVG } = await import("ztd-charts/server");
	const { theme: _own, ...rest } = spec;
	// Without a background (the web) the chart card sits flush with the message's other cards, so no outer padding.
	return appSized(renderSpecToSVG(rest as never, { theme: APP_THEME[theme], locale: locale(), background, ...(background ? {} : { padding: 0 }), ...(width ? { width } : {}) }), APP_THEME[theme]);
}

/** The web drawing: an SVG without a page background (the message card shows through), drawn at the width it is shown so its text stays readable on a phone. */
export async function chartSvg(text: string, spec: Record<string, unknown>, theme: Theme, width = 720): Promise<string> {
	return readFileSync(await cached(key(text, theme, `${width}.svg`), () => svgOf(spec, theme, false, width)), "utf8");
}

/** The Discord drawing: a PNG file at twice the size, drawn with the bundled Pretendard only (system fonts cost 600 ms and 250 MB). */
export async function chartPng(text: string, spec: Record<string, unknown>, theme: Theme = "dark"): Promise<string> {
	return cached(key(text, theme, "png"), async () => {
		const { Resvg } = await import("@resvg/resvg-js");
		const svg = await svgOf(spec, theme, true);
		return new Resvg(svg, { fitTo: { mode: "zoom", value: 2 }, font: { loadSystemFonts: false, fontFiles: FONTS, defaultFontFamily: "Pretendard" } }).render().asPng();
	});
}

/** A PNG this module wrote: Discord may attach it without the result-file roots (hub/discord-files.ts planFiles). */
export const isChartFile = (path: string): boolean => dirname(path) === CHART_DIR && /^[0-9a-f]{16}-(light|dark)\.png$/.test(basename(path));

const FENCE = /(^|\n)[ \t]{0,3}```chart[ \t]*\n([\s\S]*?)\n[ \t]{0,3}```[ \t]*(?=\n|$)/g;

/** Discord: each ```chart fence becomes a PNG attachment (the fence leaves the text); one that does not check or draw stays as a ```json block with a short note. */
export async function chartFiles(r: { text: string; files: string[] }): Promise<{ text: string; files: string[] }> {
	if (!r.text.includes("```chart")) return r;
	const charts: string[] = [], parts: string[] = [];
	let at = 0;
	for (const m of r.text.matchAll(FENCE)) {
		parts.push(r.text.slice(at, m.index), m[1]!);
		at = m.index + m[0].length;
		const body = m[2]!;
		let fail: string;
		try {
			const c = await checkChart(body);
			if (c.ok) {
				charts.push(await chartPng(body, c.spec));
				continue;
			}
			fail = c.note;
		} catch (error) {
			log(`chart: could not draw a chart for Discord: ${(error as Error).message}`);
			fail = note(ko() ? "그리지 못했어요" : "drawing failed");
		}
		parts.push(`\`\`\`json\n${body}\n\`\`\`\n-# ${fail}`);
	}
	parts.push(r.text.slice(at));
	return { text: parts.join("").replace(/\n{3,}/g, "\n\n").trim(), files: [...charts, ...r.files] };
}

// The width the page shows the chart at, in 40 px steps between 320 and 720 (a few cached sizes, not one per pixel).
const webWidth = (w: unknown): number => (typeof w === "number" && Number.isFinite(w) ? Math.min(720, Math.max(320, Math.round(w / 40) * 40)) : 720);

/** POST /api/chart {spec, width?}: the web's drawing in both themes, or the note to show under the JSON. */
export async function chartRoute(req: Request): Promise<Response> {
	const b = (await req.json().catch(() => ({}))) as { spec?: unknown; width?: unknown };
	if (typeof b.spec !== "string" || b.spec.length > 20_000) return Response.json({ ok: false, note: note("spec") }, { status: 400 });
	try {
		const c = await checkChart(b.spec);
		if (!c.ok) return Response.json(c);
		const [light, dark] = await Promise.all([chartSvg(b.spec, c.spec, "light", webWidth(b.width)), chartSvg(b.spec, c.spec, "dark", webWidth(b.width))]);
		return Response.json({ ok: true, light, dark });
	} catch (error) {
		log(`chart: could not draw a chart for the web: ${(error as Error).message}`);
		return Response.json({ ok: false, note: note(ko() ? "그리지 못했어요" : "drawing failed") });
	}
}
