// The reason table's machine values (design 2.2, 2.4): every code has a class, nothing that may have gone out is ever retried by code,
// and a filled reason never shows a placeholder.
import { expect, test } from "bun:test";
import { isReasonCode, partialReason, policyOf, REASON_CODES, reasonOf } from "./reply-reasons.ts";

test("every code has a class and only surely-unsent codes carry an automatic retry", () => {
	for (const code of REASON_CODES) {
		const p = policyOf(code);
		expect(["no", "maybe", "action"]).toContain(p.class);
		if (p.class !== "no") expect(p.auto).toBeUndefined();
		if (p.auto) expect(p.auto.waits.length).toBeGreaterThan(0);
	}
	expect(REASON_CODES.filter(c => policyOf(c).auto).sort()).toEqual(["app_not_ready", "attach_upload", "file_pending", "lease_held", "lease_unknown", "login_expired", "offline", "rate_limited", "subject_re", "tool_before_send"]);
	for (const code of ["net_cut", "timeout", "interrupted", "server_error", "press_unconfirmed", "readback_mismatch", "state_write", "unknown"] as const) expect(policyOf(code)).toMatchObject({ class: "maybe", actions: ["resolve_sent", "open_channel", "resolve_retry"] });
	expect(isReasonCode("offline")).toBe(true);
	expect(isReasonCode("toString")).toBe(false);
});

test("a filled reason has no leftover braces, with or without its values", () => {
	for (const code of REASON_CODES) for (const lang of ["ko", "en"] as const) expect(reasonOf(code, {}, lang).text).not.toMatch(/[{}]/);
	expect(reasonOf("too_long", { n: 900, max: 600 }).text).toBe("글이 너무 길어요 (900자, 600자까지)");
	expect(reasonOf("recipient_self").text).toBe("받는이가 내 주소예요");
	expect(partialReason({ done: 1, total: 3, code: "app_not_ready" }).text).toBe("3개 중 1개만 보냈어요. 카카오톡 창을 준비하지 못했어요");
});
