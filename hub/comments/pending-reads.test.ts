import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceConfig } from "./contract.ts";
import { createEngine, type MailLink } from "./engine.ts";

const DRAFTS = 40;
const dir = mkdtempSync(join(tmpdir(), "pending-reads-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"] };
const mail = { view: (id: string) => ({ id, to: "a@example.com", subject: "악보", body: "b", attachments: [] }), state: () => "pending" } as unknown as MailLink;
const engine = createEngine({ dir, now: () => 1_000, collector: "mac-a", adapters: {}, model: async () => ({ text: "" }), mail });

test("asking for the drafts again parses the file only when it changed", () => {
	engine.store.putDraft({ code: "X1", commentId: "cx", source: "youtube", thread: "p1", text: "답글", status: "pending", created: 1, changes: [], clean: false, notes: [] });
	engine.store.drafts();
	const parse = spyOn(JSON, "parse");
	for (let n = 0; n < 30; n++) engine.store.drafts();
	const parsed = parse.mock.calls.length;
	parse.mockRestore();
	expect(parsed).toBe(0);
	engine.store.setDraftStatus("X1", "dropped");
	expect(engine.store.drafts().find(d => d.code === "X1")?.status).toBe("dropped");
});

test("the reply queue reads no store once per draft that carries a mail", () => {
	engine.store.saveConfig({ enabled: true, sources: { youtube: source } });
	for (let n = 0; n < DRAFTS; n++) engine.store.putDraft({ code: `D${n}`, commentId: `c${n}`, source: "youtube", thread: "p1", text: "답글", status: "pending", created: n, changes: [], clean: false, notes: [], mail: `M${n}` });
	const parse = spyOn(JSON, "parse");
	const items = engine.pendingDrafts();
	const parsed = parse.mock.calls.length;
	parse.mockRestore();
	expect(items).toHaveLength(DRAFTS);
	expect(parsed).toBeLessThan(DRAFTS / 2);
});
