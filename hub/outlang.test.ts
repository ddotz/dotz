import { expect, test } from "bun:test";
import { cfg } from "./config.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { languageMismatch, needsRewrite } from "./outlang.ts";

test("a list of names is not English prose to rewrite; an English sentence is, a Korean one is not", () => {
	expect(languageMismatch("contact_manager, credit_suite, daily_news, dotz, findr, docgen, insane-search, journal, kami, omo, pstack, senpi", "ko")).toBe(false);
	expect(languageMismatch("dotz\nfindr\ndocgen\npstack", "ko")).toBe(false);
	expect(languageMismatch("Now a throwaway smoke script against a temp DOTZ_DIR.", "ko")).toBe(true);
	expect(languageMismatch("저장소 12개를 확인했어요: dotz, findr, docgen.", "ko")).toBe(false);
});

test("a send card in another language is never rewritten: the owner approves the mail's own words, not a translation", () => {
	const saved = { identity: cfg.identity, outlang: Reflect.get(cfg, "output_language") };
	cfg.identity = { ...cfg.identity, language: "ko" };
	Reflect.set(cfg, "output_language", "rewrite");
	try {
		const words = "Thanks for the note. Tuesday works for me, and I will bring the slides from last week. ".repeat(12).trim();
		expect(needsRewrite(words)).toBe(true);
		const card = `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "Sam <sam@example.com>", subject: "Re: plans", body: `Hi Sam,\n\n${words}\n\nBest regards`, ref: "R1AB2CD", question: "이 답장 보낼까요?" })}`;
		expect(languageMismatch(card, "ko")).toBe(true);
		expect(needsRewrite(card)).toBe(false);
	} finally {
		cfg.identity = saved.identity;
		Reflect.set(cfg, "output_language", saved.outlang);
	}
});
