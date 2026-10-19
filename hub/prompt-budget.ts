// Byte caps for the text that goes into every session's prompt. Growth here costs every session (and the weakest model
// reads it too), so it is a deliberate decision: bump the cap in the same change and say what the new text is worth.
// Each cap = measured size + 10%, rounded up to the next 10 bytes.

// 2026-10-20: +440 / +566 bytes for the owner-memory bullet (where owner facts and verbatim don'ts live, check before asking).
export const MODE_MD_MAX_BYTES = 29680; // measured 26977
export const MODE_KO_MD_MAX_BYTES = 35900; // measured 32632
export const RULES_TEMPLATE_MAX_BYTES = 780; // measured 703
export const LESSONS_TEMPLATE_MAX_BYTES = 170; // measured 153
// The owner card and boundaries go into the orchestrator's start prompt (observations.md does not).
export const OWNER_TEMPLATE_MAX_BYTES = 250; // measured 220
export const BOUNDARIES_TEMPLATE_MAX_BYTES = 240; // measured 217
// The live ~/.dotz/LESSONS.md is user data: only the cap lives here, nothing in the test suite reads the file.
export const LESSONS_MAX_BYTES = 1400; // measured 1268
