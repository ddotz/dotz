import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { now } from "./config.ts";
import { emit } from "./events.ts";
import { appKeyOf, integrationContext } from "./integrations.ts";
import { listNotices, NOTICE_CAP, setAppResolver, setOrchestratorAvailable } from "./notices.ts";

// A watch report is stamped with its app when it maps to an integration on this install; a plain dotz_watch report is not.
const dir = mkdtempSync(join(tmpdir(), "dotz-watch-app-"));
setAppResolver(n => appKeyOf(n, integrationContext(dir, ["zele"])));
setOrchestratorAvailable(() => false);
afterAll(() => {
	setAppResolver(() => undefined);
	setOrchestratorAvailable(() => true);
	rmSync(dir, { recursive: true, force: true });
});

const report = (watch: string, label: string, text: string) => emit("inbox", { ts: now(), kind: "watch", source: "watch", watch, label, reason: "output changed", text });
const watchNotice = (title: string) => listNotices(NOTICE_CAP).items.find(n => n.kind === "watch" && n.title === title)!;

test("a mail watch report is the mail app's and a normal watch report is not", () => {
	report("sample-mail-arrival", "메일 도착 점검", "a=1");
	report("sample-plain-check", "샘플 일반 점검", "b=1");
	expect(watchNotice("메일 도착 점검").app).toBe("mail");
	expect(watchNotice("샘플 일반 점검").app).toBeUndefined();
});
