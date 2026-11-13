// `mail.ts send` says where the mail is by its exit code and reason (design 2.3, webmail table): 0 sent, 1 surely not sent, 2 not approved,
// 3 may have been sent, 4 login expired. The site is a fake `ctx.fetch` that answers each row, so nothing depends on a real server.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveSend, runDraft, runSend } from "../bin/mail.ts";
import { type Ctx } from "../lib/config.ts";
import { type SiteSpec } from "../lib/spec.ts";

const dir = mkdtempSync(join(tmpdir(), "wm-outcome-"));
const before = process.env.DOTZ_DIR;
process.env.DOTZ_DIR = dir;
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});

const spec = { version: 1, site: "corp", origin: "http://corp.test", cookieHosts: ["corp.test"], list: { path: "/m", listPath: "m", fields: { id: "id" } }, read: { path: "/m/{id}", bodyPath: "b" }, send: { path: "/send" } } as unknown as SiteSpec;
const ctxOf = (post: () => Promise<Response>): Ctx => ({ fetch: (async () => post()) as unknown as typeof fetch, cookieHeader: async () => "s=1", now: () => 0, sleep: async () => {}, log: () => {} });
const err = (name: string, message: string, code?: string) => Object.assign(new Error(message), { name, ...(code ? { code } : {}) });

// One approved draft, sent through a site whose POST does `post`; returns "<exit> <sent> <code>".
async function where(post: () => Promise<Response>, approve = true): Promise<string> {
	const { draft } = runDraft("corp", Date.now(), { to: "kim@example.com", subject: "Re: 문의", body: "확인했어요" });
	if (approve) approveSend("corp", Date.now());
	const r = await runSend(ctxOf(post), spec, "corp", draft.id, Date.now());
	return `${r.code} ${r.reason?.sent} ${r.reason?.code ?? "-"}`;
}

test("a POST the site accepted is sent", async () => {
	expect(await where(async () => new Response("{}", { status: 200 }))).toBe("0 yes -");
});

test("refusals before the POST are surely not sent", async () => {
	expect(await where(async () => new Response("{}"), false)).toBe("2 no not_approved");
	const r = await runSend(ctxOf(async () => new Response("{}")), spec, "corp", "nope", Date.now());
	expect(`${r.code} ${r.reason?.sent} ${r.reason?.code}`).toBe("1 no gone");
	const { draft } = runDraft("corp", Date.now(), { to: "kim@example.com", subject: "Re: x", body: "y" });
	const noSend = await runSend(ctxOf(async () => new Response("{}")), { ...spec, send: undefined } as SiteSpec, "corp", draft.id, Date.now());
	expect(`${noSend.code} ${noSend.reason?.sent} ${noSend.reason?.code}`).toBe("1 no manual_only");
});

test("the site's answer decides: 401/403 login, other 4xx rejected, 5xx may have gone out", async () => {
	expect(await where(async () => new Response("", { status: 401 }))).toBe("4 no login_expired");
	expect(await where(async () => new Response("", { status: 403 }))).toBe("4 no login_expired");
	expect(await where(async () => new Response("", { status: 422 }))).toBe("1 no rejected");
	expect(await where(async () => new Response("", { status: 502 }))).toBe("3 maybe server_error");
});

test("a POST that never connected sent nothing; a timeout or a cut connection may have", async () => {
	expect(await where(async () => { throw err("Error", "connect ECONNREFUSED 10.0.0.1:443", "ECONNREFUSED"); })).toBe("1 no offline");
	expect(await where(async () => { throw err("TimeoutError", "The operation timed out."); })).toBe("3 maybe timeout");
	expect(await where(async () => { throw err("Error", "socket hang up", "ECONNRESET"); })).toBe("3 maybe net_cut");
});
