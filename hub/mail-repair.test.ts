// The repair of 답장 안 함 marks without the owner's evidence (hub/mail-repair.ts): the list, its dry run as a CLI on a copied file, and --apply.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredMail } from "./mail-state.ts";
import { applyRepair, unprovenMarks } from "./mail-repair.ts";

const dir = mkdtempSync(join(tmpdir(), "mail-repair-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const at = (d: number) => `2026-10-${String(d).padStart(2, "0")}T01:00:00.000Z`;
const RECORDS = (): StoredMail[] => [
	{ key: "fx-1", subject: "(기관) 자료작성 요청", from: "Kim <kim@example.com>", at: at(27), reply: "skipped", summary: "**할 일** • 5년 예산 세부내역 작성\n• 회신 기한: 화 17시" },
	{ key: "fx-2", subject: "일일 시황", from: "Desk <desk@example.com>", at: at(26), reply: "skipped", summary: "**할 일** • 없음" },
	{ key: "fx-3", subject: "견적 요청", from: "Lee <lee@example.com>", at: at(25), reply: "skipped", reply_by: "owner", reply_at: at(25), summary: "**할 일** • 견적서 작성·회신" },
	{ key: "fx-4", subject: "자문 의견 요청", from: "Park <park@example.com>", at: at(24), reply: "fyi", summary: "**할 일** • 의견 회신" },
	{ key: "fx-5", subject: "Re: 견적", from: "Owner <owner@example.com>", at: at(23), dir: "out" },
	{ key: "fx-6", subject: "회의 안내", from: "Choi <choi@example.com>", at: at(22), reply: "needs", summary: "**할 일** • 참석 여부 회신" },
];

test("lists only the incoming 답장 안 함 without the owner's mark, oldest first, with what the gateway reads now", () => {
	expect(unprovenMarks(RECORDS()).map(r => [r.key, r.reply, r.expected])).toEqual([["fx-4", "fyi", true], ["fx-2", "skipped", false], ["fx-1", "skipped", true]]);
});

test("--apply opens the expected ones as 답장 필요, clears the rest, and never touches an owner's mark", () => {
	const recs = RECORDS();
	expect(applyRepair(recs, unprovenMarks(recs))).toBe(3);
	const by = Object.fromEntries(recs.map(r => [r.key, r.reply]));
	expect(by).toEqual({ "fx-1": "needs", "fx-2": undefined, "fx-3": "skipped", "fx-4": "needs", "fx-5": undefined, "fx-6": "needs" });
	expect(unprovenMarks(recs)).toEqual([]);
});

test("the CLI is a dry run by default: it prints the list and leaves the file as it was", async () => {
	const file = join(dir, "mail-conversations.json");
	const text = `${JSON.stringify(RECORDS(), null, 2)}\n`;
	writeFileSync(file, text);
	const p = Bun.spawn([process.execPath, join(import.meta.dir, "mail-repair.ts"), "--file", file], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	expect(await p.exited).toBe(0);
	expect(out).toContain("fx-1  skipped -> needs");
	expect(out).toContain("fx-2  skipped -> (없음)");
	expect(out).not.toContain("fx-3");
	expect(readFileSync(file, "utf8")).toBe(text);
});
