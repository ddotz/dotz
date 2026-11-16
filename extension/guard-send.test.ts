// The agent-session send guard (extension/guard-send.ts replySendDeny): a table of command lines and eval cells it refuses and lets by.
import { expect, test } from "bun:test";
import { replySendDeny } from "./guard-send.ts";

const bash = (command: string) => replySendDeny("bash", { command });
const cell = (code: string) => replySendDeny("eval", { code });

const refusedShell = [
	"zele mail send --to a@example.com --subject hi --body x",
	"zele mail reply 18f2a --body 'ok' --attach /tmp/a.pdf",
	"zele mail forward 18f2a --to b@example.com",
	"zele --account me@example.com mail reply 18f2a --body x",
	"/opt/homebrew/bin/zele mail send --to a@example.com",
	"bun features/reply-drafts/bin/draft.ts send 7",
	"bun run /opt/x/Code/dotz/features/reply-drafts/bin/draft.ts send 7 --retry",
	"bun hub/mail-cli.ts send --draft Dab12",
	"bun features/comments/bin/comments.ts send Dt8pq3b --only mail",
	"bun hub/kakao/cli.ts send --draft K12",
	"DOTZ_GATEWAY_SEND=1 bun features/reply-drafts/bin/draft.ts send 7",
	"env DOTZ_DIR=/tmp/x bun hub/mail-cli.ts send --draft D1",
	"timeout 30 zele mail reply 1 --body x",
	"cd ~/Code/dotz && bun features/reply-drafts/bin/draft.ts show 7 && bun features/reply-drafts/bin/draft.ts send 7",
	"git status; zele mail send --to a@example.com",
	"true || bun features/comments/bin/comments.ts send C1",
	"bash -lc \"zele mail send --to a@example.com\"",
	"sh -c 'cd /x && bun hub/mail-cli.ts send --draft D1'",
	"zsh -c \"bash -c 'zele mail reply 1 --body x'\"",
	"eval \"zele mail forward 1 --to b@example.com\"",
	"echo $(zele mail send --to a@example.com)",
	"out=`bun features/reply-drafts/bin/draft.ts send 7`",
	`curl -s -X POST http://127.0.0.1:7420/api/reply/act -H 'x-dotz-token: t' -d '{"ref":"D1","action":"send"}'`,
	`curl -s http://127.0.0.1:7420/api/reply/act -d '{"action": "retry", "ref": "D1"}'`,
	"curl -s http://127.0.0.1:7420/api/reply/act --data @body.json",
	// A card's answer is the owner's word: a 보내기 or 보내지 않기 pick, or one with no label to tell, is refused.
	`curl -s -X POST http://127.0.0.1:7420/api/notices/n1/answer -H 'x-dotz-token: t' -d '{"n":1,"label":"보내기"}'`,
	`curl -s http://127.0.0.1:7420/api/notices/n1/answer -d '{"n":3,"label":"보내지 않기"}'`,
	`curl -s http://127.0.0.1:7420/api/notices/n1/answer -d '{"n":4,"label":"이대로 보내기"}'`,
	`curl -s http://127.0.0.1:7420/api/notices/n1/answer -d '{"n":1}'`,
	"curl -s http://127.0.0.1:7420/api/notices/n1/answer --data-binary @pick.json",
	// Package runners and other HTTP clients.
	"bunx zele mail send --to a@example.com",
	"npx -y zele@latest mail reply 1 --body x",
	"bun x zele mail forward 1 --to b@example.com",
	`wget -qO- --post-data='{"ref":"D1","action":"send"}' http://127.0.0.1:7420/api/reply/act`,
	"wget --post-file=body.json http://127.0.0.1:7420/api/notices/n1/answer",
	// Inline interpreter code is read like an eval cell.
	`python3 -c "import subprocess; subprocess.run(['zele', 'mail', 'send', '--to', 'a@example.com'])"`,
	`node -e "fetch('http://127.0.0.1:7420/api/reply/act', { method: 'POST', body: JSON.stringify({ ref: 'D1', action: 'send' }) })"`,
	`python3 -c "import urllib.request as u; u.urlopen(u.Request('http://127.0.0.1:7420/api/notices/n1/answer', data=b'{\\"n\\": 1, \\"label\\": \\"보내기\\"}'))"`,
	// Groups, clauses, find's per-file run, a mailer named by a variable, Perl and Ruby argv lists and bare calls.
	"{ zele mail send --to a@example.com; }",
	"if true; then zele mail reply 1 --body x; fi",
	"find . -name '*.eml' -exec zele mail send --to a@example.com \\;",
	"find /tmp -execdir bun hub/mail-cli.ts send --draft D1 {} +",
	"Z=zele; $Z mail send --to a@example.com",
	`perl -e 'system("zele", "mail", "send", "--to", "a@example.com")'`,
	`perl -e 'system qw(zele mail forward 1 --to b@example.com)'`,
	`ruby -e 'system "zele mail reply 1 --body x"'`,
	`ruby -e 'system("zele", "mail", "send")'`,
	`node -e "require('child_process').spawn('zele', ['mail', 'send', '--to', 'a@example.com'])"`,
];

const allowedShell = [
	"zele mail list --limit 20",
	"zele mail read 18f2a",
	"zele mail search 'from:a@example.com send'",
	"zele mail archive 18f2a",
	"zele cal events --today --all",
	"bun features/reply-drafts/bin/draft.ts new --mail k --from a@example.com --subject s",
	"bun features/reply-drafts/bin/draft.ts revise 7 --change 'shorter'",
	"bun features/reply-drafts/bin/draft.ts show 7",
	"bun features/reply-drafts/bin/draft.ts drop 7",
	"bun hub/mail-cli.ts compose --app mail --to a@example.com --subject s",
	"bun hub/mail-cli.ts ask --draft D1",
	"bun features/comments/bin/comments.ts draft c1",
	"bun features/comments/bin/comments.ts revise D1 --change x --part mail",
	"bun hub/kakao/cli.ts draft --chat 12",
	"bun hub/kakao/cli.ts send-file --self --file /tmp/a.png",
	"bun test features/reply-drafts/test/send-e2e.test.ts",
	"rg -n 'draft.ts send' features",
	"git commit -m 'zele mail send is refused in agent sessions'",
	`curl -s http://127.0.0.1:7420/api/reply/act -d '{"ref":"D1","action":"revise","change":"shorter"}'`,
	"curl -s http://127.0.0.1:7420/api/replies",
	`curl -s http://127.0.0.1:7420/api/notices/n1/answer -d '{"n":2,"label":"고치기","note":"보내기 전에 더 짧게"}'`,
	"curl -s http://127.0.0.1:7420/api/notices?limit=20",
	"wget -qO- http://127.0.0.1:7420/api/notices",
	"bunx zele mail list --limit 5",
	"npx prettier --check .",
	`python3 -c "print('send')"`,
	`node -e "console.log('zele mail send')"`,
	"{ zele mail list; }",
	"find . -name '*.md' -exec grep -l send {} \\;",
	"$EDITOR mail.txt",
	"$PAGER mail send-log.txt",
	`perl -e 'system("zele", "mail", "list")'`,
	`ruby -e 'system "zele mail read 1"'`,
];

const refusedCell = [
	"await Bun.$`zele mail send --to a@example.com`",
	"await tool.bash({ command: \"bun hub/mail-cli.ts send --draft D1\" })",
	"Bun.spawn([\"zele\", \"mail\", \"reply\", \"1\", \"--body\", \"x\"])",
	"Bun.spawn([process.execPath, \"features/comments/bin/comments.ts\", \"send\", \"C1\"])",
	"subprocess.run(['zele', 'mail', 'forward', '1'])",
	"os.system('bun features/reply-drafts/bin/draft.ts send 7')",
	"await fetch('http://127.0.0.1:7420/api/reply/act', { method: 'POST', body: JSON.stringify({ ref: 'D1', action: 'send' }) })",
	"await fetch('http://127.0.0.1:7420/api/notices/n1/answer', { method: 'POST', body: JSON.stringify({ n: 1, label: '보내기' }) })",
	"await fetch(`${base}/api/notices/${id}/answer`, { method: 'POST', body: JSON.stringify({ n: 3 }) })",
];

const allowedCell = [
	"await Bun.$`zele mail read 18f2a`",
	"await tool.bash({ command: \"bun features/reply-drafts/bin/draft.ts revise 7 --change x\" })",
	"const r = await tool.grep({ pattern: 'draft.ts send', path: 'features' })",
	"await fetch('http://127.0.0.1:7420/api/reply/act', { method: 'POST', body: JSON.stringify({ ref: 'D1', action: 'revise', change: 'x' }) })",
	"print(['send', 'reply'].length)",
	"await fetch('http://127.0.0.1:7420/api/notices/n1/answer', { method: 'POST', body: JSON.stringify({ n: 2, label: '고치기', note: 'shorter' }) })",
	"const hits = await tool.grep({ pattern: '/api/notices/[^/]+/answer', path: 'hub' })",
];

test.each(refusedShell)("bash refused: %s", command => expect(bash(command)).toBeString());
test.each(allowedShell)("bash allowed: %s", command => expect(bash(command)).toBeUndefined());
test.each(refusedCell)("eval refused: %s", code => expect(cell(code)).toBeString());
test.each(allowedCell)("eval allowed: %s", code => expect(cell(code)).toBeUndefined());

test("other tools are not checked", () => {
	expect(replySendDeny("read", { path: "zele mail send" })).toBeUndefined();
	expect(replySendDeny("write", { content: "bun hub/mail-cli.ts send --draft D1" })).toBeUndefined();
});
