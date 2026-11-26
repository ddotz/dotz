import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeSettings } from "../../../hub/app-settings.ts";
import { runDraft } from "../bin/draft.ts";
import { draftRules } from "../lib/draft-rules.ts";
import { readLedger } from "../lib/ledger.ts";
import { paths, toneFile } from "../lib/settings.ts";
import { enable, seedRules, setupEnv } from "./helpers.ts";

// The rules that apply to one target, read-only and with where each comes from (draft-rules.ts `effective`, `draft.ts tone --effective`). Names are placeholders.
const env = setupEnv();
afterAll(env.cleanup);
const MAILBOXES = () => join(env.dir, "custom", "mailboxes.json");
const lineIn = (file: string, text: string): number => readFileSync(file, "utf8").split("\n").findIndex(l => l.includes(text)) + 1;
const idOf = (text: string): string => readLedger().find(r => r.state === "on" && r.text === text)!.id;
const tone = (file: string, text: string) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));
const AT = { app: "mail", box: "b-a", instance: "mail" };
const ITEM = { kind: "mail", from: "Kim <a@example.com>", text: "일정 문의" } as const;

beforeEach(() => {
	for (const p of [paths.config(), paths.toneDir(), paths.ledger(), MAILBOXES()]) rmSync(p, { force: true, recursive: true });
	enable(env);
	mkdirSync(join(env.dir, "custom"), { recursive: true });
	const box = { id: "b-a", name: "메일함A", mode: "auto", conds: { from: ["@example.com"], subj: [], body: [], src: [] }, how: "일정은 날짜부터 적어요", bans: ["죄송"] };
	writeFileSync(MAILBOXES(), JSON.stringify({ rev: 1, accounts: { mail: { boxes: [{ id: "base", name: "일반", base: true }, box] } }, pins: {} }, null, 1));
	writeSettings(env.dir, "mail", { draft_default: "끝에 감사합니다로 마무리해요" });
	seedRules({ app: "mail" }, { tone: ["짧게 써요", "존댓말로 써요"], ban: ["감사합니다"] });
	// A mailbox reads its own profile once it has one (a learned voice); its rules are the ledger's.
	tone(toneFile({ app: "mail", room: "b-a" }), "## 정체성\n\n- 짧게 쓰는 사람이에요\n");
	seedRules({ app: "mail", room: "b-a" }, { tone: ["존댓말로 써요"], correction: ["2030-01-01: 인사는 생략해요"] });
	seedRules({ app: "mail", to: "a@example.com" }, { ban: ["확인해 볼게요"] });
});

test("a target's rules come with their scope, kind and where each is written (ledger id or file:line), narrowest scopes last", async () => {
	const { rules } = await draftRules(AT, ITEM).effective();
	const at = (file: string, text: string) => ({ file, line: lineIn(file, text) });
	const ledger = (text: string) => ({ file: paths.ledger(), id: idOf(text) });
	expect(rules).toEqual([
		{ text: "짧게 써요", kind: "tone", scope: "channel", source: ledger("짧게 써요") },
		{ text: "존댓말로 써요", kind: "tone", scope: "channel", source: { file: paths.ledger(), id: readLedger().find(r => r.text === "존댓말로 써요" && r.scope.room === undefined)!.id } },
		{ text: "감사합니다", kind: "ban", scope: "channel", source: ledger("감사합니다") },
		{ text: "끝에 감사합니다로 마무리해요", kind: "instruction", scope: "mail-app", source: ledger("끝에 감사합니다로 마무리해요") },
		{ text: "존댓말로 써요", kind: "tone", scope: "mailbox", source: { file: paths.ledger(), id: readLedger().find(r => r.text === "존댓말로 써요" && r.scope.room === "b-a")!.id } },
		{ text: "2030-01-01: 인사는 생략해요", kind: "tone", scope: "mailbox", source: ledger("2030-01-01: 인사는 생략해요") },
		{ text: "죄송", kind: "ban", scope: "mailbox", source: at(MAILBOXES(), "죄송") },
		{ text: "일정은 날짜부터 적어요", kind: "instruction", scope: "mailbox", source: at(MAILBOXES(), "날짜부터") },
		{ text: "확인해 볼게요", kind: "ban", scope: "recipient", source: ledger("확인해 볼게요") },
	]);
});

test("a line copied to two scopes and a ban its own target's instruction uses are conflicts", async () => {
	const { rules, conflicts } = await draftRules(AT, ITEM).effective();
	const i = (text: string, scope: string) => rules.findIndex(r => r.text === text && r.scope === scope);
	// The narrower scope wins a copy; of the ban and the instruction that holds it (one scope) the newer one does.
	expect(conflicts).toEqual([
		{ a: i("존댓말로 써요", "channel"), b: i("존댓말로 써요", "mailbox"), why: "copy", winner: i("존댓말로 써요", "mailbox") },
		{ a: i("감사합니다", "channel"), b: i("끝에 감사합니다로 마무리해요", "mail-app"), why: "ban-in-rule", winner: i("끝에 감사합니다로 마무리해요", "mail-app") },
	]);
});

test("the matching draft rule's 어떻게 is a request-kind instruction of the target", async () => {
	writeSettings(env.dir, "mail", { draft_rules: [{ id: "r1", name: "자료 요청", when: "자료를 보내 달라는 메일", how: "자료를 첨부해요", files: [] }] });
	const { rules } = await draftRules({ ...AT, box: undefined, rule: { id: "r1", name: "자료 요청" } }, ITEM).effective();
	expect(rules.at(-1)).toEqual({ text: "자료를 첨부해요", kind: "instruction", scope: "request-kind", source: { file: paths.ledger() } });
});

test("tone --effective prints one line per rule with its scope, kind and file:line, then the conflicts", async () => {
	const r = await runDraft(["tone", "--effective", "--app", "mail", "--box", "b-a", "--to", "a@example.com"], "");
	expect(r.code).toBe(0);
	expect(r.lines).toContain(`3. [channel] 금지 감사합니다 (${paths.ledger()})`);
	expect(r.lines.some(l => l.startsWith("9. [recipient] 금지 확인해 볼게요 ("))).toBe(true);
	expect(r.lines.filter(l => l.startsWith("충돌 "))).toEqual(["충돌 2↔5: 같은 문장이 다른 범위에도 있어요", "충돌 3↔4: 금지 표현이 같은 대상의 말투·지시 안에 들어 있어요"]);
});

test("tone files and settings keys of a mail app that is not in the app list are marked 읽는 초안 없음, in both views", async () => {
	tone(toneFile({ app: "mail-ghost" }), "## 말투\n\n- 유령 규칙\n");
	tone(toneFile({ app: "mail-ghost", room: "b-x" }), "## 말투\n\n- 유령 메일함 규칙\n");
	seedRules({ app: "mail-ghost" }, { instruction: ["유령 지시"] });
	writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ "mail-real": { app: "mail" } }));
	const note = (what: string, where: string) => `읽는 초안 없음: ${what} (${where}) - 앱 목록에 mail-ghost이(가) 없어요`;
	const marks = [note("말투 파일", toneFile({ app: "mail-ghost" })), note("말투 파일", toneFile({ app: "mail-ghost", room: "b-x" })), note("답장 규칙", paths.ledger())];
	for (const args of [["tone", "--app", "mail"], ["tone", "--effective", "--app", "mail"]]) expect((await runDraft(args, "")).lines.filter(l => l.startsWith("읽는 초안 없음"))).toEqual(marks);
	rmSync(join(env.dir, "custom", "apps.json"));
});

test("a 금지 line with the 내용: marker is listed as a content ban", async () => {
	tone(toneFile({ app: "mail", room: "b-a" }), "## 금지\n\n- 내용: 용도를 묻지 않기\n");
	const { rules } = await draftRules(AT, ITEM).effective();
	expect(rules.filter(r => r.kind === "content-ban").map(r => ({ text: r.text, scope: r.scope }))).toEqual([{ text: "내용: 용도를 묻지 않기", scope: "mailbox" }]);
});
