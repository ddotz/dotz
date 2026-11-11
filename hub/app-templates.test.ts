import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppTemplates, SHIPPED_DIR } from "./app-templates.ts";
import { integrationAvailable, integrationContext } from "./integrations.ts";

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "app-tpl-")); dirs.push(d); return d; };
const put = (d: string, rel: string, v: unknown) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), JSON.stringify(v)); };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("새로 추가하기 templates", () => {
	test("the shipped set is the six defaults, each ending with the shared rule about the secure form", () => {
		const t = readAppTemplates(fresh());
		expect(t.map(x => x.label)).toEqual(["메일", "카카오톡", "유튜브", "인스타그램", "댓글 자동 답글", "직접 쓰기"]);
		for (const x of t) {
			expect(x.text).toContain("{{");
			expect(x.text).toContain("보안 입력 양식(dotz_auth)");
		}
	});

	test("custom/app-templates.json replaces a template by key, adds new ones, and can replace the shared rule", () => {
		const d = fresh();
		put(d, "custom/app-templates.json", { suffix: "끝", templates: [{ key: "mail", text: "내 메일 {{주소}}" }, { key: "mine", label: "내 앱", text: "내 앱" }, { key: "Bad Key", text: "x" }, { key: "empty", text: " " }] });
		const t = readAppTemplates(d);
		expect(t.map(x => x.key)).toEqual(["mail", "kakao", "youtube", "instagram", "comments", "custom", "mine"]);
		expect(t[0]).toEqual({ key: "mail", label: "메일", text: "내 메일 {{주소}}\n\n끝" });
		expect(t.at(-1)).toEqual({ key: "mine", label: "내 앱", text: "내 앱\n\n끝" });
	});

	test("a `listed: false` request stays off the list and is found only by its key", () => {
		const dir = fresh();
		writeFileSync(join(dir, "_rule.md"), "규칙");
		writeFileSync(join(dir, "mail.md"), "---\nlabel: 메일\norder: 1\n---\n메일 {{주소}}\n");
		writeFileSync(join(dir, "shop.md"), "---\nlabel: 가게\nlisted: false\n---\n가게 {{아이디}}\n");
		const d = fresh();
		expect(readAppTemplates(d, dir).map(x => x.key)).toEqual(["mail"]);
		expect(readAppTemplates(d, dir, "shop")).toEqual([{ key: "shop", label: "가게", text: "가게 {{아이디}}\n\n규칙" }]);
		expect(readAppTemplates(d, dir, "none")).toEqual([]);
		put(d, "custom/app-templates.json", { templates: [{ key: "shop", text: "내 가게" }] });
		expect(readAppTemplates(d, dir).map(x => x.key)).toEqual(["mail"]);
		expect(readAppTemplates(d, dir, "shop")[0]?.text).toBe("내 가게\n\n규칙");
	});

	test("every shipped `listed: false` request stays off the list and is found by its key", () => {
		const d = fresh(), listed = readAppTemplates(d).map(x => x.key);
		const hidden = readdirSync(SHIPPED_DIR).filter(n => /^[a-z0-9-]+\.md$/.test(n) && /\nlisted: false\n/.test(readFileSync(join(SHIPPED_DIR, n), "utf8"))).map(n => n.slice(0, -3));
		expect(hidden.length).toBeGreaterThan(0);
		for (const k of hidden) {
			expect(listed).not.toContain(k);
			expect(readAppTemplates(d, undefined, k).map(x => x.key)).toEqual([k]);
		}
	});

	test("an unreadable override file leaves the shipped set", () => {
		const d = fresh();
		mkdirSync(join(d, "custom"), { recursive: true });
		writeFileSync(join(d, "custom/app-templates.json"), "{ not json");
		expect(readAppTemplates(d)).toHaveLength(6);
	});

	test("the 앱 추가 list holds only the apps switched off here", () => {
		const d = fresh();
		const none = integrationContext(d, []);
		expect(integrationAvailable([], none)).toEqual([]);
		put(d, "custom/apps.json", { kakao: { off: true } });
		expect(integrationAvailable([], integrationContext(d, [])).map(a => a.key)).toEqual(["kakao"]);
	});
});
