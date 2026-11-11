// The inline markdown of a spec string (**b**, *i*, ~~s~~, `code`, [label](https://…), a bare https url) as tokens, for the renderers (hub/spec-*.ts).
// Only http(s) becomes a link; any other scheme stays literal text, which every renderer escapes. No imports: the tokens carry no surface syntax.
export type Inline = { t: "text" | "b" | "i" | "s" | "code" | "link"; text: string; href?: string };

// A strike is a deliberate pair: the opening ~~ starts the line or follows whitespace or an opening bracket, quote or mark and is followed by a non-space;
// the closing ~~ follows a non-space and ends the line or is followed by whitespace, punctuation or a closing mark. Any other ~~ (10~~20, A ~~ B) is text.
// web/js/02-basic-markdown.js inline() keeps the same rule on escaped html; change both together (hub/basic-markdown-strike.test.ts).
export const STRIKE =
	"(?<![^\\s(\\[{<\"'*\u201c\u2018\u300c\u300e\uff08\u3010])~~(?=\\S)(?<s>(?:(?!~~).)+?)(?<=\\S)~~(?![^\\s.,;:!?)\\]}>\"'*\u201d\u2019\u300d\u300f\uff09\u3011\u2026])";

const INLINE = new RegExp(
	[
		"`(?<code>[^`\\n]+)`",
		"\\[(?<label>[^\\]\\n]+)\\]\\((?<href>https?://[^\\s)<>]+)\\)",
		"\\*\\*(?=\\S)(?<b>.+?)(?<=\\S)\\*\\*",
		STRIKE,
		"\\*(?=[^\\s*])(?<i>.+?)(?<=[^\\s*])\\*",
		"(?<url>https?://[^\\s<>]+)",
	].join("|"),
	"gi",
);
const TRAIL = /[.,;:!?)\]'"]+$/;

/** The string as tokens, in order, adjacent text joined. A link needs a parseable http(s) url; a bare url loses the punctuation that closes a sentence. */
export function inlineTokens(s: string): Inline[] {
	const out: Inline[] = [];
	const push = (t: Inline) => {
		const last = out.at(-1);
		if (t.t === "text" && last?.t === "text") last.text += t.text;
		else if (t.text) out.push(t);
	};
	let at = 0;
	for (const m of s.matchAll(INLINE)) {
		const g = m.groups!;
		let token: Inline | undefined;
		let raw = m[0];
		if (g.code !== undefined) token = { t: "code", text: g.code };
		else if (g.href !== undefined && URL.canParse(g.href)) token = { t: "link", text: g.label!, href: g.href };
		else if (g.b !== undefined) token = { t: "b", text: g.b };
		else if (g.s !== undefined) token = { t: "s", text: g.s };
		else if (g.i !== undefined) token = { t: "i", text: g.i };
		else if (g.url !== undefined) {
			const href = g.url.replace(TRAIL, "");
			if (URL.canParse(href)) {
				raw = href;
				token = { t: "link", text: href, href };
			}
		}
		if (!token) continue;
		push({ t: "text", text: s.slice(at, m.index) });
		push(token);
		at = m.index + raw.length;
	}
	push({ t: "text", text: s.slice(at) });
	return out;
}

/** The string with its marks gone: formatting tokens as their text, a link as `label url` (the label alone when it is the url). */
export const inlinePlain = (s: string): string =>
	inlineTokens(s)
		.map(k => (k.t === "link" && k.text !== k.href ? `${k.text} ${k.href}` : k.text))
		.join("");
