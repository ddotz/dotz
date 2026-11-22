// What an outside tool printed, read for the reason a send failed. Node (and a Bun child running Node code) prints its runtime warnings first on
// stderr ("(node:8498) ExperimentalWarning: SQLite is an experimental feature ...", then "(Use `node --trace-warnings ...` ...)"); they say nothing
// about the failure, so the reason is picked from what is left. A tool that wraps its stderr into its own message puts the warning mid-line
// ("보내지 못했어요: (node:8498) ..."), so a warning is cut from where it starts to the end of its line. The raw text still goes to the log.
const RUNTIME_WARNING = /\(node:\d+\) [A-Za-z]*Warning:[^\n]*\n?|\(Use `node --trace-warnings[^\n]*\n?/g;

export const withoutRuntimeWarnings = (text: string): string => text.replace(RUNTIME_WARNING, "");
