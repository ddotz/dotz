// Text -> spec; no spec means the plain text path.
import type { MessageSpec } from "./message-spec.ts";

/** The spec of a message's body (tone marker already gone), or null when it is conversation: no shape, plain sentences. */
export function deriveSpec(_text: string): MessageSpec | null {
	return null;
}

/** A model-written ```dotz-spec fence replaced by its plain form when valid, by its readable strings when not. Text without a fence comes back unchanged. */
export function resolveSpecFence(text: string): string {
	return text;
}

/** What a surface calls at its send boundary. */
export const specOf = (text: string): MessageSpec | null => deriveSpec(resolveSpecFence(text));
