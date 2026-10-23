// Aside's own account limit shows up as HTTP 429 / rate_limit_error. Browsing goes through `aside repl` (our code, no Aside
// agent quota), but if any Aside call still hits the limit the owner gets this reason instead of a vague failure.
export const ASIDE_LIMIT_REASON = "Aside 사용 한도를 넘었어요";

// The Korean reason for an Aside failure text, or the text itself (ANSI stripped, one line, 200 chars) when it is not a limit.
export function asideReason(text: string): string {
	const t = text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
	return /\b429\b|rate[_ -]?limit/i.test(t) ? ASIDE_LIMIT_REASON : t.slice(-200);
}
