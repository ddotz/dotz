import { expect, test } from "bun:test";
import { languageMismatch } from "./outlang.ts";

test("a list of names is not English prose to rewrite; an English sentence is, a Korean one is not", () => {
	expect(languageMismatch("contact_manager, credit_suite, daily_news, dotz, findr, hdocs, insane-search, journal, kami, omo, pstack, senpi", "ko")).toBe(false);
	expect(languageMismatch("dotz\nfindr\nhdocs\npstack", "ko")).toBe(false);
	expect(languageMismatch("Now a throwaway smoke script against a temp DOTZ_DIR.", "ko")).toBe(true);
	expect(languageMismatch("저장소 12개를 확인했어요: dotz, findr, hdocs.", "ko")).toBe(false);
});
