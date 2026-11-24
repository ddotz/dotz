import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCTOR_LOOK_EN, DOCTOR_LOOK_KO, doctorEn, doctorKo, doctorLookAsk, isDoctorLook } from "./doctor-text.ts";
import { diskReader, loadCatalog } from "./web-i18n.ts";

type Line = { text: string; look: boolean; hint: boolean; sub: boolean; subs: string[] };
type Split = { doctor: boolean; head: string; lines: Line[] };
type Web = { dlSplit: (text: string, wk?: string) => Split; dlReply: (head: string, line: string, subs?: string[]) => string };

const web = join(import.meta.dir, "../web");
const src = (f: string) => readFileSync(join(web, "js", f), "utf8");
const page = (lang: "ko" | "en"): Web =>
	new Function(`const I18N_LANG = ${JSON.stringify(lang)}, I18N = ${JSON.stringify(loadCatalog(lang, diskReader(web)))};\n${src("00-i18n.js")}\n${src("11-doctor-look.js")}\nreturn { dlSplit, dlReply };`)() as Web;

const LANGS = [
	{ lang: "ko", t: doctorKo, mark: DOCTOR_LOOK_KO, day: "11월 24일", web: page("ko") },
	{ lang: "en", t: doctorEn, mark: DOCTOR_LOOK_EN, day: "November 24", web: page("en") },
] as const;

for (const { lang, t, mark, day, web: w } of LANGS) {
	const restarted = t.restarts({ all: 5, update: 2, owner: 1, orchestrator: 1, unexplained: 1 }), watch = t.watchFailing("Sample-2", 6, day), stuck = `${t.sessionsStuck("sample", 1, 3)} ${t.todo.sessions}`;
	const subs = [t.restartLine(day, t.restartUnasked), `${t.lastReason("2번 페이지를 열지 못했어요")}${mark}`, t.subMore(2)];
	const withSubs = [`${t.head(day)} · ${t.told(2)}`, t.toldPart, `- ${restarted}${mark}`, ...subs.map(s => `  - ${s}`), `- ${stuck}`, `  - ${t.lastReason(t.lookHint)}`, t.lookHint].join("\n");
	const message = [`${t.head(day)} · ${t.told(3)} · ${t.decide(1)}`, t.toldPart, `- ${restarted}${mark}`, `- ${stuck}`, `- ${watch}${mark}`, t.lookHint, t.healthy(["disk"])].join("\n");
	const looks = (s: Split) => s.lines.filter(l => l.look).map(l => l.text);
	const hints = (s: Split) => s.lines.filter(l => l.hint).map(l => l.text);

	describe(`${lang}: the lines of a doctor message with and without a button`, () => {
		test("a told line that ends with the mark has a button, its text without the mark; a line without the mark has none", () => {
			const s = w.dlSplit(message, "doctor");
			expect(s.doctor).toBe(true);
			expect(looks(s)).toEqual([restarted, watch]);
			expect(s.lines.find(l => l.text === `- ${stuck}`)?.look).toBe(false);
		});

		test("the hint line the hub writes is the one hint line", () => {
			expect(hints(w.dlSplit(message, "doctor"))).toEqual([t.lookHint]);
		});

		test("a doctor message is known by its lead when the event carries no kind (a notice, an older post)", () => {
			expect(looks(w.dlSplit(message))).toEqual([restarted, watch]);
			expect(looks(w.dlSplit(`[fail] ${message}`))).toEqual([restarted, watch]);
		});

		test("a card's notice holds its evidence first and the message after a blank line: the lead there is the doctor's, the date read from it", () => {
			const s = w.dlSplit(`Sample evidence 9 GB\n\n${message}`);
			expect([s.doctor, s.head, looks(s)]).toEqual([true, day, [restarted, watch]]);
		});

		test("the lead inside a paragraph, not at its start, does not make a message the doctor's", () => {
			const s = w.dlSplit(`Backup done\n${message}`);
			expect([s.doctor, looks(s), hints(s)]).toEqual([false, [], []]);
		});

		test("the mark in the middle of a line is no button", () => {
			const mid = [`${t.head(day)} · ${t.told(1)}`, t.toldPart, `- ${restarted}${mark} ${watch}`].join("\n");
			expect(looks(w.dlSplit(mid, "doctor"))).toEqual([]);
		});

		test("a message that is not the doctor's is never changed, even with lines that end with the mark", () => {
			const other = message.replace(t.head(day), "Backup done");
			const s = w.dlSplit(other);
			expect(s.doctor).toBe(false);
			expect(looks(s)).toEqual([]);
			expect(hints(s)).toEqual([]);
			expect(s.lines.map(l => l.text)).toEqual(other.split("\n"));
		});

		test("the reply quotes the told line with its numbers and asks for the cause, with the message's date", () => {
			const reply = w.dlReply(w.dlSplit(message, "doctor").head, restarted);
			expect(reply).toContain(restarted);
			expect(reply).toContain(day);
			expect(reply).toContain("5");
			expect(reply).not.toContain(mark.trim());
			expect(reply).toBe(lang === "ko" ? `${day} 닥터 점검에서 알린 이 일의 원인을 찾아봐 주세요: ${restarted}` : `Please find the cause of this item from the ${day} doctor check: ${restarted}`);
		});

		test("the reply the web sends is the hub's look-up request of the same language, so the hub never takes it for an answer to an open card", () => {
			fc.assert(fc.property(fc.string({ unit: fc.constantFrom("a", "1", " ", "·", "'", "가", "%", "번", ")") }).filter(s => !!s.trim()), s => {
				const line = `${restarted} ${s}`.trim();
				expect(w.dlReply(day, line)).toBe(doctorLookAsk[lang](day, line));
				expect(isDoctorLook(w.dlReply(day, line))).toBe(true);
			}));
		});

		test("a sub-line is no told line: it gets no button and no hint, even with the mark at its end, and belongs to the headline above it", () => {
			const s = w.dlSplit(withSubs, "doctor");
			expect(looks(s)).toEqual([restarted]);
			expect(s.lines.filter(l => l.sub).map(l => l.text.trim())).toEqual([...subs, t.lastReason(t.lookHint)].map(x => `- ${x}`));
			expect(s.lines.find(l => l.look)!.subs).toEqual(subs);
			expect(hints(s)).toEqual([t.lookHint]);
		});

		test("the reply carries the headline and its sub-lines on one line, and the hub reads it as a look-up whatever numbers the sub-lines hold", () => {
			const s = w.dlSplit(withSubs, "doctor"), look = s.lines.find(l => l.look)!;
			const sent = w.dlReply(s.head, look.text, look.subs);
			expect(sent).toBe(doctorLookAsk[lang](day, `${restarted} (${subs.join("; ")})`));
			expect([sent.includes("\n"), isDoctorLook(sent)]).toEqual([false, true]);
			fc.assert(fc.property(fc.array(fc.string({ unit: fc.constantFrom("a", "1", " ", "·", "'", "가", "%", "번", ")", "(", "-") }).filter(x => !!x.trim()), { minLength: 1, maxLength: 3 }), more => {
				const text = [`${t.head(day)} · ${t.told(1)}`, t.toldPart, `- ${restarted}${mark}`, ...more.map(x => `  - ${x.trim()}`)].join("\n");
				const one = w.dlSplit(text, "doctor").lines.find(l => l.look)!;
				const reply = w.dlReply(day, one.text, one.subs);
				expect(reply).toBe(doctorLookAsk[lang](day, `${restarted} (${more.map(x => x.trim()).join("; ")})`));
				expect(isDoctorLook(reply)).toBe(true);
			}));
		});

		test("property: only a told line ending in the mark gets a button, never a sub-line under it, and it gives back the line without it", () => {
			const piece = fc.string({ unit: fc.constantFrom("a", "Z", "1", " ", "·", "'", "\"", "$", "→", "가", "닥", "원", "인", "찾", "기", "%") });
			fc.assert(fc.property(fc.array(fc.record({ kind: fc.constantFrom("", "- ", "  - ", "    - "), body: piece, marked: fc.boolean() }), { maxLength: 8 }), rows => {
				const lines = rows.map(r => `${r.kind}${r.body.replace(/\n/g, " ")}${r.marked ? mark : ""}`);
				const s = w.dlSplit([t.head(day), ...lines].join("\n"), "doctor");
				const want = lines.filter(l => /^- /.test(l) && l.trimEnd().endsWith(mark)).map(l => l.trimEnd().slice(0, -mark.length).replace(/^- /, "").trim());
				expect(looks(s)).toEqual(want);
				expect(w.dlSplit([`x${t.head(day)}`, ...lines].join("\n")).lines.some(l => l.look || l.hint)).toBe(false);
			}));
		});
	});
}
