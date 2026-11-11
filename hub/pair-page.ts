// The "기기 연결" page of web.access = "cloudflare" (hub/devices.ts serves it without a login). One static page and one script; the script only
// ever writes text with textContent. The page is drawn with the app's own tokens (web/css/01-tokens.css; hub/devices-web.test.ts checks every value
// against that file): the same colours, font stack, radii, type sizes and heights, light and dark from the system setting, one accent, one arrive motion.
// /pair-hop.js belongs to a second fixed page (HOP_HTML) that hub/devices.ts answers to a cross-site first navigation; it holds no data.

export const PAIR_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>기기 연결</title>
<style>
:root{color-scheme:light;--bg:#f2f4f6;--card:#ffffff;--layer:#f2f4f6;--hover:#e9ecf0;--fg:#191f28;--fg-2:#4e5968;--fg-3:#616b78;--accent:#3182f6;--on-accent:#ffffff;--err:#e32435;
--fs-page:22px;--lh-page:30px;--fs-page-sm:20px;--lh-page-sm:28px;--fs-card:16px;--fs-body:14px;--lh-body:22px;
--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;--sp-8:32px;--r-card:18px;--r-ctl:10px;--sheet-w:480px;
--btn-h:36px;--btn-hit:44px;--field-h:36px;--field-h-touch:40px;--m-base:220ms;--m-ease:cubic-bezier(.2, .7, .2, 1);
--font:Pretendard, "Pretendard Variable", -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif;}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#121214;--card:#1d1d21;--layer:#26262b;--hover:#2b2b31;--fg:#ececf0;--fg-2:#b0b4bc;--fg-3:#8e939c;--accent:#6ca7ff;--on-accent:#121214;--err:#ff6369;}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;min-height:100%}
body{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:var(--sp-4);background:var(--bg);color:var(--fg);font:400 var(--fs-body)/var(--lh-body) var(--font);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;word-break:keep-all;overflow-wrap:break-word}
main{width:min(var(--sheet-w),100%);padding:var(--sp-5);border-radius:var(--r-card);background:var(--card);animation:arrive var(--m-base) var(--m-ease) both}
@keyframes arrive{from{opacity:0;transform:translateY(var(--sp-2))}to{opacity:1;transform:none}}
h1{margin:0;font-size:var(--fs-page);line-height:var(--lh-page);font-weight:700;text-wrap:balance}
p{margin:var(--sp-1) 0 var(--sp-4);color:var(--fg-2);text-wrap:pretty}
button,input{font:inherit;color:inherit;letter-spacing:inherit}
button{display:flex;align-items:center;justify-content:center;width:100%;height:var(--btn-h);margin:0 0 var(--sp-2);padding:0 var(--sp-4);border:1px solid transparent;border-radius:var(--r-ctl);background:var(--accent);color:var(--on-accent);font-weight:600;cursor:pointer}
button.alt{background:var(--layer);color:var(--fg)}
button:hover{opacity:.85}
button.alt:hover{background:var(--hover);opacity:1}
button:disabled{opacity:.4;cursor:default;pointer-events:none}
input{display:block;width:100%;height:var(--field-h);margin:0 0 var(--sp-2);padding:0 var(--sp-3);border:0;border-radius:var(--r-ctl);background:var(--layer);color:var(--fg);outline:0}
input::placeholder{color:var(--fg-3)}
input:focus{box-shadow:inset 0 0 0 1.5px var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
input:focus-visible{outline:0}
#msg{margin-top:var(--sp-2);color:var(--fg-2)}
#msg:empty{display:none}
#msg.bad{color:var(--err)}
@media (max-width:639px){h1{font-size:var(--fs-page-sm);line-height:var(--lh-page-sm)}}
@media (pointer:coarse){button{height:var(--btn-hit)}input{height:var(--field-h-touch);font-size:var(--fs-card)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style>
</head>
<body data-devices="__DEVICES__">
<main>
<h1>기기 연결</h1>
<p id="lead"></p>
<section id="login" hidden>
<button id="go" type="button">패스키로 들어가기</button>
</section>
<section id="pairing">
<button id="get" type="button" class="alt">코드 받기</button>
<div id="enter" hidden>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6자리 코드">
<input id="name" maxlength="60" placeholder="기기 이름">
<button id="join" type="button">이 기기 연결</button>
</div>
</section>
<div id="msg" role="status"></div>
</main>
<script src="/pair.js"></script>
</body>
</html>
`;

/** A cross-site first navigation carries no SameSite=Strict cookie; this fixed page, which holds no data, sends the browser to /pair from this site, where the cookie travels. */
export const HOP_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>dotz</title>
<script src="/pair-hop.js"></script>
</head>
<body></body>
</html>
`;

export const HOP_JS = `"use strict";
location.replace("/pair?next=" + encodeURIComponent(location.pathname + location.search) + location.hash);
`;

/** The browser's copy of hub/devices.ts safeNext (the same rule; hub/devices.test.ts runs both over one table). */
export const SAFE_NEXT_SRC = String.raw`function safeNext(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return "/";
  if (raw[0] !== "/" || raw[1] === "/" || /[\\\u0000-\u001f\u007f-\u009f]/.test(raw) || /^\/pair(?:[/?#]|$)/.test(raw)) return "/";
  return raw;
}`;

export const PAIR_JS = `"use strict";
(() => {
  ${SAFE_NEXT_SRC}
  const $ = id => document.getElementById(id);
  const hasDevices = Number(document.body.dataset.devices) > 0;
  const say = (t, bad) => { $("msg").textContent = t; $("msg").className = bad ? "bad" : ""; };
  const toBytes = s => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/")); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };
  const toText = buf => { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "요청에 실패했습니다 (" + r.status + ")");
    return data;
  };
  const guard = fn => async ev => {
    const b = ev.currentTarget; b.disabled = true;
    try { await fn(); } catch (e) { say(e && e.name === "NotAllowedError" ? "기기 확인이 취소되었습니다" : String((e && e.message) || e), true); }
    b.disabled = false;
  };
  const supported = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

  $("lead").textContent = hasDevices ? "이 기기는 아직 연결되지 않았습니다. 패스키로 들어가거나, 새 기기라면 코드를 받아 연결해 주세요." : "처음 한 번만 이 기기를 연결합니다. 코드는 메신저 알림으로 옵니다.";
  $("login").hidden = !hasDevices;
  $("name").value = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  if (!supported) { say("이 브라우저는 패스키를 쓸 수 없습니다 (HTTPS 주소와 최신 브라우저가 필요합니다)", true); $("go").disabled = true; $("get").disabled = true; }

  // Opened from the QR on the settings screen: the code comes in the fragment and leaves the address bar and the history at once.
  const scanned = /^#code=(\\d{6})$/.exec(location.hash);
  // Where to go once in: the next of the address (a same-origin path) and the fragment that came with it; a code fragment from the QR is not one.
  const dest = safeNext(new URLSearchParams(location.search).get("next")) + (scanned ? "" : location.hash);
  if (location.hash) history.replaceState(null, "", location.pathname);
  if (scanned && supported) {
    $("code").value = scanned[1];
    $("enter").hidden = false;
    $("get").hidden = true;
    say("코드를 넣어 두었습니다. 이름을 확인하고 '이 기기 연결'을 눌러 주세요.");
  }

  $("get").addEventListener("click", guard(async () => {
    await post("/api/pair/code");
    $("enter").hidden = false;
    $("code").focus();
    say("메신저로 6자리 코드를 보냈습니다. 10분 안에 입력해 주세요.");
  }));

  $("join").addEventListener("click", guard(async () => {
    const o = await post("/api/pair/begin", { code: $("code").value });
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: toBytes(o.challenge), rp: o.rp, user: { id: toBytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams, authenticatorSelection: o.authenticatorSelection, attestation: o.attestation, timeout: o.timeout,
    } });
    const r = cred.response;
    await post("/api/pair/register", {
      id: cred.id, clientDataJSON: toText(r.clientDataJSON), authenticatorData: toText(r.getAuthenticatorData()),
      publicKey: toText(r.getPublicKey()), publicKeyAlgorithm: r.getPublicKeyAlgorithm(), name: $("name").value,
    });
    say("연결되었습니다.");
    location.replace(dest);
  }));

  $("go").addEventListener("click", guard(async () => {
    const o = await post("/api/pair/login-begin");
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: toBytes(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout,
      allowCredentials: o.allowCredentials.map(c => ({ type: c.type, id: toBytes(c.id) })),
    } });
    const r = cred.response;
    await post("/api/pair/login", { id: cred.id, clientDataJSON: toText(r.clientDataJSON), authenticatorData: toText(r.authenticatorData), signature: toText(r.signature) });
    location.replace(dest);
  }));
})();
`;
