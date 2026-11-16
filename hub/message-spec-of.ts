// What a surface calls at its send boundary: the page has its own bot name, so this one line stays out of the code it shares (hub/message-spec-derive.ts).
// A numbered list right under a question is a choice to hub/choices.ts, and its buttons need that text as written (hub/askbuttons.ts): such a message has no Choice element, so it stays text.
import { parseChoices } from "./choices.ts";
import { NAME } from "./config.ts";
import { type MessageSpec, specChildren, specPlain, validateSpec } from "./message-spec.ts";
import { deriveSpec } from "./message-spec-derive.ts";

// ---- a model-written ```dotz-spec fence: the hub resolves it before a text is stored or shown (hub/owner-text.ts), so it stays out of the page's copy of the grammar ----
const SPEC_FENCE = /(\n|^)([ \t]{0,3})```([^\n`]*)\n?([\s\S]*?)(?:```[ \t]*(?=\n|$)|$)/g;
function readable(v: unknown, out: string[] = []): string[] {
	if (typeof v === "string") { if (v.trim()) out.push(v); }
	else if (Array.isArray(v)) for (const x of v) readable(x, out);
	else if (v && typeof v === "object") for (const x of Object.values(v)) readable(x, out);
	return out;
}
function fenceBody(body: string): string | null {
	let json: unknown;
	try { json = JSON.parse(body); } catch { return null; }
	const ok = validateSpec(json);
	if (ok.ok) return specPlain(ok.spec);
	const els = (json as { elements?: Record<string, { props?: unknown; children?: unknown }> } | null)?.elements;
	const words = els && typeof els === "object" && !Array.isArray(els) ? Object.values(els).map(e => readable(e?.props).join("\n")).filter(Boolean) : readable(json);
	return words.length ? words.join("\n\n") : null;
}

/** A model-written ```dotz-spec fence replaced by its plain form when valid, by its readable strings when not. Text without a fence comes back unchanged. A fence that is not JSON stays as the code block it is. */
export function resolveSpecFence(text: string): string {
	if (typeof text !== "string" || !text.includes("dotz-spec")) return text;
	try {
		return text.replace(SPEC_FENCE, (all, lead: string, _indent: string, lang: string, body: string) => {
			if (lang.trim() !== "dotz-spec") return all;
			const plain = fenceBody(body);
			return plain === null ? all : lead + plain;
		});
	} catch {
		return text;
	}
}

export function specOf(text: string): MessageSpec | null {
	const shown = resolveSpecFence(text), spec = deriveSpec(shown, NAME);
	return spec && parseChoices(shown).options.length && !specChildren(spec).some(e => e.type === "Choice") ? null : spec;
}
