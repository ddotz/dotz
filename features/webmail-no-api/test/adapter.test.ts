import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list, read, search, makeDraft } from "../lib/adapter.ts";
import { runSend, runDraft, approveSend, sendApproved, draftPath } from "../bin/mail.ts";
import { type Ctx } from "../lib/config.ts";
import { startFakeServer, mkMail } from "./fakeserver.ts";

process.env.DOTZ_DIR = mkdtempSync(join(tmpdir(), "wm-adapter-"));
const srv = startFakeServer([mkMail(3), mkMail(2), mkMail(1)]);
const ctx: Ctx = { fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 1_700_000_000_000, sleep: async () => {}, log: () => {} };

afterAll(() => srv.close());

test("list maps the captured fields into mails", async () => {
	const { state, mails } = await list(ctx, srv.spec);
	expect(state.kind).toBe("ok");
	expect(mails.map((m) => m.id)).toEqual(["3", "2", "1"]);
	expect(mails[0].from).toBe("sender3@example.test");
	expect(mails[0].subject).toBe("subject 3");
});

test("read returns the body rendered to text", async () => {
	const d = await read(ctx, srv.spec, "2");
	expect(d.body).toBe("body of 2");
});

test("search filters by the query", async () => {
	const hits = await search(ctx, srv.spec, "subject 1");
	expect(hits.map((m) => m.id)).toEqual(["1"]);
});

test("a dropped session is reported, not mistaken for an empty inbox", async () => {
	srv.setLoggedOut(true);
	const { state, mails } = await list(ctx, srv.spec);
	expect(state.kind).toBe("loggedout");
	expect(mails).toEqual([]);
	srv.setLoggedOut(false);
});

test("makeDraft never contacts the server and carries the fields", () => {
	const d = makeDraft(1_700_000_000_000, { to: "a@b.test", subject: "hi", body: "x" });
	expect(d.id).toStartWith("d-");
	expect(d.to).toBe("a@b.test");
});

test("send is refused without the owner's approval marker, allowed with it", async () => {
	const site = "fake";
	const { draft } = runDraft(site, 1_700_000_000_000, { to: "a@b.test", subject: "hi", body: "x" });
	expect(draftPath(site, draft.id)).toContain("webmail");

	const refused = await runSend(ctx, srv.spec, site, draft.id, Date.now());
	expect(refused.code).toBe(2);

	approveSend(site, Date.now());
	expect(sendApproved(site, Date.now())).toBe(true);
	const ok = await runSend(ctx, srv.spec, site, draft.id, Date.now());
	expect(ok.code).toBe(0);
});
