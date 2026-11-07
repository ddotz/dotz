// `mailbox-cli.ts fold`: per-source mail instances become mailboxes of one account, as data only, and undo puts every file back.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldPlan, run } from "./mailbox-cli.ts";
import { boxesOf, boxOfSource } from "./mailbox.ts";
import { instanceOf } from "./routes-mailbox.ts";

const root = mkdtempSync(join(tmpdir(), "mailbox-fold-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const APPS = {
	mail: { filter: { account: "me@example.org" } },
	"mail-orders": { app: "mail", label: "요청", notify: false, discord: true, filter: { source: "orders", account: "me@example.org", watches: ["w-mail"] } },
	"mail-general": { app: "mail", label: "일반 메일", filter: { source: "general", account: "me@example.org" } },
	"mail-2": { app: "mail", label: "회사", filter: { source: "work", account: "work@example.org" } },
	youtube: { watches: ["yt"] },
};
const DRAFTS = { draftDefaults: { "mail-orders": "곡 이름을 먼저 적어요" }, draftRules: { "mail-general": [{ id: "r1", name: "공연", when: "공연 문의", how: "", files: [], on: true }] }, attachFolders: { "mail-orders": "/lib/brief" } };
function install(): string {
	const dir = mkdtempSync(join(root, "d-"));
	mkdirSync(join(dir, "custom", "reply-drafts", "tone"), { recursive: true });
	writeFileSync(join(dir, "custom", "apps.json"), JSON.stringify(APPS));
	writeFileSync(join(dir, "custom", "reply-drafts", "config.json"), JSON.stringify(DRAFTS));
	writeFileSync(join(dir, "custom", "reply-drafts", "tone", "mail-orders.md"), "# tone\n");
	return dir;
}
const appsOf = (dir: string) => JSON.parse(readFileSync(join(dir, "custom", "apps.json"), "utf8"));

describe("foldPlan", () => {
	test("takes only the instances of the same account and carries what each one had", () => {
		const p = foldPlan(APPS, DRAFTS, { into: "mail", base: "mail-general" }, id => id === "mail-orders");
		expect(p.removed).toEqual(["mail-orders", "mail-general"]);
		const box = p.boxes.find(b => b.id === "orders")!;
		expect({ name: box.name, src: box.conds.src, how: box.how, folders: box.folders, notify: box.notify, mode: box.mode }).toEqual({ name: "요청", src: ["orders"], how: "곡 이름을 먼저 적어요", folders: ["/lib/brief"], notify: false, mode: undefined });
		const base = p.boxes.find(b => b.base)!;
		expect({ id: base.id, src: base.conds.src, rules: base.rules.length }).toEqual({ id: "base", src: [], rules: 1 });
		expect(p.tones).toEqual([{ from: "custom/reply-drafts/tone/mail-orders.md", to: "custom/reply-drafts/tone/mail/orders.md" }]);
		expect(Object.keys(p.apps).sort()).toEqual(["mail", "mail-2", "youtube"]);
		expect(p.apps.mail!.watches).toEqual(["w-mail"]);
		expect(p.notes.length).toBe(1);
	});
	test("an instance with the target's settings inherits them, one without keeps exactly its own", () => {
		const shared = { draftDefaults: { mail: "d", "mail-orders": "d" }, draftRules: { mail: [], "mail-orders": [] }, attachFolders: { mail: "/f", "mail-orders": "/f" } };
		const p = foldPlan({ mail: APPS.mail, "mail-orders": APPS["mail-orders"], "mail-offer": { app: "mail", label: "제안", filter: { source: "offer", account: "me@example.org" } } }, shared, { into: "mail" }, () => false);
		const [brief, offer] = [p.boxes.find(b => b.id === "orders")!, p.boxes.find(b => b.id === "offer")!];
		expect({ alone: brief.alone, how: brief.how, folders: brief.folders }).toEqual({ alone: undefined, how: "", folders: [] });
		expect({ alone: offer.alone, how: offer.how, folders: offer.folders }).toEqual({ alone: true, how: "", folders: [] });
	});
	test("refuses a base that is not folded and a target that is no mail app", () => {
		expect(() => foldPlan(APPS, DRAFTS, { into: "mail", base: "mail-2" }, () => false)).toThrow();
		expect(() => foldPlan(APPS, DRAFTS, { into: "youtube" }, () => false)).toThrow();
		expect(() => foldPlan(APPS, DRAFTS, { into: "mail-2" }, () => false)).toThrow();
		expect(() => foldPlan(APPS, DRAFTS, { into: "mail", from: ["mail-2"] }, () => false)).toThrow();
		expect(() => foldPlan({ ...APPS, mail: { filter: { source: "own", account: "me@example.org" } } }, DRAFTS, { into: "mail" }, () => false)).toThrow();
	});
});

describe("run", () => {
	test("without --apply nothing changes", () => {
		const dir = install(), before = readFileSync(join(dir, "custom", "apps.json"), "utf8");
		expect(run(["fold", "--base", "mail-general"], dir, "1").code).toBe(0);
		expect(readFileSync(join(dir, "custom", "apps.json"), "utf8")).toBe(before);
		expect(existsSync(join(dir, "custom", "mailboxes.json"))).toBe(false);
	});
	test("--apply makes the boxes and undo restores every file", () => {
		const dir = install(), before = readFileSync(join(dir, "custom", "apps.json"), "utf8");
		const out = run(["fold", "--base", "mail-general", "--apply"], dir, "2");
		expect(out.code).toBe(0);
		expect(appsOf(dir)["mail-orders"]).toBeUndefined();
		expect(boxOfSource(boxesOf(dir, "mail"), "orders")?.id).toBe("orders");
		expect(instanceOf(dir, "orders-1")).toBe("mail");
		expect(boxOfSource(boxesOf(dir, "mail"), "general")).toBeUndefined();
		expect(existsSync(join(dir, "custom", "reply-drafts", "tone", "mail", "orders.md"))).toBe(true);
		expect(existsSync(join(dir, "custom", "reply-drafts", "tone", "mail-orders.md"))).toBe(true);
		expect(run(["undo", join(dir, "custom", "mailbox-fold-2")], dir, "3").code).toBe(0);
		expect(readFileSync(join(dir, "custom", "apps.json"), "utf8")).toBe(before);
		expect(existsSync(join(dir, "custom", "mailboxes.json"))).toBe(false);
		expect(existsSync(join(dir, "custom", "reply-drafts", "tone", "mail", "orders.md"))).toBe(false);
	});
});
