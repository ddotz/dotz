/* dotz demo transport: answers every /api/* request from demo/fixtures.js and keeps the stream silent.
   Loaded before app.js, so no request leaves this page and no real gateway is needed. */
(() => {
  const F = window.DEMO_FIXTURES;
  const NOTE = "데모에서는 실제로 보내지 않아요";
  const log = { unknown: [], posts: [] };
  window.__demoApi = log;

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fail = message => json({ error: message }, 409);
  const isOutward = body => /(^|["\s])(보내기|전송|send)(["\s]|$)/i.test(JSON.stringify(body || {}));
  const lastTs = t => (F.histories[t] || []).reduce((m, e) => Math.max(m, Date.parse(e.ts) || 0), 0);
  const stamp = t => new Date(Math.max(Date.now(), lastTs(t) + 1)).toISOString();
  const conv = t => F.conversations.find(c => c.target === t);
  const plain = s => String(s || "").replace(/[#*`>[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const unread = () => F.notices.items.filter(n => !n.read).length;

  function remember(t, e) {
    (F.histories[t] ||= []).push(e);
    const c = conv(t) || (F.conversations.push({ target: t, last: null, unread: 0, read: null }), conv(t));
    c.last = { ts: e.ts, text: plain(e.text), from: e.kind === "message" || e.kind === "lane_message" ? "owner" : "bot" };
    c.unread = 0;
    c.read = e.ts;
    if (e.kind === "message") F.state.notices_unread = unread();
  }

  function show(e) {
    if (typeof ingestMsg === "function" && typeof S !== "undefined" && S) ingestMsg(e);
  }

  function say(t, text, from) {
    const e = { ts: stamp(t), kind: from === "owner" ? "message" : "out", source: from === "owner" ? "web" : "orchestrator", target: t, ...(from === "owner" ? { channel: "web" } : {}), text };
    remember(t, e);
    show(e);
    return e;
  }

  function reply(t, text) {
    const e = { ts: stamp(t), kind: "out", source: "orchestrator", target: t, text };
    remember(t, e);
    show(e);
  }

  function answer(body) {
    const t = typeof target === "string" ? target : "main";
    const picks = Array.isArray(body.picks) ? body.picks : [];
    const text = String(body.text || "").trim() || (picks.length ? `${picks[0].n}) ${picks[0].label}` : "메시지");
    say(t, text, "owner");
    const pool = picks.length ? F.decisionReplies : F.replies;
    const line = pool[(picks.length ? F.decisionAt++ : F.replyAt++) % pool.length];
    setTimeout(() => reply(t, line), 1200);
    return { ok: true };
  }

  const lists = {
    "/api/monitors": { items: [] },
    "/api/integrations": { items: [] },
    "/api/workers": { items: [] },
    "/api/apps": { items: [] },
    "/api/approvals": { items: [] },
    "/api/devices": { items: [] },
    "/api/accounts": { providers: [], accounts: [] },
    "/api/runtimes": { runtimes: [] },
    "/api/messengers": { items: [] },
    "/api/replies": { items: [] },
    "/api/features": {},
    "/api/harness": { layers: [], projects: [] },
    "/api/api-budget": {},
    "/api/web-access": {},
    "/api/push/gateways": { items: [] },
    "/api/push": { subscribed: false },
    "/api/update": {},
    "/api/harness/update": {},
    "/api/queue": { items: [] },
    "/api/subagents": { sources: {} },
    "/api/context": { processes: [] },
    "/api/models": {
      orchestrator: { model: "deepseek/deepseek-v4.1-flash-ultrafast", thinking: "high" },
      thinking_levels: ["low", "medium", "high", "max"],
      available: [{ provider: "deepseek", selector: "deepseek/deepseek-v4.1-flash-ultrafast", name: "deepseek/deepseek-v4.1-flash-ultrafast", reasoning: true }],
      pickable: [{ provider: "deepseek", selector: "deepseek/deepseek-v4.1-flash-ultrafast", name: "deepseek/deepseek-v4.1-flash-ultrafast", reasoning: true }],
      targets: [],
    },
    "/api/providers": { providers: [] },
    "/api/quota": {},
    "/api/target": { context: {} },
    "/api/machine": {},
    "/api/peers": [],
  };

  function get(u) {
    const p = u.pathname;
    if (p === "/api/state") return json({ ...F.state, notices_unread: unread() });
    if (p === "/api/history") return json({ target: u.searchParams.get("target") || "main", events: F.histories[u.searchParams.get("target")] || [] });
    if (p === "/api/todo") return json(F.todo);
    if (p === "/api/conversations") return json({ items: F.conversations });
    if (p === "/api/notices") return json({ ...F.notices, unread: unread() });
    if (p === "/api/custom") return json({ dir: "", cards: [], projects: F.projects, routines: [], links: [] });
    if (p === "/api/custom/project") return json(F.projects.find(x => x.key === u.searchParams.get("key")) || {});
    if (p === "/api/activity") return json({ items: [], more: false, history: false });
    if (p === "/api/canvas") return json({ path: u.searchParams.get("path") || "", text: F.canvases[u.searchParams.get("path")] || "" });
    if (lists[p] !== undefined) return json(lists[p]);
    return json({});
  }

  function post(u, body) {
    const p = u.pathname;
    log.posts.push(p);
    if (p === "/api/message") return isOutward(body) ? fail(NOTE) : json(answer(body));
    if (p === "/api/command") return json({ output: "데모에서는 명령을 실행하지 않아요." });
    if (p === "/api/read") { const c = conv(body.target); if (c) c.unread = 0; return json({}); }
    if (p === "/api/notices/read") { for (const n of F.notices.items) n.read = true; return json({ unread: 0 }); }
    if (p === "/api/notices/reopen") return json({ unread: unread() });
    if (/^\/api\/notices\/[^/]+\/answer$/.test(p)) return isOutward(body) ? fail(NOTE) : json({});
    if (isOutward(body)) return fail(NOTE);
    return json({});
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) {
      log.unknown.push(`external ${url.href}`);
      return json({});
    }
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    let body;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = {}; } }
    if (method === "GET") return get(url);
    if (method === "POST" || method === "PUT" || method === "DELETE") {
      if (!body && u_(url, "/api/message")) body = {};
      return post(url, body || {});
    }
    return json({});
  };
  function u_(url, p) { return url.pathname === p; }

  const ES = function () {
    this.readyState = 1;
    this.url = "/api/events";
    this.onopen = null; this.onmessage = null; this.onerror = null;
  };
  ES.CONNECTING = 0; ES.OPEN = 1; ES.CLOSED = 2;
  ES.prototype.addEventListener = function () {};
  ES.prototype.removeEventListener = function () {};
  ES.prototype.close = function () { this.readyState = 2; };
  window.EventSource = ES;

  const sw = navigator.serviceWorker;
  if (sw) {
    const reg = { active: null, waiting: null, installing: null, pushManager: { getSubscription: async () => null, subscribe: async () => { throw new Error("demo"); } }, getNotifications: async () => [] };
    try { Object.defineProperty(sw, "register", { configurable: true, value: async () => reg }); } catch {}
    try { Object.defineProperty(sw, "ready", { configurable: true, get: () => Promise.resolve(reg) }); } catch {}
  }

  if (!location.hash) history.replaceState(null, "", `${location.pathname}#chat/main`);
})();
