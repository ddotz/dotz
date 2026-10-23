// Pure message formatting for hub/discord.ts: text -> Discord payloads (chunking, plain/readable text, reply reference).
// Moved out of discord.ts unchanged; discord.ts re-exports the public functions. No module state, no imports from discord.ts.
import { isSnowflake } from "./threads.ts";
import { metaToSubtext, parseTone, plainChoice, TONE_EMOJI } from "./tone.ts";

const LIMIT = 1900;
export const noEmoji = (s: string) => s.replace(/ ?[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]+/gu, "");

function split(text: string, limit = LIMIT): string[] {
	const out: string[] = [];
	let rest_ = text;
	while (rest_.length > limit) {
		const nl = rest_.lastIndexOf("\n", limit);
		const cut = nl > 200 ? nl : limit;
		out.push(rest_.slice(0, cut));
		rest_ = rest_.slice(cut);
	}
	out.push(rest_);
	return out.filter(s => s.trim());
}

// One answer is one message. Text within LIMIT goes out whole; longer text is cut only at paragraph boundaries (a blank
// line outside a ``` fence) into the fewest messages, paragraphs packed greedily and joined by a blank line. A line ending
// in ":" stays with the paragraph after it, and a single paragraph over LIMIT falls back to the line-based split().
export function chunks(text: string, limit = LIMIT): string[] {
	if (!text.trim()) return [];
	if (text.length <= limit) return [text];
	const blocks: string[] = [];
	let cur: string[] = [];
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		if (!fence && !line.trim()) {
			if (cur.length) blocks.push(cur.join("\n"));
			cur = [];
		} else cur.push(line);
	}
	if (cur.length) blocks.push(cur.join("\n"));
	const paragraphs: string[] = [];
	for (const b of blocks) {
		if (paragraphs.length && /:\s*$/.test(paragraphs.at(-1)!)) paragraphs[paragraphs.length - 1] += `\n\n${b}`;
		else paragraphs.push(b);
	}
	const out: string[] = [];
	let acc = "";
	for (const p of paragraphs) {
		if (acc && acc.length + 2 + p.length <= limit) acc += `\n\n${p}`;
		else if (p.length > limit) {
			if (acc) out.push(acc);
			const parts = split(p, limit);
			acc = parts.pop() ?? "";
			out.push(...parts);
		} else {
			if (acc) out.push(acc);
			acc = p;
		}
	}
	if (acc) out.push(acc);
	return out;
}

// `embeds: []` appears only on PATCH (see edit()), so it is optional.
export type Body = { content: string; components?: unknown[]; embeds?: never[]; allowed_mentions?: { parse: never[]; replied_user?: boolean; users?: string[] }; message_reference?: { message_id: string; fail_if_not_exists: boolean } };
export const mentionsOff = { parse: [] as never[] };
export const reference = (replyTo?: string) => (replyTo && isSnowflake(replyTo) ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {});

// Plain message text: the explicit marker becomes the one status emoji, the model's own emoji are stripped (before the
// status emoji is added), choice blocks lose their quote prefixes and meta lines become subtext.
function plainParts(text: string): { emoji: string; body: string } {
	const { tone, text: bare } = parseTone(text);
	return { emoji: tone ? TONE_EMOJI[tone] : "", body: noEmoji(metaToSubtext(plainChoice(readable(tone ? bare.trimStart() : bare)))) };
}

// Discord-mobile layout the model cannot break, outside ``` fences: a "# heading" becomes a bold line, a "| table |"
// becomes "a · b" lines (separator rows dropped), and raw ch:<id> / th:<id> targets become channel links.
export function readable(text: string): string {
	let fence = false;
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			fence = !fence;
			out.push(line);
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}
		const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (h && !line.startsWith("-# ")) {
			out.push(`**${h[1]!.replace(/\*\*/g, "")}**`);
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line)) {
			if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
			out.push(line.trim().replace(/^\|\s*|\s*\|$/g, "").split(/\s*\|\s*/).filter(Boolean).join(" · "));
			continue;
		}
		out.push(line.replace(/(?<![\w<#])(?:ch|th):(\d{17,20})\b/g, "<#$1>"));
	}
	return out.join("\n");
}

// What goes on the wire for one send: plain content only, split by chunks(); the status emoji leads the first message.
// Pure, so it is testable offline.
// `ping` is the owner's id for a late answer: the first part pings him, through the reply reference when it has one,
// else with a mention (the only parts that may notify anyone).
export function buildPayloads(text: string, replyTo?: string, limit = LIMIT, ping?: string): Body[] {
	const { emoji, body } = plainParts(text);
	const pieces = body.trim() ? chunks(body, limit) : emoji ? [""] : [];
	return pieces.map((piece, i) => {
		const lead = i === 0 && emoji ? (piece ? `${emoji} ${piece}` : emoji) : piece;
		const ref = i === 0 ? reference(replyTo) : {};
		if (i !== 0 || !ping) return { content: lead, allowed_mentions: mentionsOff, ...ref };
		if ("message_reference" in ref) return { content: lead, allowed_mentions: { parse: [], replied_user: true }, ...ref };
		return { content: `<@${ping}> ${lead}`, allowed_mentions: { parse: [], users: [ping] }, ...ref };
	});
}

// One message that is edited in place or posted as a progress note: never split, too long text is cut to fit.
export function buildSingle(text: string): Body {
	const { emoji, body } = plainParts(text);
	return { content: (emoji && body ? `${emoji} ${body}` : emoji || body).slice(0, LIMIT) };
}
