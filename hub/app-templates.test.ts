import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppTemplates } from "./app-templates.ts";
import { integrationAvailable, integrationContext } from "./integrations.ts";

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "app-tpl-")); dirs.push(d); return d; };
const put = (d: string, rel: string, v: unknown) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), JSON.stringify(v)); };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("새로 추가하기 templates", () => {
	test("the shipped set is the seven defaults, each ending with the shared rule about the secure form", () => {
		const t = readAppTemplates(fresh());
		expect(t.map(x => x.label)).toEqual(["메일", "카카오톡", "유튜브", "인스타그램", "댓글 자동 답글", "직접 쓰기", "한컴 문서(hdocs)"]);
		for (const x of t) {
			expect(x.text).toContain("{{");
			expect(x.text).toContain("보안 입력 양식(dotz_auth)");
		}
	});

	test("custom/app-templates.json replaces a template by key, adds new ones, and can replace the shared rule", () => {
		const d = fresh();
		put(d, "custom/app-templates.json", { suffix: "끝", templates: [{ key: "mail", text: "내 메일 {{주소}}" }, { key: "mine", label: "내 앱", text: "내 앱" }, { key: "Bad Key", text: "x" }, { key: "empty", text: " " }] });
		const t = readAppTemplates(d);
		expect(t.map(x => x.key)).toEqual(["mail", "kakao", "youtube", "instagram", "comments", "custom", "hdocs", "mine"]);
		expect(t[0]).toEqual({ key: "mail", label: "메일", text: "내 메일 {{주소}}\n\n끝" });
		expect(t.at(-1)).toEqual({ key: "mine", label: "내 앱", text: "내 앱\n\n끝" });
	});

	test("an unreadable override file leaves the shipped set", () => {
		const d = fresh();
		mkdirSync(join(d, "custom"), { recursive: true });
		writeFileSync(join(d, "custom/app-templates.json"), "{ not json");
		expect(readAppTemplates(d)).toHaveLength(7);
	});

	test("the 앱 추가 list holds only the apps switched off here", () => {
		const d = fresh();
		const none = integrationContext(d, []);
		expect(integrationAvailable([], none)).toEqual([]);
		put(d, "custom/apps.json", { kakao: { off: true } });
		expect(integrationAvailable([], integrationContext(d, [])).map(a => a.key)).toEqual(["kakao"]);
	});
});
