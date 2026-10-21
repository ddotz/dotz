// KDB company mail takeover (hub/kdb.ts, hub/kdb-approve.ts): mail threads, the owner-OK gate on send/trash, FIDO approval.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConfirm, isFidoGo, kdbActBlock, kdbConfig, mailIdOf, mailThreadNote, OK_TTL_MS, recordOk, waitingApproval } from "./kdb.ts";
import { exec } from "./watch.ts";

const layer = (state: Record<string, unknown>) => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-kdb-"));
	writeFileSync(join(dir, "kdb-mail-threads.json"), JSON.stringify({ "1562029882710429772": 66815071 }));
	writeFileSync(join(dir, "kdb-mail-state.json"), JSON.stringify({ seen: [], ...state }));
	return kdbConfig({ dir, mail_channel: "1554106300198031464", alert_channel: "1553605146695700521" })!;
};

test("off without both channel ids; ~ expands", () => {
	expect(kdbConfig(undefined)).toBeUndefined();
	expect(kdbConfig({ mail_channel: "1" })).toBeUndefined();
	expect(kdbConfig({ mail_channel: "1", alert_channel: "2", enabled: false })).toBeUndefined();
	expect(kdbConfig({ mail_channel: "1", alert_channel: "2" }, "/home/x")?.dir).toBe("/home/x/.ddotz");
});

test("a mail thread maps to its mail id; other channels do not", () => {
	const c = layer({});
	expect(mailIdOf(c, "1562029882710429772")).toBe(66815071);
	expect(mailIdOf(c, "1554106300198031464")).toBeUndefined();
	expect(mailThreadNote(c, 66815071)).toContain("kdb-mail-act.ts reply 66815071");
});

test("only a whole-message yes is an OK", () => {
	for (const t of ["ㅇㅇ", "보내", "보내줘", "ok", "응!", "삭제해", "전달해줘"]) expect(isConfirm(t)).toBe(true);
	for (const t of ["답장해줘", "보내기 전에 제목 바꿔", "ㅇㅇ 근데 참조 빼고", "삭제할까?"]) expect(isConfirm(t)).toBe(false);
	expect(isFidoGo("재요청")).toBe(true);
	expect(isFidoGo("재요청해줘")).toBe(true);
	expect(isFidoGo("나중에")).toBe(false);
});

test("send and trash need a fresh owner OK for that mail, used once; dry runs and show pass", () => {
	const data = mkdtempSync(join(tmpdir(), "dotz-kdb-data-"));
	const send = "bun ~/.ddotz/kdb-mail-act.ts reply 66815071 --body-file /tmp/b.txt --send";
	expect(kdbActBlock("bun ~/.ddotz/kdb-mail-act.ts reply 66815071 --body-file /tmp/b.txt", data)).toBeUndefined();
	expect(kdbActBlock("bun ~/.ddotz/kdb-mail-act.ts show 66815071", data)).toBeUndefined();
	expect(kdbActBlock(send, data)).toContain("no explicit OK");
	expect(kdbActBlock("bun ~/.ddotz/kdb-mail-act.ts trash 66815071", data)).toContain("no explicit OK");
	expect(kdbActBlock("bun ~/.ddotz/kdb-mail-act.ts reply $ID --send", data)).toContain("literally");
	recordOk(data, 66815071, 1_000);
	expect(kdbActBlock(send, data, 1_000 + OK_TTL_MS + 1)).toContain("no explicit OK");
	recordOk(data, 66815071, 5_000);
	expect(kdbActBlock(send, data, 6_000)).toBeUndefined();
	expect(kdbActBlock(send, data, 6_000)).toContain("no explicit OK");
	recordOk(data, 1, 5_000);
	expect(kdbActBlock(send, data, 6_000)).toContain("mail 66815071");
});

const script = join(import.meta.dir, "kdb-approve.ts");
test("an approval reaches the watcher's file only while it waits, and is always reported used", async () => {
	const waiting = layer({ loggedOut: true, askedApproval: true });
	expect(waitingApproval(waiting)).toBe(true);
	const idle = await exec(["bun", script, waiting.dir], undefined, 30_000, { DOTZ_APPROVED: "0" });
	expect(idle.output).toBe("waiting for the owner's approval");
	expect(existsSync(join(waiting.dir, "kdb-login-approve"))).toBe(false);
	const go = await exec(["bun", script, waiting.dir], undefined, 30_000, { DOTZ_APPROVED: "1" });
	expect(go.code).toBe(0);
	expect(go.output).toMatch(/^DOTZ_APPROVAL_USED handed/);
	expect(existsSync(join(waiting.dir, "kdb-login-approve"))).toBe(true);

	const fine = layer({ loggedOut: false, askedApproval: false });
	expect(waitingApproval(fine)).toBe(false);
	const stale = await exec(["bun", script, fine.dir], undefined, 30_000, { DOTZ_APPROVED: "1" });
	expect(stale.output).toMatch(/^DOTZ_APPROVAL_USED dropped/);
	expect(existsSync(join(fine.dir, "kdb-login-approve"))).toBe(false);
});
