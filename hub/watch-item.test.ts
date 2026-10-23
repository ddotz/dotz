import { afterAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { emit } from "./events.ts";
import { appKeyOf, integrationContext } from "./integrations.ts";
import { recordMail } from "./mail.ts";
import { listNotices, NOTICE_CAP, setAppResolver, setOrchestratorAvailable } from "./notices.ts";
import { itemRefOf } from "./watchtext.ts";

// A DOTZ_ITEM line makes the report point at an app item; the hub resolves it when it stores the report.
setOrchestratorAvailable(() => false);
setAppResolver(n => appKeyOf(n, integrationContext("/nonexistent", ["zele"])));
afterAll(() => {
	setAppResolver(() => undefined);
	setOrchestratorAvailable(() => true);
});

const report = (label: string, text: string) => emit("inbox", { ts: now(), kind: "watch", source: "watch", watch: "sample-item", label, reason: "match", text });
const watchNotice = (title: string) => listNotices(NOTICE_CAP).items.find(n => n.kind === "watch" && n.title === title)!;

test("a DOTZ_ITEM line is a reference, with the subject and sender when printed", () => {
	expect(itemRefOf("MAIL 1 html=True atts=1\nDOTZ_ITEM mail:sample/66918600")).toEqual({ app: "mail", id: "sample/66918600" });
	expect(itemRefOf("DOTZ_ITEM mail:k-1\nsubject: 안녕\nfrom: A <a@example.com>")).toEqual({ app: "mail", id: "k-1", subject: "안녕", from: "A <a@example.com>" });
	expect(itemRefOf("MAIL 66918600 html=True atts=1")).toBeUndefined();
	expect(itemRefOf("see DOTZ_ITEM mail:x in text")).toBeUndefined();
});

test("a report that names a stored mail keeps its key and the mail row's data, and stays out of the app's list", () => {
	recordMail({ key: "sample-66918600", source: "sample", id: "66918600", subject: "샘플 제목", from: "샘플 <s@example.com>", at: now(), summary: "첫째 줄", attachments: [{ name: "a.pdf", type: "application/pdf", size: 10, file: "x" }] });
	report("메일 도착 점검", "MAIL 66918600 html=True atts=1\nDOTZ_ITEM mail:sample/66918600");
	const n = watchNotice("메일 도착 점검");
	expect(n.item?.key).toBe("sample-66918600");
	expect(n.item?.card).toMatchObject({ subject: "샘플 제목", summary: "첫째 줄", attachments: [{ name: "a.pdf" }] });
	expect(JSON.stringify(n.item)).not.toContain("\"file\"");
	expect(n.app).toBeUndefined();
	expect(n.text).toContain("DOTZ_ITEM mail:sample/66918600");
});

test("an unknown mail falls back to the printed subject and sender, else to no item card", () => {
	report("샘플 상대 점검", "DOTZ_ITEM mail:peer/9\nsubject: 상대 제목\nfrom: 상대");
	report("샘플 빈 점검", "DOTZ_ITEM mail:peer/10");
	const a = watchNotice("샘플 상대 점검"), b = watchNotice("샘플 빈 점검");
	expect(a.item).toEqual({ app: "mail", id: "peer/9", card: { subject: "상대 제목", from: "상대" } });
	expect(b.item).toEqual({ app: "mail", id: "peer/10" });
});

test("a report without DOTZ_ITEM has no item", () => {
	report("샘플 보통 점검", "a=1 b=2");
	expect(watchNotice("샘플 보통 점검").item).toBeUndefined();
});
