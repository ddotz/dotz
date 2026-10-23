// Page scripts for the onboarding wizards, run by `aside repl` (our own code drives a background tab; no Aside agent, no
// Aside quota). Each script is plain JS text that runs in the repl as the body of an async function. It checks the page
// state before and after every action and ends with a result object:
//   { state: "ok", data? }          the step is done (data = small non-secret ids)
//   { state: "owner", note }        a login page: the owner must sign in
//   { state: "code", service }      a verification-code prompt (the tab is left open for the code to be typed in)
//   { state: "unexpected", note }   a page this script does not know: stop and ask the owner, never guess
// Secrets are read inside the page and POSTed to the one-shot localhost receiver; they are never returned.
import type { OtpService } from "./otp.ts";

export type PageResult = { state: "ok" | "owner" | "code" | "unexpected" | "failed"; note?: string; service?: OtpService; data?: Record<string, string> };

// Helpers every script can use: pg = the background tab.
export const PRELUDE = String.raw`
const dzUrl = () => String(typeof pg.url === "function" ? pg.url() : pg.url);
const dzText = async () => (await pg.evaluate(() => (document.body ? document.body.innerText : ""))) || "";
const dzWait = async (re, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (new RegExp(re, "i").test(await dzText())) return true; await sleep(1000); }
  return false;
};
const dzHas = async (sel) => (await pg.locator(sel).count()) > 0;
const dzClick = async (patterns) => {
  const hit = await pg.evaluate((src) => {
    const res = src.map((s) => new RegExp(s, "i"));
    for (const el of document.querySelectorAll("button, [role=button], [role=menuitem], [role=option], [role=radio], [role=tab], a")) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (t && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.offsetParent !== null && res.some((r) => r.test(t))) { el.setAttribute("data-dz-click", "1"); return t; }
    }
    return null;
  }, patterns);
  if (!hit) return null;
  await pg.locator('[data-dz-click="1"]').first().click();
  await pg.evaluate(() => document.querySelectorAll("[data-dz-click]").forEach((e) => e.removeAttribute("data-dz-click")));
  return hit;
};
const dzFill = async (sel, value) => {
  const box = pg.locator(sel).first();
  if (!(await box.count())) return false;
  await box.fill(value);
  return true;
};
const dzPost = async (pats, postUrl) => {
  const text = await dzText();
  const found = {};
  for (const [k, p] of Object.entries(pats)) { const m = new RegExp(p).exec(text); if (m) found[k] = m[1] ?? m[0]; }
  if (Object.keys(found).length !== Object.keys(pats).length) return false;
  const res = await fetch(postUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(found) });
  return res.ok;
};
const OTP_INPUT = 'input[autocomplete="one-time-code"], input[name="idvPin"], input[name="Pin"], input[name="approvals_code"], input[name="verificationCode"], input[name="confirmationCode"]';
const dzGate = async () => {
  const u = dzUrl();
  const google = /accounts\.google\.com/.test(u);
  const meta = /facebook\.com|instagram\.com/.test(u);
  if (await dzHas(OTP_INPUT)) return { state: "code", service: google ? "google" : meta ? "instagram" : "generic" };
  if (google && /\/(signin|v3\/signin|ServiceLogin|challenge)/i.test(u)) return { state: "owner", note: "구글 로그인 화면이 나왔어요" };
  if (meta && (/\/(login|checkpoint|two_factor)/i.test(u) || (await dzHas('input[name="pass"], input[type="password"]')))) return { state: "owner", note: "로그인 화면이 나왔어요" };
  return null;
};
`;

// Wraps one step script: opens a BACKGROUND tab (openTab never focuses), stops at a login or code page, and closes the tab
// in the same run unless a code prompt must stay open. The leading comment names the step (logs, tests).
export function pageBody(step: string, url: string, script: string): string {
	return `// dz-step: ${step}
const pg = await openTab(${JSON.stringify(url)});
const dzKeep = { v: false };
try {
${PRELUDE}
const gate = await dzGate();
if (gate) { if (gate.state === "code") dzKeep.v = true; return gate; }
${script}
} finally { if (!dzKeep.v) await closeTab(pg).catch(() => {}); }`;
}

// ---- Google Cloud ----------------------------------------------------------------------------------------------------

const PROJECT_ID = String.raw`/(?:Project ID|프로젝트 ID)\s*:?\s*([a-z][a-z0-9-]{4,28}[a-z0-9])/i`;

// Reuse the project "dotz-youtube" when the list shows it, else create it. data.projectId = the project's ID.
export const GCP_PROJECT_URL = "https://console.cloud.google.com/cloud-resource-manager";
export const gcpProject = (): string => String.raw`
if (!(await dzWait("Resource Manager|리소스 관리", 25000))) return { state: "unexpected", note: "프로젝트 목록 화면이 열리지 않았어요" };
await sleep(2000);
const ids = ((await dzText()).match(/dotz-youtube(?:-\d+)?/g) || []);
const known = ids.find((x) => /\d$/.test(x)) || ids[0];
if (known) return { state: "ok", data: { projectId: known } };
await pg.goto("https://console.cloud.google.com/projectcreate");
if (!(await dzWait("New Project|새 프로젝트", 25000))) return { state: "unexpected", note: "새 프로젝트 화면이 열리지 않았어요" };
if (!(await dzFill('input[formcontrolname="projectName"], input[aria-label="Project name"], input[aria-label="프로젝트 이름"]', "dotz-youtube"))) return { state: "unexpected", note: "프로젝트 이름 칸을 찾지 못했어요" };
await sleep(1500);
const idm = ${PROJECT_ID}.exec(await dzText());
if (!idm) return { state: "unexpected", note: "프로젝트 ID를 읽지 못했어요" };
if (!(await dzClick(["^(create|만들기)$"]))) return { state: "unexpected", note: "만들기 버튼을 찾지 못했어요" };
const end = Date.now() + 40000;
while (Date.now() < end) {
  if (new URL(dzUrl()).searchParams.get("project") === idm[1]) return { state: "ok", data: { projectId: idm[1] } };
  await sleep(1500);
}
return { state: "unexpected", note: "프로젝트가 만들어졌는지 확인하지 못했어요" };`;

export const gcpApiUrl = (id: string) => `https://console.cloud.google.com/apis/library/youtube.googleapis.com?project=${encodeURIComponent(id)}`;
export const gcpApi = (): string => String.raw`
if (!(await dzWait("YouTube Data API v3", 25000))) return { state: "unexpected", note: "YouTube Data API 화면이 열리지 않았어요" };
await sleep(1500);
const on = () => dzWait("API enabled|API 사용 설정됨|Manage|관리", 1500);
if (await on()) return { state: "ok" };
if (!(await dzClick(["^(enable|사용 설정|사용)$"]))) return { state: "unexpected", note: "사용 설정 버튼을 찾지 못했어요" };
if (await dzWait("API enabled|API 사용 설정됨|Manage|관리", 45000)) return { state: "ok" };
return { state: "unexpected", note: "API가 켜졌는지 확인하지 못했어요" };`;

// OAuth consent screen: app "dotz", External, support and contact email = the signed-in account.
export const gcpConsentUrl = (id: string) => `https://console.cloud.google.com/auth/overview?project=${encodeURIComponent(id)}`;
export const gcpConsent = (): string => String.raw`
if (!(await dzWait("Google Auth Platform|OAuth overview|개요|Get started|시작하기", 25000))) return { state: "unexpected", note: "OAuth 동의 화면 설정 화면이 열리지 않았어요" };
await sleep(2000);
if (await dzClick(["^(get started|시작하기)$"])) {
  await sleep(1500);
  if (!(await dzFill('input[aria-label*="App name"], input[aria-label*="앱 이름"], input[formcontrolname="displayName"]', "dotz"))) return { state: "unexpected", note: "앱 이름 칸을 찾지 못했어요" };
  const combo = pg.locator('[role="combobox"]').first();
  if (!(await combo.count())) return { state: "unexpected", note: "지원 이메일 선택 칸을 찾지 못했어요" };
  await combo.click();
  const opt = pg.locator('[role="option"]').first();
  if (!(await opt.count())) return { state: "unexpected", note: "지원 이메일 후보가 없어요" };
  const email = ((await opt.innerText()).match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
  await opt.click();
  if (!(await dzClick(["^(next|다음)$"]))) return { state: "unexpected", note: "앱 정보 다음 버튼을 찾지 못했어요" };
  await sleep(1500);
  if (!(await dzClick(["^(external|외부)$"])) && !(await dzHas('input[type="radio"]'))) return { state: "unexpected", note: "대상(외부) 선택을 찾지 못했어요" };
  if (!(await dzClick(["^(next|다음)$"]))) return { state: "unexpected", note: "대상 다음 버튼을 찾지 못했어요" };
  await sleep(1500);
  if (!email || !(await dzFill('input[aria-label*="Email"], input[aria-label*="이메일"], input[type="email"]', email))) return { state: "unexpected", note: "개발자 연락처 이메일 칸을 찾지 못했어요" };
  if (!(await dzClick(["^(next|다음)$"]))) return { state: "unexpected", note: "연락처 다음 버튼을 찾지 못했어요" };
  await sleep(1500);
  const agree = pg.locator('input[type="checkbox"], [role="checkbox"]').first();
  if (!(await agree.count())) return { state: "unexpected", note: "정책 동의 칸을 찾지 못했어요" };
  await agree.click();
  if (!(await dzClick(["^(continue|계속)$"]))) return { state: "unexpected", note: "계속 버튼을 찾지 못했어요" };
  if (!(await dzClick(["^(create|만들기)$"]))) return { state: "unexpected", note: "동의 화면 만들기 버튼을 찾지 못했어요" };
  if (!(await dzWait("Metrics|측정항목|OAuth overview|개요", 45000))) return { state: "unexpected", note: "동의 화면이 만들어졌는지 확인하지 못했어요" };
}
return { state: "ok" };`;

// Publishes the app to production; a Testing app expires the login after 7 days.
export const gcpPublishUrl = (id: string) => `https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(id)}`;
export const gcpPublish = (): string => String.raw`
if (!(await dzWait("Publishing status|게시 상태", 25000))) return { state: "unexpected", note: "대상 화면이 열리지 않았어요" };
await sleep(1500);
if (await dzWait("In production|프로덕션 중", 1500)) return { state: "ok" };
if (!(await dzClick(["^(publish app|앱 게시)$"]))) return { state: "unexpected", note: "앱 게시 버튼을 찾지 못했어요" };
await sleep(1500);
if (!(await dzClick(["^(confirm|확인)$"]))) return { state: "unexpected", note: "게시 확인 버튼을 찾지 못했어요" };
if (await dzWait("In production|프로덕션 중", 30000)) return { state: "ok" };
return { state: "unexpected", note: "앱이 게시됐는지 확인하지 못했어요" };`;

// Desktop OAuth client; the id and secret shown in the creation dialog are POSTed to the receiver inside this same run.
export const gcpClientUrl = (id: string) => `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(id)}`;
export const gcpClient = (postUrl: string): string => String.raw`
if (!(await dzWait("Create OAuth client|OAuth 클라이언트 만들기|Application type|애플리케이션 유형", 25000))) return { state: "unexpected", note: "OAuth 클라이언트 만들기 화면이 열리지 않았어요" };
await sleep(1500);
const type = pg.locator('[role="combobox"], mat-select').first();
if (!(await type.count())) return { state: "unexpected", note: "애플리케이션 유형 칸을 찾지 못했어요" };
await type.click();
if (!(await dzClick(["^(desktop app|데스크톱 앱)$"]))) return { state: "unexpected", note: "데스크톱 앱 항목을 찾지 못했어요" };
await dzFill('input[aria-label="Name"], input[aria-label="이름"], input[formcontrolname="displayName"], input[type="text"]', "dotz");
if (!(await dzClick(["^(create|만들기)$"]))) return { state: "unexpected", note: "클라이언트 만들기 버튼을 찾지 못했어요" };
if (!(await dzWait("GOCSPX-", 30000))) return { state: "unexpected", note: "클라이언트 비밀번호가 화면에 보이지 않아요" };
const ok = await dzPost({ client_id: "(\\d+-[a-z0-9]+\\.apps\\.googleusercontent\\.com)", client_secret: "(GOCSPX-[A-Za-z0-9_-]+)" }, ${JSON.stringify(postUrl)});
return ok ? { state: "ok" } : { state: "unexpected", note: "화면에서 클라이언트 값을 읽지 못했어요" };`;

// Google consent screen opened by setup.ts youtube-auth: pick the signed-in account, accept the unverified-app warning,
// allow the scopes. Ends when the browser reaches the loopback redirect.
export const gcpConsentFlow = (): string => String.raw`
for (let i = 0; i < 14; i++) {
  const u = dzUrl();
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return { state: "ok" };
  const gate = await dzGate();
  if (gate) { if (gate.state === "code") dzKeep.v = true; return gate; }
  const chooser = pg.locator("[data-identifier], div[data-email]").first();
  if (await chooser.count()) { await chooser.click(); await sleep(2000); continue; }
  if (await dzClick(["^(advanced|고급)$"])) { await sleep(1000); continue; }
  if (await dzClick(["(unsafe)|(안전하지 않음)"])) { await sleep(2000); continue; }
  const boxes = pg.locator('input[type="checkbox"]:not(:checked), [role="checkbox"][aria-checked="false"]');
  for (let n = await boxes.count(); n > 0; n--) await boxes.first().click();
  if (await dzClick(["^(continue|계속|allow|허용)$"])) { await sleep(2500); continue; }
  await sleep(1500);
}
return { state: "unexpected", note: "구글 권한 화면이 예상과 달라요" };`;

// ---- Instagram and Meta ----------------------------------------------------------------------------------------------

export const IG_ACCOUNT_URL = "https://www.instagram.com/accounts/edit/";
// Professional (creator/business) account check; a personal account is switched to Creator, each page checked.
export const igAccount = (): string => String.raw`
if (!(await dzWait("Edit profile|프로필 편집|Switch to|전환", 25000))) return { state: "unexpected", note: "인스타 설정 화면이 열리지 않았어요" };
await sleep(1500);
const personal = "switch to professional account|프로페셔널 계정으로 전환";
if (!(await dzWait(personal, 1500))) return { state: "ok" };
if (!(await dzClick([personal]))) return { state: "unexpected", note: "프로페셔널 전환 버튼을 찾지 못했어요" };
for (let i = 0; i < 6; i++) {
  await sleep(2000);
  if (!(await dzWait("creator|크리에이터|continue|계속|next|다음|done|완료|switch|전환", 8000))) break;
  const hit = (await dzClick(["^(creator|크리에이터)$"])) || (await dzClick(["^(continue|계속|next|다음|done|완료|switch|전환)$"]));
  if (!hit) break;
}
await pg.goto(${JSON.stringify(IG_ACCOUNT_URL)});
await sleep(3000);
if (!(await dzWait(personal, 1500))) return { state: "ok" };
return { state: "unexpected", note: "프로페셔널 계정으로 바뀌었는지 확인하지 못했어요" };`;

export const META_APPS_URL = "https://developers.facebook.com/apps/";
// The Meta app "dotz-instagram": reuse it when listed, else create it. data.appId = the app id.
export const metaApp = (): string => String.raw`
if (!(await dzWait("My Apps|Create App|앱 만들기|내 앱", 25000))) return { state: "unexpected", note: "메타 앱 목록이 열리지 않았어요" };
await sleep(2000);
const findId = () => pg.evaluate(() => {
  for (const a of document.querySelectorAll("a[href*='/apps/']")) {
    const m = /\/apps\/(\d+)/.exec(a.getAttribute("href") || "");
    if (m && /dotz-instagram/.test(a.innerText || "")) return m[1];
  }
  return null;
});
const known = await findId();
if (known) return { state: "ok", data: { appId: known } };
if (!(await dzClick(["^(create app|앱 만들기)$"]))) return { state: "unexpected", note: "앱 만들기 버튼을 찾지 못했어요" };
await sleep(2500);
if (!(await dzFill('input[type="text"]', "dotz-instagram"))) return { state: "unexpected", note: "앱 이름 칸을 찾지 못했어요" };
if (!(await dzClick(["^(next|다음)$"]))) return { state: "unexpected", note: "앱 이름 다음 버튼을 찾지 못했어요" };
await sleep(2500);
if (!(await dzClick(["Instagram"]))) return { state: "unexpected", note: "Instagram 사용 사례를 찾지 못했어요" };
for (let i = 0; i < 4; i++) {
  await sleep(1500);
  if (!(await dzClick(["^(next|다음)$"]))) break;
}
if (!(await dzClick(["^(create app|앱 만들기)$"]))) return { state: "unexpected", note: "마지막 앱 만들기 버튼을 찾지 못했어요" };
const end = Date.now() + 60000;
while (Date.now() < end) {
  const m = /\/apps\/(\d+)\//.exec(dzUrl());
  if (m) return { state: "ok", data: { appId: m[1] } };
  await sleep(1500);
}
return { state: "unexpected", note: "앱이 만들어졌는지 확인하지 못했어요" };`;

export const igTokenUrl = (appId: string) => `https://developers.facebook.com/apps/${encodeURIComponent(appId)}/instagram-business/API-Setup/`;
// Generates the long-lived token for the added Instagram account; the token shown on the page is POSTed to the receiver.
export const igToken = (postUrl: string): string => String.raw`
if (!(await dzWait("Instagram|API setup|API 설정", 25000))) return { state: "unexpected", note: "Instagram API 설정 화면이 열리지 않았어요" };
await sleep(2000);
if (!(await dzClick(["^(generate token|토큰 생성)$"]))) {
  if (await dzWait("add account|계정 추가", 1500)) return { state: "unexpected", note: "인스타 계정이 앱에 아직 추가되지 않았어요" };
  return { state: "unexpected", note: "토큰 생성 버튼을 찾지 못했어요" };
}
if (!(await dzWait("IG[A-Za-z0-9_-]{60,}", 30000))) return { state: "unexpected", note: "토큰이 화면에 보이지 않아요 (추가 확인 창이 떴을 수 있어요)" };
const ok = await dzPost({ access_token: "\\b(IG[A-Za-z0-9_-]{60,})" }, ${JSON.stringify(postUrl)});
return ok ? { state: "ok" } : { state: "unexpected", note: "화면에서 토큰을 읽지 못했어요" };`;

// ---- verification code -----------------------------------------------------------------------------------------------

export const CODE_HOSTS: Record<OtpService, string[]> = { google: ["accounts.google.com"], instagram: ["facebook.com", "instagram.com"], generic: ["accounts.google.com", "facebook.com", "instagram.com"] };

// Types the code (fetched once from a localhost URL, never in this text) into the code prompt a previous run left open,
// submits it and closes that tab.
export const codeBody = (url: string, hosts: string[]): string => `
const secret = await (await fetch(${JSON.stringify(url)})).text();
const sel = 'input[autocomplete="one-time-code"], input[name="idvPin"], input[name="Pin"], input[name="approvals_code"], input[name="verificationCode"], input[name="confirmationCode"], input[inputmode="numeric"], input[type="tel"]';
const hosts = ${JSON.stringify(hosts)};
for (const t of await listBrowserTabs()) {
  if (!hosts.some((h) => String(t.url).includes(h))) continue;
  await attachBrowserTab(t.targetId);
  const box = page.locator(sel).first();
  if (await box.count()) { await box.fill(secret); await box.press("Enter"); await sleep(4000); await closeTab(page).catch(() => {}); return { ok: true }; }
}
return { ok: false };`;
