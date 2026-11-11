// publish-voice CLI: status, discover, needs, scope, analyze, route, brief, check, learn. No model is called and nothing runs in the background.
// Exit codes: 0 done, 3 blocked or a question for the user (facts, copying, company mail, an unclear cell), 1 failed.
import { parseArgs } from "../lib/args.ts";
import { analyze } from "../lib/cmd-analyze.ts";
import { discoverCommand, needsCommand, scopeCommand, statusCommand } from "../lib/cmd-setup.ts";
import { briefCommand, checkCommand, learnCommand, routeCommand } from "../lib/cmd-write.ts";
import { type Deps, realDeps } from "../lib/deps.ts";
import { done, failed, type Out } from "../lib/out.ts";
import { rootDir } from "../lib/store.ts";

const USAGE = [
	"usage: voice.ts <명령> [옵션]",
	"  status                              니즈, 독자, 읽기 범위, 칸 상태, 다음 단계",
	"  discover [--home <폴더>]            읽을 수 있는 곳(내용은 열지 않아요)",
	"  needs [show|add|remove] --cell <칸>,<칸> | --request \"<요청 말>\" | --audience \"<독자>\"",
	"  scope [list|add|remove] --type folder|file|url|blog|mail|messages [--kind self|other] [--voice <이름>] [--path|--url|--account <값>] [--limit N] [--asked]",
	"  analyze [--voice <이름>]            scope.json에 적힌 곳만 읽고 칸별 값을 계산",
	"  route --request \"<요청 원문>\" [--draft <파일>]   발동 여부, 모드, 칸(모델 없음)",
	"  brief --request \"<요청 원문>\" [--draft <파일>] [--material <파일>] [--voice <이름>] [--cell <칸>]",
	"  check --result <파일> [--draft <파일>] [--material <파일>] [--voice <이름>] [--json]   사실 대조, 베끼기, 바뀐 곳",
	"  learn --after <고친 글> [--before <봇 결과>] [--cell <칸>] [--voice <이름>]   --before가 없으면 마지막 check의 결과",
	"종료 코드: 0 완료, 3 막힘이나 사용자에게 물을 것, 1 실행 오류",
];

export async function run(argv: readonly string[], root = rootDir(), deps: Deps = realDeps()): Promise<Out> {
	const args = parseArgs(argv);
	const cmd = args.pos[0];
	if (!cmd || args.flags.has("--help") || args.flags.has("-h") || cmd === "help") return done(...USAGE);
	switch (cmd) {
		case "status": return statusCommand(root);
		case "discover": return discoverCommand(args, deps);
		case "needs": return needsCommand(root, args);
		case "scope": return scopeCommand(root, args);
		case "analyze": return analyze(root, args.flags.get("--voice"), deps);
		case "route": return routeCommand(root, args);
		case "brief": return briefCommand(root, args);
		case "check": return checkCommand(root, args);
		case "learn": return learnCommand(root, args);
		default: return failed(`알 수 없는 명령: ${cmd}`, ...USAGE);
	}
}

if (import.meta.main) {
	try { // no-excuse-ok: catch (CLI entry)
		const out = await run(process.argv.slice(2));
		console.log(out.lines.join("\n"));
		process.exit(out.code);
	} catch (e) {
		console.error(`오류: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}
