import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, paths } from "./config.ts";
import { featurePrompt, recipesDir } from "./featuredirs.ts";
import { parseChoices } from "./choices.ts";
import { msg } from "./i18n.ts";
import { bursts, flush, intake } from "./intake.ts";
import { awaiting } from "./outbound.ts";
import { reflectPrompt } from "./reflect.ts";
import { COSTLY_SESSION_BYTES, proposeRecipe, recipeAnswer, recipeBlock } from "./recipes.ts";

const DAY = 24 * 3600_000;
const NOW = Date.now();
const dir = recipesDir(DATA_DIR);
const [SAVE, SKIP] = msg().recipeOptions.map((o, i) => `${i + 1}) ${o.name}`) as [string, string];
const draft = { slug: "weekly-report", name: "Weekly report", when: "when the weekly report is asked", body: "1. Fetch the sheet\n2. Fill the template" };

function lane(name: string, title: string, over: Record<string, unknown> = {}): void {
	mkdirSync(join(paths.lanes, name), { recursive: true });
	writeFileSync(join(paths.lanes, name, "lane.json"), JSON.stringify({ name, title, status: "exited", endedAt: new Date(NOW - DAY).toISOString(), claim: { state: "verified" }, ...over }));
}
const twoReports = () => {
	lane("report-a", "주간 매출 보고서 작성");
	lane("report-b", "주간 매출 보고서 정리");
};
const idIn = (block: string): string => /recipes\.ts propose (\S+)/.exec(block)![1]!;
function proposed(now = NOW): void {
	twoReports();
	proposeRecipe(idIn(recipeBlock(now)), draft, now);
}

afterEach(() => {
	for (const p of [paths.lanes, dir, paths.recipeChoices]) rmSync(p, { recursive: true, force: true });
});

test("a night with no candidate adds nothing to the reflection and keeps no state", () => {
	expect(recipeBlock(NOW)).toBe("");
	lane("lone", "주간 매출 보고서 작성");
	lane("failed-a", "분기 비용 정리 작성", { claim: { state: "reported" } });
	lane("failed-b", "분기 비용 정리 검토", { claim: undefined });
	lane("old-a", "월간 회의록 요약", { endedAt: new Date(NOW - 9 * DAY).toISOString() });
	lane("old-b", "월간 회의록 정리", { endedAt: new Date(NOW - 9 * DAY).toISOString() });
	expect(recipeBlock(NOW)).toBe("");
	expect(existsSync(paths.recipeChoices)).toBe(false);
	expect(reflectPrompt("digest", NOW, [], recipeBlock(NOW))).toBe(reflectPrompt("digest", NOW, []));
});

test("the same task shape twice is one candidate; a costly lone success is one too; one night hands over at most one", () => {
	twoReports();
	lane("costly", "서버 이전 작업", { sessionFile: join(paths.lanes, "costly", "s.jsonl") });
	writeFileSync(join(paths.lanes, "costly", "s.jsonl"), "");
	truncateSync(join(paths.lanes, "costly", "s.jsonl"), COSTLY_SESSION_BYTES);
	const first = recipeBlock(NOW);
	expect(first).toContain("주간 매출 보고서");
	expect(first).toContain(join(paths.lanes, "report-a", "brief.md"));
	expect(first).not.toContain("서버 이전");
	expect(recipeBlock(NOW + 60_000)).toBe("");
	expect(recipeBlock(NOW + DAY)).toContain("서버 이전");
});

test("a saved recipe lands in the install layer only after the save choice, and nothing runs or watches", () => {
	proposed();
	const watches = existsSync(paths.watches) ? readFileSync(paths.watches, "utf8") : undefined;
	expect(existsSync(dir)).toBe(false);
	expect(recipeAnswer("레시피를 저장하는 법이 뭐야?", NOW)).toBeUndefined();
	expect(existsSync(dir)).toBe(false);
	expect(recipeAnswer(SAVE, NOW)).toContain("weekly-report");
	expect(readFileSync(join(dir, "weekly-report", "recipe.md"), "utf8")).toContain("2. Fill the template");
	expect(existsSync(paths.watches) ? readFileSync(paths.watches, "utf8") : undefined).toBe(watches);
	expect(JSON.stringify(JSON.parse(readFileSync(paths.recipeChoices, "utf8")))).not.toContain("Fill the template");
	expect(recipeAnswer(SAVE, NOW)).toBeUndefined();
});

test("a script travels with the recipe, runnable by hand only", () => {
	twoReports();
	proposeRecipe(idIn(recipeBlock(NOW)), { ...draft, script: { file: "fetch.sh", text: "#!/bin/sh\necho hi\n" } }, NOW);
	expect(existsSync(dir)).toBe(false);
	recipeAnswer(SAVE, NOW);
	expect(readdirSync(join(dir, "weekly-report")).sort()).toEqual(["fetch.sh", "recipe.md"]);
});

test("a skip stores nothing and the same shape is not proposed again, even from new work", () => {
	proposed();
	expect(recipeAnswer(SKIP, NOW)).toBeString();
	expect(existsSync(dir)).toBe(false);
	lane("report-c", "주간 매출 보고서 검토", { endedAt: new Date(NOW + DAY).toISOString() });
	lane("report-d", "주간 매출 보고서 보완", { endedAt: new Date(NOW + DAY).toISOString() });
	for (const n of [1, 2, 40]) expect(recipeBlock(NOW + n * DAY)).toBe("");
});

test("an open card holds the next candidate back for its week, and the turn cannot propose what it was not handed", () => {
	proposed();
	const later = { endedAt: new Date(NOW + 6 * DAY).toISOString() };
	lane("other-a", "분기 비용 정리 작성", later);
	lane("other-b", "분기 비용 정리 검토", later);
	expect(recipeBlock(NOW + DAY)).toBe("");
	expect(() => proposeRecipe("nope", draft, NOW)).toThrow();
	expect(() => proposeRecipe(JSON.parse(readFileSync(paths.recipeChoices, "utf8"))[0].id, draft, NOW)).toThrow();
	expect(recipeBlock(NOW + 7 * DAY)).toContain("분기 비용");
});

test("a code fence cut by the card's preview keeps the card's buttons", () => {
	twoReports();
	const body = `\`\`\`sh\n${"echo step\n".repeat(80)}\`\`\``;
	const card = proposeRecipe(idIn(recipeBlock(NOW)), { ...draft, body }, NOW);
	expect(parseChoices(card).options.map(o => o.label)).toEqual(msg().recipeOptions.map(o => o.name));
});

test("a newer card closes an older unanswered one, so the owner's answer can only reach the card it was given on", () => {
	proposed();
	const later = { endedAt: new Date(NOW + 6 * DAY).toISOString() };
	lane("other-a", "분기 비용 정리 작성", later);
	lane("other-b", "분기 비용 정리 검토", later);
	const at = NOW + 8 * DAY;
	proposeRecipe(idIn(recipeBlock(at)), { ...draft, slug: "quarter-costs" }, at);
	expect(recipeAnswer(SAVE, at)).toContain("quarter-costs");
	expect(recipeAnswer(SKIP, at)).toBeUndefined();
	expect(readdirSync(dir)).toEqual(["quarter-costs"]);
});

test("a recipe already saved under the slug is not overwritten by a later save", () => {
	proposed();
	mkdirSync(join(dir, "weekly-report"), { recursive: true });
	writeFileSync(join(dir, "weekly-report", "recipe.md"), "mine");
	expect(recipeAnswer(SAVE, NOW)).toContain("weekly-report");
	expect(readFileSync(join(dir, "weekly-report", "recipe.md"), "utf8")).toBe("mine");
});

test("a bad draft is refused before the owner sees a card", () => {
	twoReports();
	const id = idIn(recipeBlock(NOW));
	expect(() => proposeRecipe(id, { ...draft, slug: "../escape" }, NOW)).toThrow();
	expect(() => proposeRecipe(id, { ...draft, script: { file: "../x.sh", text: "x" } }, NOW)).toThrow();
	expect(() => proposeRecipe(id, { ...draft, when: "two\nlines" }, NOW)).toThrow();
	expect(() => proposeRecipe(id, { ...draft, script: { file: "RECIPE.md", text: "x" } }, NOW)).toThrow();
	expect(proposeRecipe(id, draft, NOW)).toContain(msg().recipeOptions[0].name);
});

test("later work finds a saved recipe by name and path in the prompt, at a bounded size, and no recipe costs nothing", () => {
	const before = featurePrompt(DATA_DIR, "lanes");
	expect(before).not.toContain("recipes");
	proposed();
	expect(featurePrompt(DATA_DIR, "lanes")).toBe(before);
	recipeAnswer(SAVE, NOW);
	const index = featurePrompt(DATA_DIR, "orchestrator");
	expect(index).toContain(`${dir}`);
	expect(index).toContain("weekly-report: Weekly report: when the weekly report is asked");
	expect(index).not.toContain("Fill the template");
	for (let i = 0; i < 40; i++) {
		mkdirSync(join(dir, `r${i}`), { recursive: true });
		writeFileSync(join(dir, `r${i}`, "recipe.md"), `---\nname: ${"n".repeat(40)}\nwhen: ${"w".repeat(120)}\n---\nbody`);
	}
	const full = featurePrompt(DATA_DIR, "lanes");
	expect(full.length - before.length).toBeLessThan(1000);
	expect(full).toMatch(/\+\d+ more/);
});

test("the owner's answer is settled by the gateway with no model turn", async () => {
	proposed();
	intake({ kind: "message", channel: "web", text: SAVE }, "web", "ask-1");
	expect(bursts.has("web")).toBe(true);
	flush("web");
	expect(existsSync(join(dir, "weekly-report", "recipe.md"))).toBe(true);
	expect(awaiting.get("web") ?? []).toEqual([]);
});
