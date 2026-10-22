import { afterAll, expect, test } from "bun:test";
import { capture } from "../lib/capture.ts";
import { cookieHostsFor, endpointUrl, parseJson } from "../lib/spec.ts";
import { list, mapMails, probeRead, read } from "../lib/adapter.ts";
import { defaultConfig, type Ctx } from "../lib/config.ts";
import { initialState, MAX_MAIL_LINES, pollOnce } from "../lib/watchkit.ts";
import { watchSpec } from "../bin/setup.ts";
import { startFakeServer, mkMail } from "./fakeserver.ts";

const servers: ReturnType<typeof startFakeServer>[] = [];
const serve = (...a: Parameters<typeof startFakeServer>) => {
	const s = startFakeServer(...a);
	servers.push(s);
	return s;
};
afterAll(() => servers.forEach((s) => s.close()));
const ctxFor = (srv: ReturnType<typeof startFakeServer>): Ctx => ({ fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 0, sleep: async () => {}, log: () => {} });

test("XSSI-guarded JSON is parsed, not mistaken for a logout", async () => {
	expect(parseJson(`)]}',\n{"a":1}`)).toEqual({ a: 1 });
	expect(parseJson(`while(1);{"a":2}`)).toEqual({ a: 2 });
	const srv = serve([mkMail(1)], { xssi: true });
	const { state, mails } = await list(ctxFor(srv), srv.spec);
	expect(state.kind).toBe("ok");
	expect(mails).toHaveLength(1);
});

test("cookie hosts never include a public suffix", () => {
	expect(cookieHostsFor("mail.example.co.kr")).toEqual(["mail.example.co.kr", ".mail.example.co.kr", ".example.co.kr", "example.co.kr"]);
	expect(cookieHostsFor("mail.example.com")).toContain(".example.com");
	expect(cookieHostsFor("mail.example.com")).not.toContain(".com");
	expect(cookieHostsFor("localhost")).toEqual(["localhost"]);
});

test("a POST read with a form body is captured as a template and replayed", async () => {
	const srv = serve([mkMail(7), mkMail(6)]);
	const listBody = JSON.stringify({ mails: [{ id: 7, subject: "a", from: "x", date: "d" }, { id: 6, subject: "b", from: "y", date: "d" }] });
	const res = capture("post", [
		{ url: `${srv.origin}/mail/mboxes/100/mails`, status: 200, contentType: "application/json", responseBody: listBody },
		{ url: `${srv.origin}/mail/read`, method: "POST", requestBody: "mailId=7&view=full", status: 200, contentType: "application/json", responseBody: JSON.stringify({ data: { content: `<div>${"x".repeat(200)}</div>` } }) },
	]);
	expect(res.kind).toBe("ok");
	expect(res.readGuessed).toBe(false);
	expect(res.spec!.read).toMatchObject({ path: "/mail/read", method: "POST", body: "mailId={id}&view=full", bodyType: "form", bodyPath: "data.content" });
	const d = await read(ctxFor(srv), res.spec!, "6");
	expect(d.body).toBe("body of 6");
});

test("a read addressed by a query parameter keeps the parameter as a template", () => {
	const res = capture("q", [
		{ url: "https://m.example.test/api/list?folder=inbox&size=50", status: 200, contentType: "application/json", responseBody: JSON.stringify({ items: [{ msgId: "a1", title: "t", sender: "s", sentAt: "d" }] }) },
		{ url: "https://m.example.test/api/view?msgId=a1&fmt=html", status: 200, contentType: "application/json", responseBody: JSON.stringify({ body: `<p>${"y".repeat(200)}</p>` }) },
	]);
	expect(res.kind).toBe("ok");
	expect(res.spec!.list.params).toEqual({ folder: "inbox", size: "50" });
	expect(res.spec!.read.params).toEqual({ msgId: "{id}", fmt: "html" });
	expect(endpointUrl(res.spec!.origin, res.spec!.read, { id: "z9" })).toBe("https://m.example.test/api/view?msgId=z9&fmt=html");
});

test("Y/N read flags are read correctly", () => {
	const srv = serve([]);
	const spec = { ...srv.spec, list: { ...srv.spec.list, fields: { ...srv.spec.list.fields, read: "seen" } } };
	const mails = mapMails(spec, { mails: [{ id: 1, seen: "N" }, { id: 2, seen: "Y" }, { id: 3, seen: 0 }] });
	expect(mails.map((m) => m.read)).toEqual([false, true, false]);
});

test("the read probe finds the endpoint when the recording never opened a mail", async () => {
	const srv = serve([mkMail(3)]);
	const found = await probeRead(ctxFor(srv), srv.spec, "3", [{ path: "/nope/{id}", bodyPath: "" }, { path: "/mail/mails/{id}", bodyPath: "" }]);
	expect(found?.path).toBe("/mail/mails/{id}");
	expect(found?.bodyPath).toBe("html");
});

test("a large backlog after an outage is capped, with one summary line", async () => {
	const srv = serve([mkMail(1)]);
	const ctx = ctxFor(srv);
	const config = defaultConfig("fake");
	const s = (await pollOnce(ctx, srv.spec, config, initialState(), async () => false)).state;
	srv.setMails(Array.from({ length: 25 }, (_, i) => mkMail(100 + i)).reverse());
	const r = await pollOnce(ctx, srv.spec, config, s, async () => false);
	expect(r.lines).toHaveLength(MAX_MAIL_LINES + 1);
	expect(r.lines[0]).toStartWith("mail-backlog 15");
	expect(r.lines.at(-1)).toContain("mail 124");
});

test("the new-mail watch wakes the orchestrator in the mail channel", () => {
	const w = watchSpec("work", { ...defaultConfig("work"), channel: "ch:42" });
	expect(w.to).toBe("orchestrator");
	expect(w.channels).toEqual(["42"]);
	expect(w.on).toBe("match");
});
