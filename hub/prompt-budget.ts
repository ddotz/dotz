// Byte caps for the text that goes into every session's prompt. Growth here costs every session (and the weakest model
// reads it too), so it is a deliberate decision: bump the cap in the same change and say what the new text is worth.
// Each cap = measured size + 10%, rounded up to the next 10 bytes.

// 2026-10-20: +440 / +566 bytes for the owner-memory bullet (where owner facts and verbatim don'ts live, check before asking),
// +200 / +281 for the watch approval gate (ask once, approve on the owner's yes, never trigger a 2FA step without it).
// 2026-10-20: MODE rewritten to judgment rules only (gateway-enforced rules, owner facts and duplicates of the lane footer
// moved out): 27177 -> 19781 / 32913 -> 23349 bytes; caps lowered to match.
// 2026-10-20: +281 / +323 bytes for the split-independent-tracks rule (owner: split parallel tracks into their own
// workers/lanes and worktrees yourself, never pile them on one worker or ask first).
// 2026-10-21: layer rules (chat routes, projects, scripts first, sessions, subagents, title rule) and the lane -> session,
// worker -> subagent rename (longer words): ~21119 -> 22154 / ~24902 -> 26109 bytes.
export const MODE_MD_MAX_BYTES = 24370; // measured 22154
export const MODE_KO_MD_MAX_BYTES = 28720; // measured 26109
export const RULES_TEMPLATE_MAX_BYTES = 780; // measured 703
export const LESSONS_TEMPLATE_MAX_BYTES = 170; // measured 153
// The owner card and boundaries go into the orchestrator's start prompt (observations.md does not).
export const OWNER_TEMPLATE_MAX_BYTES = 250; // measured 220
export const BOUNDARIES_TEMPLATE_MAX_BYTES = 240; // measured 217
// The live ~/.dotz/LESSONS.md is user data: only the cap lives here, nothing in the test suite reads the file.
export const LESSONS_MAX_BYTES = 1400; // measured 1268
