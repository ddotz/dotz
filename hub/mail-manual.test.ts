import { afterAll, describe, expect, test } from "bun:test";
import { listDrafts } from "../features/reply-drafts/lib/store.ts";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { manualDraft } from "./mail-manual.ts";

const env = setupEnv();
afterAll(env.cleanup);

describe("직접 쓴 메일 초안의 길이", () => {
	test("a body of 20,001 characters is refused and no draft is made", () => {
		const r = manualDraft({ body: "가".repeat(20_001), to: "kim@example.com" });
		expect(r).toEqual({ ok: false, error: "내용이 너무 길어요. 20,000자까지 쓸 수 있어요", code: 400 });
		expect(listDrafts().length).toBe(0);
	});
	test("a to of 501 characters and a cc of 501 characters are refused", () => {
		const long = `${"a".repeat(489)}@example.com`;
		expect(long.length).toBe(501);
		expect(manualDraft({ body: "안녕하세요", to: long })).toEqual({ ok: false, error: "받는 사람이 너무 많아요. 500자까지 적을 수 있어요", code: 400 });
		expect(manualDraft({ body: "안녕하세요", to: "kim@example.com", cc: long })).toEqual({ ok: false, error: "참조가 너무 길어요. 500자까지 적을 수 있어요", code: 400 });
		expect(listDrafts().length).toBe(0);
	});
	test("exactly 20,000 and 500 characters are kept whole", () => {
		const to = `${"a".repeat(488)}@example.com`;
		expect(to.length).toBe(500);
		const r = manualDraft({ body: "가".repeat(20_000), to });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.rec.body.length).toBe(20_000);
			expect(r.rec.to).toBe(to);
		}
	});
});
