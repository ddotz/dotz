// The notice wording the hub uses (a push, a conversation preview, a stored notice read back): the same functions the page has.
// Korean installs get hub/notice-ko.ts as it is; any other language runs web/js/01-notice.js for the language the page is served in,
// so no Korean word reaches a non-Korean owner from here (the catalog is notice.* in web/i18n).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as korean from "./notice-ko.ts";
import type { PlainOpts } from "./notice-ko.ts";
import { stripMarkers } from "./tone.ts";
import { clockKo } from "./watchtext.ts";
import { i18nPrelude, webView, type View } from "./web-i18n.ts";

export type { PlainOpts };
type Engine = Pick<typeof korean, "noticeKo" | "errorKo" | "cronKo" | "plainTable" | "dropIdNote">;

const JS_DIR = join(import.meta.dir, "..", "web", "js");
const built = new WeakMap<View, Engine>();

export function noticeFor(view: View | undefined): Engine {
	if (!view || view.lang === "ko") return korean;
	let engine = built.get(view);
	if (!engine) {
		const source = ["01-notice-ko.js", "01-notice.js"].map(f => readFileSync(join(JS_DIR, f), "utf8")).join("\n");
		engine = new Function("stripMarkers", "clockKo", `${i18nPrelude(view.lang)}\n${source}\nreturn { noticeKo, errorKo, cronKo, plainTable, dropIdNote };`)(stripMarkers, clockKo) as Engine;
		built.set(view, engine);
	}
	return engine;
}
const engine = (): Engine => noticeFor(webView());

export const noticeKo = (raw: string, o?: PlainOpts): string => engine().noticeKo(raw, o);
export const errorKo = (msg: string): string => engine().errorKo(msg);
export const cronKo = (expr: string): string => engine().cronKo(expr);
export const plainTable = (text: string): string => engine().plainTable(text);
export const dropIdNote = (s: string): string => engine().dropIdNote(s);
