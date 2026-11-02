import { expect, test } from "bun:test";
import { inboxText } from "./intake.ts";
import { ownerRefs, refLines, type RefWorld } from "./mentions.ts";

const WORLD: RefWorld = {
	task: id => (id === "st_mail" ? { description: "메일 알림 마무리", status: "running", folder: "/tmp/wt-mail" } : undefined),
	lane: name => (name === "fix" ? { title: "기술부채 정리", status: "working", cwd: "/Users/x/Code/dotz" } : undefined),
	conv: key => (key === "mail:abc" ? { name: "견적 회신", live: true } : undefined),
};

test("ownerRefs keeps known kinds once each, flattens the label and drops junk", () => {
	expect(ownerRefs("nope")).toEqual([]);
	expect(ownerRefs([null, { kind: "file", id: "x" }, { kind: "task" }, { kind: "task", id: "st_a", label: "a\n  b" }, { kind: "task", id: "st_a", label: "again" }, { kind: "lane", id: "fix" }])).toEqual([
		{ kind: "task", id: "st_a", label: "a b" },
		{ kind: "lane", id: "fix", label: "fix" },
	]);
	expect(ownerRefs(Array.from({ length: 30 }, (_, i) => ({ kind: "task", id: `st_${i}` })))).toHaveLength(10);
});

test("refLines names each pick by its id with what runs now, and says when it is gone", () => {
	const refs = ownerRefs([{ kind: "task", id: "st_mail", label: "메일 알림 마무리" }, { kind: "lane", id: "fix", label: "기술부채 정리" }, { kind: "conv", id: "mail:abc", label: "견적 회신" }, { kind: "task", id: "st_gone", label: "끝난 일" }]);
	expect(refLines(refs, WORLD)).toEqual([
		`[지칭] @메일 알림 마무리 = task st_mail "메일 알림 마무리" (running, folder /tmp/wt-mail)`,
		`[지칭] @기술부채 정리 = lane fix "기술부채 정리" (working, cwd /Users/x/Code/dotz)`,
		`[지칭] @견적 회신 = conv mail:abc "견적 회신" (session running)`,
		"[지칭] @끝난 일 = task st_gone (not in the work list now)",
	]);
});

test("inboxText prints the reference lines right after the text of their part", () => {
	const refs = refLines(ownerRefs([{ kind: "task", id: "st_mail", label: "메일 알림 마무리" }]), WORLD);
	const l = inboxText({ kind: "message", source: "web", channel: "web", mid: "m-ref", author: "hyuns", text: "@메일 알림 마무리 이거 멈춰", refs }).split("\n");
	const body = l.indexOf("@메일 알림 마무리 이거 멈춰");
	expect(body).toBeGreaterThan(-1);
	expect(l[body + 1]).toBe(`[지칭] @메일 알림 마무리 = task st_mail "메일 알림 마무리" (running, folder /tmp/wt-mail)`);
});
