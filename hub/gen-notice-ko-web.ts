// Writes web/js/01-notice-ko.js from hub/notice-ko.ts: the page runs the same code as the hub (bun hub/gen-notice-ko-web.ts).
import { join } from "node:path";

const root = join(import.meta.dir, "..");
export async function buildNoticeKoWeb(): Promise<string> {
	const src = await Bun.file(join(root, "hub/notice-ko.ts")).text();
	const js = new Bun.Transpiler({ loader: "ts" }).transformSync(src).replace(/^import .*$/gm, "").replace(/^export /gm, "").replace(/^\s*\n/gm, "");
	const head = "// Generated from hub/notice-ko.ts by hub/gen-notice-ko-web.ts; do not edit; web/js/01-notice.js picks it when the language is ko. stripMarkers (02-basic-markdown.js) and clockKo (11-watchtext.js) are the page's own.\n";
	return `${head}const NOTICE_KO = (() => {\n${js}return { noticeKo, errorKo, cronKo, plainTable, dropIdNote };\n})();\n`;
}
if (import.meta.main) await Bun.write(join(root, "web/js/01-notice-ko.js"), await buildNoticeKoWeb());
