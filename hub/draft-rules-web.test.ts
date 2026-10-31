import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "./app-settings.ts";
import { fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

// 자동 초안 규칙 in the mail app's settings screen (web/js/32-app-settings.js arNodes) against a stub gateway whose settings route calls the real
// hub/app-settings.ts on a temp data dir, and the rule's badge on a mail row and a draft card. Names and addresses are placeholders.
// RULES_SHOTS=<dir> keeps a screenshot of the form and of the saved rule.
const SHOTS = process.env.RULES_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "rules-web-"));
const config = () => JSON.parse(readFileSync(join(data, "custom/reply-drafts/config.json"), "utf8"));
const patches = inbox<Record<string, unknown>>();
const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], needs: { drafts: 0, unread: 0, sentToday: 0 } }], available: [] });
		const m = /^\/api\/integrations\/([a-z0-9-]+)\/settings$/.exec(p);
		if (m) {
			try {
				if (req.method === "PATCH") {
					const b = (await req.json()) as { values: unknown };
					patches.push({ app: m[1], values: b.values });
					return json({ key: m[1], fields: writeSettings(data, m[1]!, b.values) });
				}
				return json({ key: m[1], fields: readSettings(data, m[1]!) });
			} catch (e) {
				return json({ error: (e as Error).message }, 400);
			}
		}
	},
});
afterAll(() => {
	hub.stop();
	rmSync(data, { recursive: true, force: true });
});

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const nth = async (n: number) => (await patches.until(p => p.length >= n, 10_000, `patch ${n}`))[n - 1];
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const type = (sel: string, value: string) => `{ const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); }`;

describe("자동 초안 규칙 in the mail settings screen", async () => {
	const v = await hub.view({ width: 1280, height: 900 });

	test("the section sits under 자동 초안과 승인 with the empty 기본 규칙 box and greyed explanations", async () => {
		const opened = hub.nextStream();
		await v.navigate(`${hub.origin}/`);
		await opened;
		await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
		await run(v, `go("monitoring", "i:mail")`);
		await waitFor(v, `[...document.querySelectorAll("[data-as-more]")].find(b => b.offsetParent && !b.hidden)`);
		await run(v, `[...document.querySelectorAll("[data-as-more]")].find(b => b.offsetParent && !b.hidden).click()`);
		await waitFor(v, `document.querySelector('#app-sw [data-sub="rules"]')`);
		const got = await q<{ order: string[]; def: [string, string]; add: boolean }>(v, `
			const box = document.querySelector("#app-sw"), kids = [...box.children];
			const sec = kids.findIndex(e => e.dataset.sec === "draft"), sub = kids.findIndex(e => e.dataset.sub === "rules"), next = kids.findIndex((e, i) => i > sec && e.classList.contains("as-sec"));
			const d = box.querySelector('[data-k="draft_default"]');
			return { order: [sec < sub ? "after-heading" : "before", next < 0 || sub < next ? "inside" : "outside"], def: [d.value, d.placeholder], add: !!box.querySelector('[data-k="rule-add"]') };`);
		expect(got.order).toEqual(["after-heading", "inside"]);
		expect(got.def).toEqual(["", "모든 초안에 공통으로 적용할 말투나 내용. 비워 두면 메일만 보고 써요"]);
		expect(got.add).toBe(true);
	});

	test("규칙 추가 opens a form whose boxes explain themselves; 저장 writes the rule through the settings PATCH", async () => {
		await run(v, `document.querySelector('[data-k="rule-add"]').click()`);
		await waitFor(v, `document.querySelector('[data-rule-form="new"]')`);
		const ph = await q<string[]>(v, `return ["name", "when", "how", "files"].map(k => document.querySelector('[data-k="rule-' + k + '"]').placeholder)`);
		expect(ph.map(p => p.split(":")[0])).toEqual(["이름", "언제", "어떻게", "붙일 파일"]);
		await run(v, [type('[data-k="rule-name"]', "자료 요청"), type('[data-k="rule-when"]', "신청서를 보내 달라는 메일"), type('[data-k="rule-how"]', "신청서를 첨부하고 짧게 인사"), type('[data-k="rule-files"]', "forms/신청서.pdf, 안내문.pdf"), ].join("\n"));
		await shot(v, "rules-form.png");
		await run(v, `document.querySelector('[data-k="rule-save"]').click()`);
		await waitFor(v, `document.querySelector('#app-sw [data-rule="r1"]') && !document.querySelector("[data-rule-form]")`);
		await shot(v, "rules-saved.png");
		expect(await nth(1)).toEqual({ app: "mail", values: { draft_rules: [{ name: "자료 요청", when: "신청서를 보내 달라는 메일", how: "신청서를 첨부하고 짧게 인사", files: ["forms/신청서.pdf", "안내문.pdf"], on: true }] } });
		expect(config().draftRules.mail).toEqual([{ id: "r1", name: "자료 요청", when: "신청서를 보내 달라는 메일", how: "신청서를 첨부하고 짧게 인사", files: ["forms/신청서.pdf", "안내문.pdf"], on: true }]);
		expect(await q(v, `return document.querySelector('[data-rule="r1"] [data-rule]').textContent`)).toBe("자료 요청");
	}, 20_000);

	test("the switch turns the rule off, 고치기 edits it in place, the 기본 규칙 box saves on change", async () => {
		await run(v, `document.querySelector('[data-k="rule:r1"]').click()`);
		await waitFor(v, `document.querySelector('[data-k="rule:r1"]').getAttribute("aria-checked") === "false"`);
		expect(await nth(2)).toMatchObject({ values: { draft_rules: [{ id: "r1", on: false }] } });
		expect(config().draftRules.mail[0].on).toBe(false);
		await run(v, `document.querySelector('[data-k="rule-edit:r1"]').click()`);
		await waitFor(v, `document.querySelector('[data-rule-form="r1"]')`);
		expect(await q(v, `return document.querySelector('[data-k="rule-files"]').value`)).toBe("forms/신청서.pdf, 안내문.pdf");
		await run(v, [type('[data-k="rule-name"]', "양식 요청"), `document.querySelector('[data-k="rule-save"]').click()`].join("\n"));
		await waitFor(v, `!document.querySelector("[data-rule-form]") && document.querySelector('[data-rule="r1"] [data-rule]').textContent === "양식 요청"`);
		await nth(3);
		expect(config().draftRules.mail[0]).toMatchObject({ id: "r1", name: "양식 요청", on: false });
		await run(v, `{ const d = document.querySelector('[data-k="draft_default"]'); d.value = "존댓말로 짧게"; d.dispatchEvent(new Event("change")); }`);
		expect(await nth(4)).toEqual({ app: "mail", values: { draft_default: "존댓말로 짧게" } });
		await waitFor(v, `document.querySelector('[data-k="draft_default"]').value === "존댓말로 짧게"`);
		expect(config().draftDefaults.mail).toBe("존댓말로 짧게");
		await run(v, `document.querySelector('[data-k="rule-del:r1"]').click()`);
		await waitFor(v, `!document.querySelector('#app-sw [data-rule="r1"]')`);
		expect(config().draftRules.mail).toEqual([]);
	}, 20_000);
});

describe("the rule's badge", async () => {
	const v = await hub.view({ width: 1280, height: 900 });
	test("a mail row and a draft card show the rule's name as a plain tag; a mail without one shows none", async () => {
		const opened = hub.nextStream();
		await v.navigate(`${hub.origin}/`);
		await opened;
		await waitFor(v, `typeof NT !== "undefined" && NT.loaded && typeof monConvNode === "function"`);
		const got = await q<{ rows: (string | null)[]; cls: string[]; card: string | null }>(v, `
			const at = new Date().toISOString();
			MAILS.set("mail:rw-1", { subject: "신청서 부탁드립니다", from: "Parent <parent@example.com>", source: "fx", at, reply: "draft", rule: "자료 요청", suggest: { kind: "reply-draft", label: "답장 초안", ref: "d1", rule: "자료 요청" } });
			MAILS.set("mail:rw-2", { subject: "회의 일정", from: "Kim <kim@example.com>", source: "fx", at, reply: "needs" });
			const rows = ["mail:rw-1", "mail:rw-2"].map(t => monConvNode(t, "메일"));
			const card = draftNode({ toLabel: "받는이", to: "parent@example.com", subject: "Re: 신청서", body: "첨부해 드립니다.", rule: "자료 요청", attachments: [{ name: "신청서.pdf" }] }, { edit: false });
			return { rows: rows.map(r => r.querySelector(".rc-hd [data-rule]")?.textContent ?? null), cls: [...rows[0].querySelector("[data-rule]").classList], card: card.querySelector(".dr-rulebar [data-rule]")?.textContent ?? null };`);
		expect(got.rows).toEqual(["자료 요청", null]);
		expect(got.cls).toEqual(["tag", "mr-rule"]);
		expect(got.card).toBe("자료 요청");
	});
});
