// A website's DM inbox (`site.dm`): messages are read with the comments into threads `dm:<room>`, a DM read failure keeps the comments and is
// reported, a reply goes to the DM post hook and counts only when reading the room back shows it, and an answered room needs no reply.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentId, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";
import { type Exec, splitCursor, websiteAdapter } from "./adapters/website.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SITE: SourceConfig = {
	key: "site-shop",
	kind: "website",
	label: "w",
	watch: ["*"],
	autoDraft: false,
	site: { read: { kind: "script", command: ["read-comments"] }, post: { kind: "script", command: ["post-comment"] }, dm: { read: { kind: "script", command: ["read-dm"] }, post: { kind: "script", command: ["post-dm"] } } },
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "site-dm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeSite(o: { dmFails?: boolean; landed?: boolean } = {}) {
	const calls: { argv: string[]; stdin?: string }[] = [];
	const room: { id: string; author: string; text: string; at: string; mine?: boolean }[] = [{ id: "m1", author: "Buyer", text: "Is the file updated?", at: iso(NOW - 5000) }];
	const exec: Exec = async (argv, stdin) => {
		calls.push({ argv, ...(stdin !== undefined ? { stdin } : {}) });
		const out = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
		if (argv[0] === "read-comments") return out({ comments: [{ id: "c1", thread: "post-1", author: "A", text: "nice", at: iso(NOW - 9000) }], cursor: "c-1" });
		if (argv[0] === "read-dm") {
			if (o.dmFails) return { code: 1, stdout: "", stderr: "login expired" };
			return out({ messages: room.map(m => ({ room: "r9", ...m })), cursor: "d-1" });
		}
		if (argv[0] === "post-dm") {
			const body = JSON.parse(stdin!) as { room: string; text: string };
			if (o.landed !== false) room.push({ id: "m2", author: "me", text: body.text, at: iso(NOW), mine: true });
			return out({ ok: true });
		}
		return out({ ok: true });
	};
	return { calls, exec };
}

function engineWith(exec: Exec) {
	const engine = createEngine({ dir, now: () => NOW, collector: "m", adapters: { website: websiteAdapter({ exec, fetch, secretsDir: dir, siteDir: dir }) } });
	engine.store.saveConfig({ enabled: true, sources: { [SITE.key]: SITE } });
	return engine;
}

test("DMs are read with the comments, into one thread per room, with both cursors kept", async () => {
	const s = fakeSite();
	const engine = engineWith(s.exec);
	const r = await engine.collect({ force: true });
	expect(r.added.map(c => c.thread)).toEqual(["post-1", "dm:r9"]);
	expect(splitCursor(engine.store.cursors()[SITE.key]!.cursor)).toEqual({ c: "c-1", d: "d-1" });
	expect(engine.needsReply(engine.store.comments().find(c => c.thread === "dm:r9")!)).toBe(true);
	await engine.collect({ force: true });
	expect(s.calls.filter(c => c.argv[0] === "read-dm").at(-1)!.argv).toEqual(["read-dm", "--since", "d-1"]);
});

test("a DM read failure keeps the comments and is the source's error", async () => {
	const engine = engineWith(fakeSite({ dmFails: true }).exec);
	const r = await engine.collect({ force: true });
	expect(r.added.map(c => c.thread)).toEqual(["post-1"]);
	expect(r.errors[SITE.key]).toBe("쪽지함: login expired");
});

test("a DM reply goes to the DM hook and is sent only when reading the room back shows it", async () => {
	for (const landed of [true, false]) {
		rmSync(dir, { recursive: true, force: true });
		const s = fakeSite({ landed });
		const engine = engineWith(s.exec);
		await engine.collect({ force: true });
		const step = await engine.addDraft(commentId(SITE.key, "dm:r9:m1"), "Yes, it is updated.");
		if (!step.ok) throw new Error(step.reason);
		const sent = engine.send(step.draft.code, { by: "owner" });
		if (!sent.ok) throw new Error(sent.reason);
		const done = await sent.done;
		expect(JSON.parse(s.calls.find(c => c.argv[0] === "post-dm")!.stdin!)).toMatchObject({ room: "r9", text: "Yes, it is updated." });
		expect(s.calls.some(c => c.argv[0] === "post-comment")).toBe(false);
		expect(s.calls.at(-1)!.argv).toEqual(["read-dm", "--room", "r9"]);
		expect(done.state).toBe(landed ? "sent" : "failed");
	}
});

test("a room the owner already wrote in after the message needs no reply", async () => {
	const s = fakeSite();
	const engine = engineWith(s.exec);
	await engine.collect({ force: true });
	const dm = engine.store.comments().find(c => c.thread === "dm:r9")!;
	engine.store.addComments([{ ...dm, id: commentId(SITE.key, "dm:r9:m2"), native: "dm:r9:m2", text: "answered on the site", mine: true, at: NOW }]);
	expect(engine.needsReply(dm)).toBe(false);
});
