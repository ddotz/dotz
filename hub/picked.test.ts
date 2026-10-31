import { expect, test } from "bun:test";
import { inboxText } from "./intake.ts";
import { ownerElements, pickedLines } from "./picked.ts";

const lines = (s: string) => s.split("\n");

test("ownerElements keeps a well-formed item and clamps every field", () => {
	const [e] = ownerElements([{ n: 3, tag: "t".repeat(100), sel: "s".repeat(500), text: "a\n\nb\tc", html: "<b>".repeat(400), view: "v".repeat(300), title: "x".repeat(200) }]);
	expect(e.n).toBe(3);
	expect(e.tag.length).toBe(40);
	expect(e.sel.length).toBe(300);
	expect(e.text).toBe("a b c");
	expect(e.html.length).toBe(600);
	expect(e.view.length).toBe(200);
	expect(e.title.length).toBe(120);
});

test("ownerElements drops junk, empty items and everything past 20", () => {
	expect(ownerElements("nope")).toEqual([]);
	expect(ownerElements(undefined)).toEqual([]);
	expect(ownerElements([null, 7, "x", [], { tag: "div" }])).toEqual([]);
	const many = ownerElements(Array.from({ length: 30 }, (_, i) => ({ sel: `#e${i}` })));
	expect(many.length).toBe(20);
	expect(many.map(e => e.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
	expect(ownerElements([{ sel: "#a", n: -4 }, { text: "b" }]).map(e => e.n)).toEqual([1, 2]);
});

test("pickedLines prints one line per element and leaves out an empty text or html part", () => {
	const els = ownerElements([
		{ n: 1, tag: "button", sel: "#save", text: "Save", html: "<button>Save</button>", view: "settings", title: "Settings" },
		{ n: 2, tag: "h1", sel: "h1.title", text: "", html: "", view: "home", title: "" },
	]);
	expect(pickedLines(els)).toBe([
		`[picked 1] settings (Settings) | button #save | "Save" | html: <button>Save</button>`,
		"[picked 2] home | h1 h1.title",
	].join("\n"));
});

test("inboxText prints the picked lines right after the text of their part", () => {
	const text = inboxText({
		kind: "message", source: "web", channel: "web", mid: "m-pick", author: "hyuns", text: "이 두 개 고쳐줘",
		elements: [{ n: 1, tag: "button", sel: "#save", text: "Save", html: "", view: "settings", title: "" }, { n: 2, tag: "a", sel: "a.help", text: "Help", html: "", view: "home", title: "" }],
	});
	const l = lines(text);
	const body = l.indexOf("이 두 개 고쳐줘");
	expect(body).toBeGreaterThan(-1);
	expect(l[body + 1]).toStartWith("[picked 1]");
	expect(l[body + 2]).toStartWith("[picked 2]");
});

test("a burst keeps each part's own picked elements", () => {
	const text = inboxText({
		kind: "message", source: "web", channel: "web", mid: "m-pick-b", author: "hyuns", text: "둘",
		parts: [{ text: "하나", elements: [{ n: 1, tag: "div", sel: "#one", text: "", html: "", view: "v1", title: "" }] }, { text: "둘" }],
	});
	expect(text).toContain("[picked 1] v1 | div #one");
	expect(lines(text).indexOf("하나")).toBeLessThan(lines(text).findIndex(x => x.startsWith("[picked 1]")));
});
