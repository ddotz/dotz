import { expect, test } from "bun:test";
import { ASIDE_LIMIT_REASON, asideReason } from "./aside-errors.ts";

test("an Aside 429 or rate_limit_error becomes the Korean limit reason; other text stays short and plain", () => {
	expect(ASIDE_LIMIT_REASON).toBe("Aside 사용 한도를 넘었어요");
	expect(asideReason("\x1b[31mError 429: rate_limit_error\x1b[0m")).toBe(ASIDE_LIMIT_REASON);
	expect(asideReason("Rate limit reached")).toBe(ASIDE_LIMIT_REASON);
	expect(asideReason("port 14290 closed")).toBe("port 14290 closed");
	expect(asideReason(" no   browser\nwindow ")).toBe("no browser window");
});
