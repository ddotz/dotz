// Byte caps for the text that goes into every session's prompt. Growth here costs every session (and the weakest model
// reads it too), so it is a deliberate decision: bump the cap in the same change and say what the new text is worth.
// Each cap = measured size + 10%, rounded up to the next 10 bytes.

export const MODE_MD_MAX_BYTES = 26710; // measured 24273
export const MODE_KO_MD_MAX_BYTES = 32410; // measured 29460
export const RULES_TEMPLATE_MAX_BYTES = 780; // measured 703
export const LESSONS_TEMPLATE_MAX_BYTES = 170; // measured 153
// The live ~/.dotz/LESSONS.md is user data: only the cap lives here, nothing in the test suite reads the file.
export const LESSONS_MAX_BYTES = 1400; // measured 1268
