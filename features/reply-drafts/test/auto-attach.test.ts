import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachIssues } from "../../../hub/attach-check.ts";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import { claimsAttachment } from "../../../hub/attach-claim.ts";
import { asksForFile } from "../../../hub/draft-approval.ts";
import { keywords } from "../lib/library.ts";
import { stagedFiles } from "../lib/staged.ts";
import { enable, setupEnv } from "./helpers.ts";

const env = setupEnv();
const songs = mkdtempSync(join(tmpdir(), "rd-auto-attach-"));
afterAll(() => {
	env.cleanup();
	rmSync(songs, { recursive: true, force: true });
});
for (const [dir, name] of [["Orbit 오빗/문서", "Orbit 공개본.pdf"], ["Nova 노바/문서", "노바 공개본.pdf"], ["Nova 노바/문서", "노바 내부용.pdf".normalize("NFD")], ["Orbit 오빗/문서", "Orbit 내부용 brief.pdf"], ["Orbit 오빗/소리", "오빗Orbit_내부용.mp3"], ["Comet 혜성/소리", "혜성_내부용.mp3"]]) {
	mkdirSync(join(songs, dir!), { recursive: true });
	writeFileSync(join(songs, dir!, name!), "bytes");
}
const rulesFile = () => join(env.dir, "custom", "reply-drafts", "auto-attach.json");
const setRules = (rules: unknown) => writeFileSync(rulesFile(), typeof rules === "string" ? rules : JSON.stringify(rules));
beforeEach(() => {
	rmSync(rulesFile(), { force: true });
	enable(env, { attachFolders: { mail: songs } });
});

const spec = { app: "mail", to: "kim@example.com", subject: "자료 보내드려요", body: "안녕하세요. 자료 보내드립니다." };
const compose = async (more: { fromLibrary: string; request?: string }) => {
	const r = await realMailLink({}).compose({ ...spec, ...more });
	if (!r.ok) throw new Error(r.reason);
	return { names: stagedFiles(r.id).map(f => f.name).sort(), notes: r.notes, libraryMiss: r.libraryMiss };
};

describe("files withheld from automatic mail drafts", () => {
	test("a default install withholds nothing and narrows nothing", async () => {
		const { names } = await compose({ fromLibrary: "Orbit 오빗 내부용 brief 공개본", request: "샀어요" });
		expect(names).toEqual(["Orbit 내부용 brief.pdf"]);
	});

	test("a configured install withholds a file whose path matches; another pattern still lets the audio through", async () => {
		setRules({ withhold: ["내부용"] });
		expect((await compose({ fromLibrary: "Orbit 오빗 내부용 brief 공개본" })).names).toEqual(["Orbit 공개본.pdf"]);
		setRules({ withhold: ["^(?!.*\\.mp3$).*내부용"] });
		expect((await compose({ fromLibrary: "Orbit 오빗 내부용 brief 공개본" })).names).toEqual(["Orbit 공개본.pdf", "오빗Orbit_내부용.mp3"].sort());
	});

	test("the install's narrowing rule takes only its files of one work, or nothing and the install's own note", async () => {
		const narrow = { when: ["샀어요"], only: "\\.mp3$", note: "확인 필요: 소리 파일만 붙이는데 찾지 못했어요" };
		setRules({ narrow });
		expect((await compose({ fromLibrary: "Orbit 오빗 샀어요", request: "Orbit 샀어요" })).names).toEqual(["오빗Orbit_내부용.mp3"]);
		expect((await compose({ fromLibrary: "Orbit 오빗 샀어요" })).names.length).toBeGreaterThan(1);
		const unsure = await compose({ fromLibrary: "내부용 샀어요", request: "내부용 샀어요" });
		expect(unsure.names).toEqual([]);
		expect(unsure.notes).toEqual([narrow.note]);
		expect(unsure.libraryMiss).toBe(true);
	});

	test("a file name stored decomposed, as a Mac can, is matched like any other", async () => {
		setRules({ withhold: ["내부용"] });
		expect((await compose({ fromLibrary: "Nova 노바 내부용 공개본" })).names).toEqual(["노바 공개본.pdf"]);
	});

	test.each([["not json", "{"], ["a misspelled key", { withold: ["내부용"] }], ["a narrow of the wrong type", { narrow: 0 }], ["a bad pattern", { withhold: ["("] }], ["a wrong shape", { narrow: { when: "샀어요", only: "x" } }]])("%s attaches nothing and says so", async (_, bad) => {
		setRules(bad);
		const { names, notes, libraryMiss } = await compose({ fromLibrary: "Orbit 오빗 공개본" });
		expect(names).toEqual([]);
		expect(notes.join(" ")).toContain("auto-attach.json");
		expect(libraryMiss).toBeFalsy();
	});
});

describe("the install's own file words", () => {
	test("a default install does not know them; a configured one treats them as a document", () => {
		const check = { subject: "Re: 문의", body: "쿼크본 보내드립니다.", files: [] };
		expect(asksForFile("쿼크본 부탁드립니다")).toBe(false);
		expect(claimsAttachment("쿼크본 보내드립니다")).toBe(false);
		expect(attachIssues(check)).toEqual([]);
		setRules({ fileWords: ["쿼크본"] });
		expect(asksForFile("쿼크본 부탁드립니다")).toBe(true);
		expect(claimsAttachment("쿼크본 보내드립니다")).toBe(true);
		expect(attachIssues(check).map(i => i.kind)).toEqual(["missing"]);
	});

	test("a file word in a name ties the file to nothing", () => {
		const check = { subject: "자료", body: "쿼크본 보내드립니다.", files: ["쿼크본 alpha.pdf", "other beta.pdf"] };
		expect(attachIssues(check).map(i => i.kind)).toEqual(["unrelated"]);
		setRules({ fileWords: ["쿼크본"] });
		expect(attachIssues(check)).toEqual([]);
	});

	test("a sound word of the install counts as audio, and a default install knows it as nothing", () => {
		const check = { subject: "자료", body: "쿼크음 보내드립니다.", files: ["alpha.pdf"] };
		expect(asksForFile("쿼크음 부탁드립니다")).toBe(false);
		expect(attachIssues(check)).toEqual([]);
		setRules({ audioWords: ["쿼크음"] });
		expect(asksForFile("쿼크음 부탁드립니다")).toBe(true);
		expect(attachIssues(check).map(i => i.kind)).toContain("partial");
	});

	test("a Latin word matches whole, at a sentence end too; a two-letter one stays clear of an abbreviation", () => {
		expect(asksForFile("Could you send the zine.")).toBe(false);
		setRules({ fileWords: ["zine"], audioWords: ["qx"] });
		expect(asksForFile("Could you send the zine.")).toBe(true);
		expect(asksForFile("Could you send the zines?")).toBe(true);
		expect(claimsAttachment("I'm sending the zines")).toBe(true);
		expect(asksForFile("magazines 부탁드립니다")).toBe(false);
		expect(claimsAttachment("Qx 보내드립니다")).toBe(true);
		expect(claimsAttachment("Qx. Kim 보내드립니다")).toBe(false);
		expect(claimsAttachment("Here's Qx Kim's address")).toBe(false);
	});

	test("a noise word in a name ties the file to nothing, and it is no file word", () => {
		const check = { subject: "자료", body: "쿼크회 파일 보내드립니다.", files: ["쿼크회 alpha.pdf", "other beta.pdf"] };
		expect(attachIssues(check).map(i => i.kind)).toEqual(["unrelated"]);
		setRules({ noiseWords: ["쿼크회"] });
		expect(attachIssues(check)).toEqual([]);
		expect(asksForFile("쿼크회 부탁드립니다")).toBe(false);
	});

	test("a generic word of the install ranks no library file", () => {
		expect(keywords("쿼크본 alpha")).toEqual(["쿼크본", "alpha"]);
		setRules({ genericWords: ["쿼크본"] });
		expect(keywords("쿼크본 alpha")).toEqual(["alpha"]);
	});
});

// Sends the check refused on a partner install (2026-11-05..13), with that install's own words: each case's draft, files and received mail as they
// were at the refusal, and the verdict it should have had.
describe("real refusals of the attach check", () => {
	const real = JSON.parse(readFileSync(join(import.meta.dir, "attach-refusals.fixture.json"), "utf8")) as { rules: unknown; cases: (Parameters<typeof attachIssues>[0] & { id: string; verdict: string[] })[] };
	const byId = (id: string) => real.cases.find(c => c.id === id)!;

	for (const c of real.cases)
		test(`${c.id}: ${c.verdict.join(", ") || "sent"}`, () => {
			setRules(real.rules);
			expect(attachIssues(c).map(i => i.kind)).toEqual(c.verdict);
		});

	test("the same drafts without the file their words promise still refuse", () => {
		setRules(real.rules);
		const mr = byId("R4HJZKL"), parts = byId("RPHEZPT");
		expect(attachIssues({ ...mr, files: mr.files.filter(f => !f.endsWith(".mp3")) }).map(i => i.kind)).toEqual(["partial"]);
		expect(attachIssues({ ...parts, files: parts.files.filter(f => !f.endsWith(".mp3")) }).map(i => i.kind)).toEqual(["partial"]);
		expect(attachIssues({ ...parts, files: [...parts.files, "다른곡 배경 MR.mp3"] }).map(i => i.kind)).toEqual(["unrelated"]);
	});
});
