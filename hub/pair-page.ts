// The "기기 연결" page of web.access = "cloudflare" (hub/devices.ts serves it without a login). One static page and one script; the script only
// ever writes text with textContent.

export const PAIR_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>기기 연결</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{width:min(360px,92vw);padding:24px 0}
h1{font-size:22px;margin:0 0 6px}
p{margin:0 0 16px;opacity:.75}
button,input{font:inherit;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #8886;margin:0 0 10px}
button{background:#2563eb;border-color:#2563eb;color:#fff;cursor:pointer}
button.alt{background:transparent;color:inherit;border-color:#8886}
button:disabled{opacity:.5}
input{background:transparent;color:inherit}
#msg{min-height:1.5em;margin-top:8px}
#msg.bad{color:#dc2626}
[hidden]{display:none}
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

export const PAIR_JS = `"use strict";
(() => {
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
    location.replace("/");
  }));

  $("go").addEventListener("click", guard(async () => {
    const o = await post("/api/pair/login-begin");
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: toBytes(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout,
      allowCredentials: o.allowCredentials.map(c => ({ type: c.type, id: toBytes(c.id) })),
    } });
    const r = cred.response;
    await post("/api/pair/login", { id: cred.id, clientDataJSON: toText(r.clientDataJSON), authenticatorData: toText(r.authenticatorData), signature: toText(r.signature) });
    location.replace("/");
  }));
})();
`;
