import type { Run } from "./lib.ts";

const prelude = (run: Pick<Run, "port" | "loginCookie">): string => `
const ORIGIN = ${JSON.stringify(`http://localhost:${run.port}`)};
const COOKIE = ${JSON.stringify(run.loginCookie)};
const art = (name, data) => console.log('@@ART ' + name + ' ' + Buffer.from(data).toString('base64'));
const shot = async (p, name) => art(name, await p.screenshot());
const failNow = why => { console.log('@@FAIL ' + why); throw new Error(why); };
const textOf = p => p.evaluate(() => document.body.innerText);
const until = async (p, want, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await textOf(p)).includes(want)) return; await sleep(250); }
  art('failed.aria.txt', (await snapshot(p)).tree);
  await shot(p, 'failed.png');
  failNow('timed out waiting for text: ' + want + ' (failed.aria.txt, failed.png)');
};
const heights = { 390: 844, 1280: 900 };
const login = async () => {
  const t = await openTab(ORIGIN + '/');
  await t.evaluate(c => { document.cookie = 'dotz_local=' + c + '; path=/; SameSite=Strict'; }, COOKIE);
  if (!(await t.evaluate(c => document.cookie.includes(c), COOKIE))) failNow('dotz_local cookie not set on localhost (an HttpOnly dotz_local cookie for localhost already exists in this browser profile)');
  const status = await t.evaluate(async () => (await fetch('/api/state')).status);
  if (status !== 200) failNow('owner login refused: /api/state answered ' + status);
  await closeTab(t);
};
const logout = async () => {
  const t = await openTab(ORIGIN + '/');
  await t.evaluate(() => { document.cookie = 'dotz_local=; Max-Age=0; path=/'; });
  await closeTab(t);
};
const cold = async (hash, width, name, want) => {
  const t = await openTab('about:blank');
  await t.setViewportSize({ width, height: heights[width] });
  await t.goto(ORIGIN + '/' + hash);
  await until(t, want, 15000);
  await sleep(600);
  const s = await snapshot(t);
  art(name + '-' + width + '.aria.txt', s.tree);
  await shot(t, name + '-' + width + '.png');
  await closeTab(t);
};
`;

export const autoReplyScript = (run: Pick<Run, "port" | "loginCookie">): string => `${prelude(run)}
await login();
try {
  const p = await openTab('about:blank');
  await p.setViewportSize({ width: 390, height: heights[390] });
  await p.goto(ORIGIN + '/');
  await until(p, '답장 초안 확인', 15000);
  const s0 = await snapshot(p);
  art('home-before.aria.txt', s0.tree);
  await shot(p, 'home-before-390.png');
  await p.getByRole('button', { name: /답장 초안 확인/ }).click();
  await until(p, '보내지 않기', 10000);
  const s1 = await snapshot(p);
  art('replies-before.aria.txt', s1.tree);
  await shot(p, 'replies-before-390.png');
  await p.getByRole('button', { name: '보내기', exact: true }).click();
  await until(p, '되돌리기', 5000);
  const s2 = await snapshot(p);
  art('undo-window.aria.diff', s2.diff);
  await shot(p, 'undo-window-390.png');
  await until(p, '보냈어요', 45000);
  await sleep(600);
  const s3 = await snapshot(p);
  art('replies-after.aria.diff', s3.diff);
  await shot(p, 'replies-after-390.png');
  await closeTab(p);
} finally {
  await logout();
}
console.log('auto-reply browser step done');
`;

export const autoReplyColdScript = (run: Pick<Run, "port" | "loginCookie">, target: string): string => `${prelude(run)}
await login();
try {
  for (const w of [390, 1280]) {
    await cold('', w, 'cold-home', 'verify');
    await cold(${JSON.stringify(`#chat/${target}`)}, w, 'cold-mail-sent', '보낸 답장');
    await cold('#monitoring/replies', w, 'cold-replies', '기다리는 답장이 없어요');
  }
} finally {
  await logout();
}
console.log('auto-reply cold step done');
`;

export const appShellScript = (run: Pick<Run, "port" | "loginCookie">): string => `${prelude(run)}
await login();
try {
  for (const w of [390, 1280]) await cold('', w, 'cold-home', 'verify');
  const p = await openTab('about:blank');
  await p.setViewportSize({ width: 390, height: heights[390] });
  await p.goto(ORIGIN + '/');
  await until(p, 'verify', 15000);
  const seen = [];
  const routes = [['채팅', '#chat/main', 'verify'], ['프로젝트', '#projects', '프로젝트'], ['모니터링', '#monitoring', '모니터링'], ['설정', '#settings', '설정'], ['홈', '#home', '홈']];
  for (const [tab, hash, title] of routes) {
    await p.getByRole('navigation', { name: '메뉴' }).getByRole('button', { name: new RegExp('^' + tab) }).click();
    await sleep(800);
    const at = await p.evaluate(() => [location.hash, document.querySelector('h1')?.textContent?.trim() ?? '']);
    seen.push(tab + ' -> ' + at.join(' | '));
    if (at[0] !== hash || !at[1].startsWith(title)) failNow('tab ' + tab + ' opened ' + JSON.stringify(at) + ', expected ' + JSON.stringify([hash, title]));
  }
  art('nav.log', seen.join('\\n') + '\\n');
  await shot(p, 'nav-home-390.png');
  await closeTab(p);
} finally {
  await logout();
}
console.log('app-shell browser step done');
`;
