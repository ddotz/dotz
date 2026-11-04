// The login page of web.access "local" (이 컴퓨터만): one button; the gateway then asks on this computer's screen and the page polls until the owner answers.
// Self-contained (inline CSS and JS, no external resource); the CSP below allows nothing else. Plain words only: no terminal, token, cookie or command.

export const LOGIN_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const CSS = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--ink:#1d1d1b;--sub:#5f5f5a;--line:#e2e2dd;--accent:#2f6f4f;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#212120;--ink:#ecece8;--sub:#a3a39d;--line:#34342f;--accent:#6bbf94;--on:#10170f}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",system-ui,sans-serif}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 24px;text-align:center}
h1{margin:0 0 12px;font-size:22px;font-weight:600}
p{margin:0 0 20px;color:var(--sub)}
button{width:100%;min-height:48px;border:0;border-radius:12px;background:var(--accent);color:var(--on);font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
button:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
#number{margin:0 0 8px;font-size:48px;font-weight:700;letter-spacing:.2em;text-indent:.2em;font-variant-numeric:tabular-nums;color:var(--ink)}
#number[hidden],#hint[hidden]{display:none}
#msg{margin:16px 0 0;color:var(--sub)}
#msg:empty{display:none}
`;

const SCRIPT = `
const $ = id => document.getElementById(id);
const TEXT = {
	waiting: "화면에 뜬 확인 창에 같은 번호가 보이면 허용을 눌러 주세요.",
	denied: "허용하지 않았어요. 다시 하려면 버튼을 눌러 주세요.",
	expired: "시간이 지났어요. 다시 눌러 주세요.",
	unavailable: "확인 창을 띄우지 못했어요. 이 컴퓨터의 화면이 켜져 있는지 확인하고 다시 눌러 주세요. 계속 안 되면 봇에게 \\"웹 로그인 링크 줘\\"라고 말해 주세요.",
	pending: "이미 확인 창이 떠 있어요. 그 창에서 답해 주세요.",
	wait: "잠시 뒤에 다시 눌러 주세요.",
};
const button = $("go"), number = $("number"), msg = $("msg"), hint = $("hint");
function show(kind) {
	number.hidden = true;
	hint.hidden = false;
	button.disabled = false;
	msg.textContent = TEXT[kind] ?? TEXT.unavailable;
}
async function poll(id) {
	for (;;) {
		await new Promise(r => setTimeout(r, 1000));
		let state = "pending";
		try {
			const r = await fetch("/local-login/status?id=" + encodeURIComponent(id), { cache: "no-store" });
			state = r.ok ? (await r.json()).state : "unavailable";
		} catch { continue; }
		if (state === "pending") continue;
		if (state === "allowed") return location.replace("/");
		return show(state);
	}
}
button.addEventListener("click", async () => {
	button.disabled = true;
	msg.textContent = "";
	let r;
	try { r = await fetch("/local-login/request", { method: "POST", cache: "no-store" }); } catch { return show("unavailable"); }
	const body = await r.json().catch(() => ({}));
	if (!r.ok || !body.id) return show(r.status === 429 ? body.error : "unavailable");
	number.textContent = body.number;
	number.hidden = false;
	hint.hidden = true;
	msg.textContent = TEXT.waiting;
	poll(body.id);
});
`;

/** The page for one assistant name; the name is escaped, everything else is fixed. */
export function loginPage(name: string): string {
	const n = escapeHtml(name);
	return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${n} 로그인</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${n} 로그인</h1>
<p id="hint">이 컴퓨터에서만 들어올 수 있어요. 아래 버튼을 누르면 화면에 확인 창이 떠요.</p>
<div id="number" hidden aria-live="polite"></div>
<button id="go" type="button">로그인</button>
<p id="msg" role="status" aria-live="polite"></p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
