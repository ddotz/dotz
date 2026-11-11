// The piped-status check: a pipeline that starts with git push or bun test reports the last command's status, not the push's or the test's.
import { expect, test } from "bun:test";
import { pipedStatusBlock } from "./guard-pipe.ts";

test("blocks a git push or bun test pipeline whose status is read afterwards", () => {
	for (const command of [
		'git push origin HEAD:main 2>&1 | tail -3; echo "push=$?"',
		"bun test hub/a.test.ts | tail -5 && git push origin HEAD:main",
		"git -C /home/user/repo push 2>&1 | grep -v remote || echo failed",
		"bun test 2>&1 | tee /tmp/t.log; code=$?; exit $code",
		'tool.bash({ command: "cd /home/user/repo && git push origin HEAD:main 2>&1 | tail -3; echo $?" })',
	]) expect(typeof pipedStatusBlock(command)).toBe("string");
});

test("passes when the status is not read, is safe, or the first command is something else", () => {
	for (const command of [
		"bun test 2>&1 | tail -20",
		"git push origin HEAD:main > /tmp/p.log 2>&1; code=$?; tail -4 /tmp/p.log; exit $code",
		"set -o pipefail; bun test | tail -5 && echo ok",
		"bun test | tail -5; echo ${PIPESTATUS[0]}",
		"git log --oneline | head -3 && echo ok",
		"ls | head; echo $?",
		"git push origin HEAD:main || echo failed",
		"echo done | bun test && echo ok",
		"bun test $(ls hub/*.test.ts | sort -u | tr '\\n' ' ') > /tmp/st.log 2>&1; echo exit=$?",
		"pgrep -fl 'bun test' | head -5; uptime; echo $?",
		"git fetch -q && git push origin HEAD:main 2>&1 | tail -3; git fetch -q; git merge-base --is-ancestor a b; echo onmain=$?",
	]) expect(pipedStatusBlock(command)).toBeUndefined();
});
