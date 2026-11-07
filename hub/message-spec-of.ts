// What a surface calls at its send boundary: the page has its own bot name, so this one line stays out of the code it shares (hub/message-spec-derive.ts).
import { NAME } from "./config.ts";
import type { MessageSpec } from "./message-spec.ts";
import { deriveSpec, resolveSpecFence } from "./message-spec-derive.ts";

export const specOf = (text: string): MessageSpec | null => deriveSpec(resolveSpecFence(text), NAME);
