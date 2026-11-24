import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { compose, type Deps, type DoctorStore, loadStore, runMorning, storeFile } from "./doctor.ts";
import { gateway } from "./doctor-checks.ts";
import type { Finding } from "./doctor-types.ts";
import { msg } from "./i18n.ts";
import { promptHealth } from "./prompt-health.ts";
import { promptReviewCheck, reviewCard, reviewDeps } from "./prompt-review.ts";

const H = 3600e3, T0 = Date.parse("2026-11-24T08:00:00Z");
const saved = cfg.identity;
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-morning-truth-"));
	cfg.identity = { ...saved, name: saved?.name ?? "sample-1", language: "ko" };
});
afterEach(() => {
	cfg.identity = saved;
	rmSync(dir, { recursive: true, force: true });
});
const logLine = (at: number, text: string) => `${new Date(at).toISOString()} ${text}\n`;
const rig = (checks: Deps["checks"]) => {
	const sent: string[] = [];
	const deps: Deps = { now: () => T0, dataDir: dir, home: dir, at: () => "auto", checks, send: text => void sent.push(text), log: () => undefined };
	return { sent, deps };
};
const stored = (findings: Finding[]) => writeFileSync(storeFile(dir), JSON.stringify({ version: 1, lastRun: T0 - 3.5 * H, from: T0 - 27.5 * H, memo: {}, findings: Object.fromEntries(findings.map(f => [f.key, f])), told: {} }));
const engineRestart = (h: number, i: number) =>
	logLine(T0 - h * H, `omo engine changed on disk (omo-ai@5.1.${69 + i} senpi@2026.11.10-2 -> omo-ai@5.1.${70 + i} senpi@2026.11.13); restarting the gateway at the next idle point: gateway restarting`) + logLine(T0 - h * H + 5e3, "gateway restart (1 request(s) coalesced, waited 5s)");

test("an engine change as the engine watch logs it (two packages a side, a space between them) is said in the owner's language", async () => {
	writeFileSync(join(dir, "hub.log"), [10, 7, 3].map(engineRestart).join(""));
	const [f] = await gateway({ now: T0, dataDir: dir, home: dir, memo: {} });
	expect(f!.evidence[1]).toBe(`${msg().doctor.when(T0 - 10 * H + 5e3)} · 작업 프로그램(OmO) 엔진이 바뀌었어요 (omo-ai@5.1.69 senpi@2026.11.10-2 → omo-ai@5.1.70 senpi@2026.11.13)`);
});

test("restarts that all have a known cause are told without the look-up mark; one unknown restart among them brings it back", async () => {
	const t = msg().doctor, told = async (log: string) => {
		writeFileSync(join(dir, "hub.log"), log);
		const findings = await gateway({ now: T0, dataDir: dir, home: dir, memo: {} });
		const store: DoctorStore = { version: 1, lastRun: T0, memo: {}, findings: Object.fromEntries(findings.map(f => [f.key, f])), told: {} };
		return compose(store, T0)!.text.split("\n").find(l => l.startsWith("- "))!;
	};
	const known = [10, 7, 3].map(engineRestart).join("");
	expect(await told(known)).toBe("- 하루 사이에 게이트웨이가 3번 다시 시작했고, 모두 이유를 알아요.");
	expect(await told(known + logLine(T0 - H, "gateway restart (1 request(s) coalesced, waited 5s)"))).toBe(`- 하루 사이에 게이트웨이가 4번 다시 시작했고, 그중 1번은 이유를 몰라요.${t.look}`);
});

test("the weekly review's line about proposals it could not place is still told after the morning re-look, with no model call", async () => {
	const unplaced: Finding = { key: "prompt:unplaced", area: "prompt", what: msg().promptReviewUnplaced(2), evidence: [], since: T0 - 3.5 * H, level: 2 };
	stored([unplaced]);
	const call = reviewDeps.call;
	let calls = 0;
	reviewDeps.call = (async () => {
		calls++;
		throw new Error("no model call in the morning");
	}) as typeof reviewDeps.call;
	try {
		const r = rig([promptHealth, promptReviewCheck]);
		await runMorning(r.deps);
		expect(calls).toBe(0);
		expect(r.sent.join("\n")).toContain(msg().promptReviewUnplaced(2));
		expect(Object.keys(loadStore(dir).findings)).toEqual(["prompt:unplaced"]);
	} finally {
		reviewDeps.call = call;
	}
});

test("a review proposal whose file cannot be read does not stop the morning: the proposal is kept and asked", async () => {
	const file = join(dir, "RULES.md"), from = "- 답장은 짧게 써요.";
	writeFileSync(file, `${from}\n`);
	const review: Finding = { key: "prompt:review:abc", area: "prompt", what: "REVIEW-WHAT", evidence: [], since: T0 - 3.5 * H, level: 1, decide: { subject: "REVIEW-CARD", question: "고칠까요?", options: [{ name: "A", result: "RA" }, { name: "B", result: "RB", keep: true }] }, change: { file, line: 1, from, to: "- 답장은 길게 써요." } };
	stored([review]);
	chmodSync(file, 0o000);
	const r = rig([promptReviewCheck]);
	try {
		await runMorning(r.deps);
	} finally {
		chmodSync(file, 0o644);
	}
	expect(r.sent.join("\n")).toContain("REVIEW-CARD");
});

test("a conflict card whose line changes in more places than fit keeps the line it conflicts with, and its first line counts the places left", () => {
	const words = Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(2, "0")}`), from = `- ${words.join(" ")}`;
	const to = `- ${words.map((w, i) => ([5, 25, 45].includes(i) ? String.fromCharCode(65 + i / 5).repeat(45) : w)).join(" ")}`;
	const m = msg(), card = reviewCard({ kind: "conflict", shown: "RULES.md", change: { file: join(dir, "RULES.md"), line: 1, from, to }, other: { shown: "LESSONS.md", line: 3, text: "OTHER-LINE" }, why: "WHY" });
	expect(card.evidence).toHaveLength(4);
	expect(card.evidence[0]!.endsWith(` · ${m.promptMoreChanges(2)}`)).toBe(true);
	expect(card.evidence[3]).toContain("OTHER-LINE");
	expect(card.evidence.every(l => [...l].length <= 120)).toBe(true);
});
