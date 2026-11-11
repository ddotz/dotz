// A pipeline's exit status is the last command's: `git push ... | tail; echo $?` reads 0 for a rejected push.
// One regex over the command text; no I/O. The status counts as read when the pipeline is chained with && / || or the next statement holds $?.
const START = String.raw`(?:^|[;&\n({"'\`]|\|\|)\s*(?:git(?:\s+-[cC]\s+\S+)*\s+push|bun\s+test)\b(?!["'\`])`;
const HEAD = String.raw`(?:2>&1|[^;&|\n()])*\|(?!\|)`;
const REST = String.raw`(?:2>&1|[^;&\n|]|\|(?!\|))*`;
const CONSUMED = String.raw`(?:&&|\|\||[;&\n][^;&\n]*\$\?)`;
const TRAP = new RegExp(START + HEAD + REST + CONSUMED, "m");

export function pipedStatusBlock(command: string): string | undefined {
	if (/pipefail|PIPESTATUS/.test(command) || !TRAP.test(command)) return undefined;
	return "orchestrator-guard: in `git push ... | tail` or `bun test ... | tail` the status is the last command's, so a rejected push or a failing test reads as 0. Send the output to a file (> /tmp/x.log 2>&1), read $? first, then show the tail; or run `set -o pipefail` first.";
}
