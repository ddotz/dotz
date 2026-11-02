import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalOf, ownedWatches } from "./app-features.ts";
import { appEntries } from "./integrations.ts";
import { type ScopeContext, type ScopeWatch, watchScope } from "./watch-scope.ts";
import type { Watch } from "./watch.ts";

// Where a watch is listed: its owner's app, its project, internal housekeeping, or 일반 모니터링 (plain).
const data = mkdtempSync(join(tmpdir(), "watch-scope-"));
afterAll(() => rmSync(data, { recursive: true, force: true }));
mkdirSync(join(data, "custom"), { recursive: true });
writeFileSync(join(data, "custom", "apps.json"), JSON.stringify({ "mail-2": { app: "mail", label: "회사", created: true, filter: { source: "work" } } }));
const ctx = (): ScopeContext => ({ entries: appEntries(data), dataDir: data, projects: { "ch:42": { title: "dotz" } }, setupName: c => (c === "7" ? "까르띠에" : undefined) });
const scope = (w: ScopeWatch) => watchScope({ command: "true", ...w }, ctx());

describe("an owner the watch names", () => {
	test("an app that is live on this install, else the watch falls through", () => {
		expect(scope({ name: "w1", owner: { app: "kakao" } })).toEqual({ scope: "app", app: "kakao" });
		expect(scope({ name: "w1", owner: { app: "nope" } })).toEqual({ scope: "plain" });
	});
	test("a project and internal", () => {
		expect(scope({ name: "w2", owner: { project: "ch:42" } })).toEqual({ scope: "project", project: "ch:42", title: "dotz" });
		expect(scope({ name: "w3", owner: { internal: true } })).toEqual({ scope: "internal" });
	});
});

describe("an app by what the watch does", () => {
	test("the iCloud library check of a mail plugin is the mail app's, with no entry in apps.json", () => {
		const w = { name: "reply-library-icloud", label: "첨부 폴더 iCloud 내려받기", command: "bun '/home/x/.dotz/custom/plugins/score-mail.ts' check" };
		expect(scope(w)).toEqual({ scope: "app", app: "mail" });
		expect(ownedWatches(data, [{ ...w }]).get("mail")).toEqual(["reply-library-icloud"]);
	});
	test("only the default instance takes it, and only when the watch names no other owner", () => {
		expect(scope({ name: "x-webmail-sync" })).toEqual({ scope: "app", app: "mail" });
		expect(scope({ name: "x-webmail-sync", owner: { project: "ch:42" } })).toEqual({ scope: "project", project: "ch:42", title: "dotz" });
	});
	test("a comments sync is the site app's, a kakao one kakao's", () => {
		expect(scope({ name: "site-comments-sync" })).toEqual({ scope: "app", app: "site" });
		expect(scope({ name: "x", label: "카카오 새 메시지" })).toEqual({ scope: "app", app: "kakao" });
	});
});

describe("a project", () => {
	test("a channel monitor takes the project's title, else the setup's name, else 프로젝트", () => {
		expect(scope({ name: "ch-42-1", channels: ["42"] })).toEqual({ scope: "project", project: "ch:42", title: "dotz" });
		expect(scope({ name: "ch-7-1", channels: ["7"] })).toEqual({ scope: "project", project: "ch:7", title: "까르띠에" });
		expect(scope({ name: "ch-9-1", channels: ["9"] })).toEqual({ scope: "project", project: "ch:9", title: "프로젝트" });
	});
	test("a watch working in <data>/projects/<name>/ belongs to that folder", () => {
		expect(scope({ name: "pr-check", cwd: join(data, "projects", "blog") })).toEqual({ scope: "project", project: "blog", title: "blog" });
		expect(scope({ name: "pr-check", command: `bun ${join(data, "projects", "blog", "check.ts")}` })).toEqual({ scope: "project", project: "blog", title: "blog" });
	});
});

describe("internal and plain", () => {
	test("housekeeping by name is internal", () => {
		expect(scope({ name: "omonyang-housekeeping" })).toEqual({ scope: "internal" });
		expect(scope({ name: "x", label: "heartbeat" })).toEqual({ scope: "internal" });
	});
	test("a login keeper with no app and no project, and a standalone check, stay plain", () => {
		expect(scope({ name: "company-login", session: { url: "https://login.company.example/" } })).toEqual({ scope: "plain" });
		expect(scope({ name: "nas-php-node-patch" })).toEqual({ scope: "plain" });
	});
});

describe("an app's file check", () => {
	const w = (name: string, extra: Partial<Watch> = {}) => ({ name, command: "true", every_minutes: 60, state: { fails: 0 }, ...extra }) as unknown as Watch;
	test("reads as 파일 점검, not 동기화", () => {
		expect(internalOf(w("reply-library-icloud", { label: "첨부 폴더 iCloud 내려받기" }), "메일")).toMatchObject({ kind: "files", name: "파일 점검 · 첨부 폴더 iCloud 내려받기" });
		expect(internalOf(w("webmail-naver"), "메일").kind).toBe("sync");
	});
});
