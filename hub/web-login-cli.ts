// The `dotz` command (hub/dotz-command.ts) and the bot's fallback, in every web.access mode.
// Prints a one-time login link for the browser (only the url goes to stdout); --open also opens it in this computer's default browser.
import { HUB_TOKEN, PORT } from "./config.ts";
import { openerCommand } from "./opener.ts";

const r = await fetch(`http://127.0.0.1:${PORT}/api/web-access/login-link`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
if (!r) {
	console.error("게이트웨이가 실행 중이 아니에요");
	process.exit(1);
}
const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
if (!r.ok || !data.url) {
	console.error(data.error ?? `로그인 링크를 만들지 못했어요 (${r.status})`);
	process.exit(1);
}
console.log(data.url);
if (process.argv.includes("--open")) {
	const opened = await Promise.resolve()
		.then(() => Bun.spawn(openerCommand(data.url), { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited)
		.catch(() => 1); // a headless Linux has no xdg-open
	if (opened !== 0) {
		console.error("브라우저를 열지 못했어요. 위 주소를 브라우저에서 열어 주세요");
		process.exit(1);
	}
}
