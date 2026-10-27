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
// 2026-10-21: script-first monitoring rules replace the dotz_watch bullet (script in the project's folder, what a good check
// prints, DOTZ_FAIL, $DOTZ_WATCH_STATE_DIR): +437 / +496 bytes, caps raised by exactly that (rounded up to 10).
// 2026-10-22: personal and security data (address, card, phone, ID numbers, passwords) is asked only through the dotz_auth form, never in chat:
// +383 / +424 bytes, caps raised by exactly that (rounded up to 10).
// 2026-10-22: a new rule also gets a short title in rule-titles.json (the 커스텀 screen shows it, no model call per page view):
// +72 / +66 bytes, caps raised by exactly that (rounded up to 10).
// 2026-10-22: watch-check details left to the dotz_watch description, the thread table to one line (hub/threads.ts applies it),
// the personal-data bullet to a pointer at dotz_auth: 25395 -> 24566 / 29834 -> 28965 bytes; caps lowered to match.
export const MODE_MD_MAX_BYTES = 27196; // measured 27196 (2026-10-27 다시 연결 is the approval of a gated login watch, a second tap restarts, owner request: +60; 2026-10-26 app requests live in docs/app-templates, the bot follows the matching one: +174; 2026-10-26 owner rules moved from RULES.md (check scripts, nightly problems, integrations): +1047; text overrides live in the custom layer, never hub/: +255; new mail is web only unless 디스코드에도 올리기 is on: +53; non-developer install: never edit the code, report instead: +188; app instances: POST /api/apps, +291; the settings:<app> routing rule: +145; the no routing line / handoff block rule: +144; 2026-10-22: each mail is a web conversation, POST /api/mail: +93 bytes; the 목록 list-block rule, owner request: +174)
export const MODE_KO_MD_MAX_BYTES = 31986; // measured 31986 (2026-10-27 다시 연결 is the approval of a gated login watch, a second tap restarts: +101; 2026-10-26 app requests in docs/app-templates: +175; 2026-10-26 owner rules moved from RULES.md: +1153; text overrides live in the custom layer, never hub/: +295; new mail is web only unless 디스코드에도 올리기 is on: +100; non-developer install: never edit the code, report instead: +266; app instances: POST /api/apps, +370; the settings:<app> routing rule: +183; the no routing line / handoff block rule: +195; the 목록 list-block rule: +198)
export const RULES_TEMPLATE_MAX_BYTES = 780; // measured 703
export const LESSONS_TEMPLATE_MAX_BYTES = 170; // measured 153
// The owner card and boundaries go into the orchestrator's start prompt (observations.md does not).
export const OWNER_TEMPLATE_MAX_BYTES = 250; // measured 220
export const BOUNDARIES_TEMPLATE_MAX_BYTES = 240; // measured 217
// The live ~/.dotz/LESSONS.md is user data: only the cap lives here, nothing in the test suite reads the file.
export const LESSONS_MAX_BYTES = 1400; // measured 1268
