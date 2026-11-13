import { keepSections } from "./recall-parts.ts";
import { primaryTarget, QUICK } from "./session-key.ts";

// The quick chat (가벼운 대화, config `conversations.quick_chat`): a second conversation session next to main, on a cheaper model. Its scope
// text is the start prompt (hub/convsessions.ts scopeText); the process gets the same text as DOTZ_CONV_SCOPE, which the extension repeats after a
// compaction (extension/index.ts convScope), so the two never differ.
// The sections of MODE.md the quick chat's start prompt keeps (hub/orchestrator-parts.ts recallText): how input
// arrives, mail and calendar lookups (while zele is on), browser and testing manners, the message layout, confirmation gates, and memory and rules. The rest instructs
// what it may not do (launch sessions, route work, monitors, reports, customization, mail) or is the orchestrator's own state (state.json, restart and resume).
export const QUICK_MODE_SECTIONS = ["## Inputs", "## Mail and calendar", "## Browser and testing", "## Message layout", "## Confirmation gates", "## Memory, rules, lessons"] as const;
export const quickMode = (mode: string): string => keepSections(mode, QUICK_MODE_SECTIONS);

// A lone quick message waits this long before it becomes a turn (the default is gateway.coalesce_ms, 2 s): a light chat is waited on, and
// over 14 days 0.1% of owner messages were followed within 2 s (hub/config.ts DEFAULTS). A lower configured value, and 0, win.
export const QUICK_COALESCE_MS = 600;
export const coalesceFor = (target: string, base: number): number => (target === primaryTarget(QUICK) ? Math.min(base, QUICK_COALESCE_MS) : base);

export const quickScope = (name: string): string =>
	`You are ${name}'s quick chat: the owner's second conversation, on a cheaper model than the main session. You take chat, quick questions, lookups and small jobs you can do with your own tools. You read the same memory and rules files the main session reads. Anything bigger (code changes across files, launching sessions, merges, releases, settings) is main's: hand it over with dotz_conv send main, and you do not launch sessions, merge or change settings yourself. You do not know what main is doing unless you read it with dotz_conv read main.`;
