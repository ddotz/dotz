// Byte caps for the text that goes into every session's prompt. Growth here costs every session (and the weakest model
// reads it too), so it is a deliberate decision: bump a template cap in the same change and say what the new text is worth.
// Each template cap = measured size + 10%, rounded up to the next 10 bytes (the two MODE caps below are fixed).

// 2026-10-20: +440 / +566 bytes for the owner-memory bullet (where owner facts and verbatim don'ts live, check before asking),
// +200 / +281 for the watch approval gate (ask once, approve on the owner's yes, never trigger a 2FA step without it).
// 2026-10-20: MODE rewritten to judgment rules only (gateway-enforced rules, owner facts and duplicates of the lane footer
// moved out): 27177 -> 19781 / 32913 -> 23349 bytes; caps lowered to match.
// 2026-10-20: +281 / +323 bytes for the split-independent-tracks rule (owner: split parallel tracks into their own
// workers/lanes and worktrees yourself, never pile them on one worker or ask first).
// 2026-10-21: layer rules (chat routes, projects, scripts first, sessions, subagents, title rule) and the lane -> session,
// worker -> subagent rename (longer words): ~21119 -> 22154 / ~24902 -> 26109 bytes.
// 2026-10-21: script-first monitoring rules replace the dotz_watch bullet (script in the project's folder, what a good check
// prints, DOTZ_FAIL, $DOTZ_WATCH_STATE_DIR): +437 / +496 bytes, caps raised by exactly that (rounded up to 10).
// 2026-10-22: personal and security data (address, card, phone, ID numbers, passwords) is asked only through the dotz_auth form, never in chat:
// +383 / +424 bytes, caps raised by exactly that (rounded up to 10).
// 2026-10-22: a new rule also gets a short title in rule-titles.json (the 커스텀 screen shows it, no model call per page view):
// +72 / +66 bytes, caps raised by exactly that (rounded up to 10).
// 2026-10-22: watch-check details left to the dotz_watch description, the thread table to one line (hub/threads.ts applies it),
// the personal-data bullet to a pointer at dotz_auth: 25395 -> 24566 / 29834 -> 28965 bytes; caps lowered to match.
// Fixed caps, not measured sizes: the owner decided on 2026-11-05 that MODE.md stays within 30000 bytes and MODE.ko.md (the same rules in Korean)
// within 35300 (a 10% cut), so a new line must replace an old one; these two are not raised per change. Earlier per-change growth is in git history.
export const MODE_MD_MAX_BYTES = 30000;
export const MODE_KO_MD_MAX_BYTES = 35300;
export const RULES_TEMPLATE_MAX_BYTES = 780; // measured 703
export const LESSONS_TEMPLATE_MAX_BYTES = 170; // measured 153
// The owner card and boundaries go into the orchestrator's start prompt (observations.md does not).
export const OWNER_TEMPLATE_MAX_BYTES = 250; // measured 220
export const BOUNDARIES_TEMPLATE_MAX_BYTES = 240; // measured 217
// The live ~/.dotz/LESSONS.md is user data: only the cap lives here, nothing in the test suite reads the file.
// The one size of the lessons: the gate on the file (hub/reflect.ts admitLessons), the nightly prompt and the injection cut all read it. 3000 is
// what the injection always carried, about 30 lines of 100 bytes; the 1400 here was already passed by the live file (2121, 2026-11-04).
export const LESSONS_MAX_BYTES = 3000;
