import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

// 모니터링 over a fixed gateway: every plain monitor row and its conversation carries a last-run → next-run bar with the result as a tag,
// a disconnected app or watch says so at once with 지금 다시 확인, and 감시 소식 opens with every plain monitor at a glance. The times are
// built from the wall clock (new Date(), untouched by the test clock) so the page's own Date.now() puts the ok bar at about half.
const SHOTS = process.env.MONITORING_SHOTS ?? "/var/folders/80/2k5mvzgd4bncllljjdswkq7c0000gn/T/ux2run.bWW2O3bIEF/shots/t3";
mkdirSync(SHOTS, { recursive: true });
const T0 = new Date().getTime();
const at = (ms: number) => new Date(ms).toISOString();
const WINDOW = 20 * 60_000;
const base = (name: string, watch: string, extra: Record<string, unknown> = {}) => ({ name, watch, kind: "watch", last_run: at(T0 - WINDOW / 2), next_run: at(T0 + WINDOW / 2), last_result: "ok", connection: "connected", every: "20분마다", ...extra });
const many = Array.from({ length: 45 }, (_, i) => ({ id: `many-${i}`, kind: "watch", tone: "", title: "많은 감시", text: `많은 감시: 결과 ${i + 1}번째 확인이에요`, ts: at(T0 - (45 - i) * 60_000), read: true }));
const initial = (): Record<string, unknown>[] => [
  base("절반 감시", "half-watch", { last_summary: "모두 정상이에요" }),
  base("실패 감시", "fail-watch", { last_result: "fail", fails: 1, last_summary: "로그인이 풀렸어요" }),
  base("끊긴 감시", "down-watch", { connection: "disconnected", since: at(T0 - 2 * 3600_000), conn_reason: "login", last_result: "fail", fails: 3 }),
  base("늦은 감시", "late-watch", { last_run: at(T0 - 40 * 60_000), next_run: at(T0 - 10 * 60_000), last_summary: "새 소식이 없어요" }),
  base("많은 감시", "many-watch", { last_summary: "확인을 마쳤어요" }),
];
let monitors = initial();
beforeEach(() => { monitors = initial(); runs.length = 0; });
const notices: Record<string, unknown>[] = [...many];
const runs: string[] = [];
const json = (v: unknown, status = 200) => Response.json(v, { status });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    if (p === "/") return indexPage(req);
    const asset = appAsset(req, p);
    if (asset) return asset;
    if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
    if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0, schedules: [], events: [] });
    if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }]);
    if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
    if (p === "/api/monitors") return json({ items: monitors });
    if (p === "/api/notices") return json({ unread: 0, items: notices });
    if (p === "/api/integrations") return json({ items: [], available: [] });
    if (p === "/api/conversations") return json({ items: [] });
    if (p === "/api/monitoring/peers") return json([]);
    if (p.startsWith("/api/history")) return json({ target: url.searchParams.get("target") ?? "", events: [] });
    const run = /^\/api\/watches\/([a-z0-9-]+)\/run$/.exec(p);
    if (run && req.method === "POST") {
      const name = run[1]!;
      runs.push(name);
      const now = new Date().getTime();
      const item = base(name === "down-watch" ? "끊긴 감시" : "절반 감시", name, { last_run: at(now), next_run: at(now + WINDOW), last_summary: "다시 확인했어요" });
      monitors = monitors.map(m => (m.watch === name ? item : m));
      return json({ ok: true, item });
    }
    return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
  },
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
  v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
const boot = async (width: number, height: number) => {
  const v = new Bun.WebView({ width, height });
  views.push(v);
  await v.navigate(`http://127.0.0.1:${server.port}/`);
  await waitFor(v, `S && NM.loaded && NT.loaded && PR.fresh && NM.items.length === 5`);
  await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
  await run(v, `go("monitoring")`);
  return v;
};
const row = (name: string) => `[data-k="m:${name}"]`;
const rowProg = (name: string) => `document.querySelector('${row(name)} .mon-prog-wrap')`;

describe("a monitor row and its conversation", () => {
  test("the ok bar is halfway, each result shows as a tag, and an overdue bar is full in the warn tone", async () => {
    const v = await boot(1280, 900);
    await waitFor(v, rowProg("절반 감시"));
    const pct = await q<number>(v, `const f = document.querySelector('${row("절반 감시")} .mon-prog i'); return parseFloat(f.style.width || "")`);
    expect(pct).toBeGreaterThan(48);
    expect(pct).toBeLessThan(53);
    // One result tag per row: the right badge. The bar has none, and its meta line is the short form that fits the left column.
    expect(await q(v, `return document.querySelector('${row("절반 감시")} .cv-m .tag').textContent`)).toBe("정상");
    expect(await q(v, `return document.querySelectorAll('${row("절반 감시")} .mon-prog .mon-ptag').length`)).toBe(0);
    expect(await q(v, `return document.querySelector('${row("절반 감시")} .mon-prog-tx').textContent`)).toMatch(/^\d+분 전 · \d+분 후$/);
    const fit = await q<boolean>(v, `const t = document.querySelector('${row("절반 감시")} .mon-prog-tx'); return t.scrollWidth <= t.clientWidth + 1`);
    expect(fit).toBe(true);
    expect(await q(v, `return document.querySelector('${row("실패 감시")} .cv-m .tag').textContent`)).toBe("실패");
    expect(await q(v, `return document.querySelector('${row("끊긴 감시")} .cv-m .tag').textContent`)).toBe("연결 끊김");
    expect(await q(v, `return document.querySelector('${row("끊긴 감시")}').textContent`)).toContain("연결 끊김");
    const downFit = await q<boolean>(v, `const t = document.querySelector('${row("끊긴 감시")} .cv-p'); return t.scrollWidth <= t.clientWidth + 1 && /^연결 끊김 · .+부터$/.test(t.textContent)`);
    expect(downFit).toBe(true);
    expect(await q(v, `const p = document.querySelector('${row("늦은 감시")} .mon-prog'); return [p.classList.contains("warn"), parseFloat(p.querySelector("i").style.width)]`)).toEqual([true, 100]);
    expect(await q(v, `return document.querySelector('${row("늦은 감시")} .cv-m .tag').textContent`)).toBe("늦어짐");
    await Bun.write(join(SHOTS, "monitoring-1280.png"), await v.screenshot());
  });

  test("a disconnected monitor opens with the banner and its hint, and 지금 다시 확인 runs it and repaints the new state", async () => {
    runs.length = 0;
    const v = await boot(1280, 900);
    await run(v, `go("monitoring", "m:끊긴 감시")`);
    await waitFor(v, `document.querySelector("#mon-head .mon-banner")`);
    expect(await q(v, `return document.querySelector("#mon-head .mon-banner").textContent`)).toMatch(/연결 끊김.*다시 로그인 필요/);
    expect(await q(v, `return document.querySelector("#mon-head .mon-banner .mon-recheck").textContent`)).toBe("지금 다시 확인");
    expect(await q(v, `return [document.querySelectorAll("#mon-head [data-run]").length, document.querySelectorAll("#mon-tl [data-run]").length, document.querySelectorAll(".mon-recheck").length]`)).toEqual([0, 0, 1]);
    expect(await q(v, `return document.querySelector("#mon-head .mon-banner .mon-banner-tx").textContent`)).toMatch(/^연결 끊김 · .+부터 · 다시 로그인 필요$/);
    await Bun.write(join(SHOTS, "monitoring-detail-1280.png"), await v.screenshot());
    await run(v, `document.querySelector("#mon-head .mon-banner .mon-recheck").click()`);
    await waitFor(v, `!MON.running.size && !document.querySelector("#mon-head .mon-banner") && document.querySelector("#mon-head .mon-ptag").textContent === "정상"`);
    expect(runs).toEqual(["down-watch"]);
    expect(await q(v, `return document.querySelector("#mon-head .mon-ptag").textContent`)).toBe("정상");
    expect(await q(v, `return document.querySelector("#mon-head .mon-prog-tx").textContent`)).toContain("지난 실행");
    expect(await q(v, `return [document.querySelectorAll("#mon-head [data-run]").length, document.querySelectorAll(".mon-recheck").length]`)).toEqual([1, 0]);
  });

  test("a phone puts the same bar, banner and 지금 확인 at the top of the conversation", async () => {
    const v = await boot(390, 844);
    await waitFor(v, `document.querySelector('${row("절반 감시")} .mon-prog-tx')`);
    const fit = await q<boolean>(v, `const t = document.querySelector('${row("절반 감시")} .mon-prog-tx'); return t.scrollWidth <= t.clientWidth + 1`);
    expect(fit).toBe(true);
    const downFit = await q<boolean>(v, `const t = document.querySelector('${row("끊긴 감시")} .cv-p'); return t.scrollWidth <= t.clientWidth + 1 && /^연결 끊김 · .+부터$/.test(t.textContent)`);
    expect(downFit).toBe(true);
    await Bun.write(join(SHOTS, "monitoring-list-390.png"), await v.screenshot());
    await run(v, `go("monitoring", "m:끊긴 감시")`);
    await waitFor(v, `document.querySelector("#mon-tl .mon-banner") && document.querySelector("#mon-tl .mon-prog")`);
    expect(await q(v, `return document.querySelector("#mon-tl .mon-banner").textContent`)).toContain("연결 끊김");
    expect(await q(v, `return [document.querySelectorAll("#mon-tl [data-run]").length, document.querySelectorAll("#mon-tl .mon-recheck").length]`)).toEqual([0, 1]);
    await Bun.write(join(SHOTS, "monitoring-390.png"), await v.screenshot());
    expect(await q<number>(v, `return document.documentElement.scrollWidth`)).toBeLessThanOrEqual(390);
    await run(v, `go("monitoring", "m:절반 감시")`);
    await waitFor(v, `document.querySelector("#mon-tl [data-run]")`);
    expect(await q(v, `return document.querySelector("#mon-tl [data-run]").textContent`)).toBe("지금 확인");
    expect(await q(v, `return document.querySelector("#mon-tl [data-run]").classList.contains("as-tpl")`)).toBe(true);
  });
});

describe("감시 소식", () => {
  test("opens with every plain monitor, what needs the owner first, and a tap opens that monitor", async () => {
    const v = await boot(1280, 900);
    await run(v, `go("monitoring", "notice")`);
    await waitFor(v, `document.querySelectorAll(".mon-ov-row").length === 5`);
    const rows = await q<{ text: string; tag: string; name: string }[]>(v, `return [...document.querySelectorAll(".mon-ov-row")].map(r => ({ text: r.textContent, tag: r.querySelector(".mon-ptag").textContent, name: r.dataset.ov }))`);
    expect(rows[0]!.name).toBe("m:끊긴 감시");
    expect(rows[0]!.tag).toBe("연결 끊김");
    expect(rows[1]!.name).toBe("m:실패 감시");
    expect(rows[2]!.name).toBe("m:늦은 감시");
    for (const r of rows) expect(r.text.length).toBeGreaterThan(0);
    expect(rows.every(r => r.text.includes("·") || r.text.includes("요"))).toBe(true);
    await run(v, `document.querySelector(".mon-ov-row").click()`);
    await waitFor(v, `MON.sel === "m:끊긴 감시"`);
  });
});

describe("older reports", () => {
  test("reaching the top loads the previous page by itself, anchored, and the button is gone", async () => {
    const v = await boot(1280, 900);
    await run(v, `go("monitoring", "m:많은 감시")`);
    await waitFor(v, `document.querySelector("#mon-tl .mon-sentinel") && document.querySelectorAll("#mon-tl [data-nid]").length === 30`);
    await run(v, `const b = document.querySelector("#mon-timeline"); b.scrollTop = 0; b.dispatchEvent(new Event("scroll"))`);
    await waitFor(v, `document.querySelectorAll("#mon-tl [data-nid]").length === 45`);
    expect(await q(v, `return document.querySelector("#mon-tl .mon-sentinel")`)).toBe(null);
    expect(await q(v, `return document.querySelector("#mon-tl").textContent.includes("이전 소식")`)).toBe(false);
    expect(await q<number>(v, `return document.querySelector("#mon-timeline").scrollTop`)).toBeGreaterThan(0);
  });
});
