// Run in a terminal on this computer while web.access is "local" (이 컴퓨터만): prints a one-time login link for the browser. Only the url goes to stdout.
import { HUB_TOKEN, PORT } from "./config.ts";

const r = await fetch(`http://127.0.0.1:${PORT}/api/web-access/login-link`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN } }).catch(() => undefined);
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
