import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDemoViews } from "../site/demo-views";

const ROOT = join(import.meta.dir, "..");
const js = readdirSync(join(ROOT, "web", "js")).filter(f => f.endsWith(".js")).sort().map(f => readFileSync(join(ROOT, "web", "js", f), "utf8")).join("\n");
const html = readFileSync(join(ROOT, "site", "demo", "index.html"), "utf8");
const web = readFileSync(join(ROOT, "web", "index.html"), "utf8");

test("the demo page has a section for every view in the web app", () => {
	expect(() => assertDemoViews(js, html, web)).not.toThrow();
});

test("an element web/index.html has inside a view and the demo page lacks is named", () => {
	const table = 'const SCREENS = {\n  chat: { title: TX("common.chat"), html: true },\n};';
	const page = '<section id="v-chat"><div class="composer" id="composer"><form id="send"><input id="c-file"><textarea id="text"></textarea></form></div></section><aside id="sheet"></aside>';
	expect(() => assertDemoViews(table, '<section id="v-chat"><div id="composer"><form id="send"><textarea id="text"></textarea></form></div></section>', page)).toThrow("#c-file");
	expect(() => assertDemoViews(table, '<section id="v-chat"><div id="composer"><form id="send"><input id="c-file"><textarea id="text"></textarea></form></div></section>', page)).not.toThrow();
});

test("a view with no section names that section", () => {
	const table = 'const SCREENS = {\n  home: { title: TX("common.home"), html: true },\n  accounts: { title: TX("common.accounts"), html: true },\n};';
	expect(() => assertDemoViews(table, '<section id="v-home"></section>', "")).toThrow("#v-accounts");
});

test("a screen the web app builds its own section for (no html: true) is not checked", () => {
	expect(() => assertDemoViews('const SCREENS = {\n  cardform: { tab: "home", title: TX("base.title.cardform") },\n};', "", "")).not.toThrow();
});

test("a web bundle with no screen table fails instead of passing empty", () => {
	expect(() => assertDemoViews("const other = [];", html, web)).toThrow("const SCREENS");
});
