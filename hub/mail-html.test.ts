import { expect, test } from "bun:test";
import { HUB_TOKEN } from "./config.ts";
import { mailByKey, postMail, type MailDeps } from "./mail.ts";
import { sanitizeMailHtml } from "./mailhtml.ts";
import { makeRoute } from "./routes.ts";

const events: Record<string, any>[] = [];
const deps: MailDeps = { createThread: async () => ({ id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, emit: e => void events.push(e), wake: () => {} };
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const get = (path: string, auth = true) => route(new Request(`http://hub.test${path}`, { headers: auth ? { "x-dotz-token": HUB_TOKEN } : {} }));
const b64 = (s: string) => Buffer.from(s).toString("base64");

const DIRTY = `<!doctype html><html><head><title>t</title><style>body{display:none}</style></head><body onload="x()"><!-- c --><script>alert(1)</script>
<table style="width:100%;background:url(http://tracker.example/a.png) #eee;position:fixed"><tr><td colspan="2" onclick="x()">셀 <b>굵게</b></td></tr></table>
<a href="javascript:alert(1)">bad</a><a href="https://example.com/x" onclick="x()">ok</a><img src="http://r.example/p.png" onerror="x()"><img src="cid:logo"><img src="data:image/png;base64,AAAA">
<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="a">입력 앞</form><svg><script>1</script></svg><object data="x"></object></body></html>`;

test("sanitizeMailHtml keeps layout, inline styles and safe links, and drops everything that runs, loads or submits", async () => {
	const out = await sanitizeMailHtml(DIRTY, { logo: "/api/mail/k/files/0" });
	for (const bad of ["<script", "<style", "<iframe", "<form", "<input", "<svg", "<object", "<title", "onload", "onclick", "onerror", "javascript:", "tracker.example", "position:fixed", "<!--", "evil.example"]) expect([bad, out.includes(bad)]).toEqual([bad, false]);
	expect(out).toContain("<table");
	expect(out).toContain('colspan="2"');
	expect(out).toContain("<b>굵게</b>");
	expect(out).toContain("width:100%");
	expect(out).toContain("입력 앞");
	expect(out).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">');
	expect(out).toContain('<img src="/api/mail/k/files/0">');
	expect(out).toContain('<img src="data:image/png;base64,AAAA">');
	expect(out).toContain('<img data-rsrc="http://r.example/p.png">');
	expect(out).not.toMatch(/<img[^>]*\ssrc="http/);
});

test("a posted HTML body is stored sanitized beside the mail, listed as a flag, and served with the web auth and a locked-down CSP", async () => {
	const r = await postMail({ source: "fixture", id: "html-1", subject: "HTML 메일", body: "텍스트 본문", html: DIRTY, attachments: [{ name: "logo.png", type: "image/png", data: b64("PNG"), cid: "<logo>" }] }, deps);
	expect(mailByKey(r.key)!.html).toBe(true);
	expect(mailByKey(r.key)!.attachments![0]!.cid).toBe("logo");
	expect(events.at(-1)!.html).toBe(true);
	const list = (await (await get("/api/conversations")).json()) as { items: { target: string; mail?: Record<string, any> }[] };
	expect(list.items.find(i => i.target === r.target)!.mail!.html).toBe(true);
	const res = await get(`/api/mail/${r.key}/body`);
	const body = await res.text();
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toStartWith("text/html");
	expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
	expect(body).toContain(`src="/api/mail/${r.key}/files/0"`);
	expect(body).not.toContain("<script");
	expect((await get(`/api/mail/${r.key}/body`, false)).status).toBe(403);
});

test("a mail without HTML, an unknown key and a traversal key have no body route", async () => {
	const r = await postMail({ source: "fixture", id: "text-only", subject: "텍스트", body: "그냥 글" }, deps);
	expect(mailByKey(r.key)!.html).toBeUndefined();
	for (const k of [r.key, "no-such-mail", "..%2f..%2fx"]) expect([k, (await get(`/api/mail/${k}/body`)).status]).toEqual([k, 404]);
});

test("an HTML body that is only markup noise is not kept", async () => {
	const r = await postMail({ source: "fixture", id: "html-empty", subject: "빈 HTML", html: "<script>1</script><style>a{}</style>" }, deps);
	expect(mailByKey(r.key)!.html).toBeUndefined();
});
