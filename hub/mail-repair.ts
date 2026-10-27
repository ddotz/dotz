// `bun hub/mail-repair.ts [--file <mail-conversations.json>] [--apply]`: the incoming mails that read 답장 안 함 (reply skipped / fyi) with no
// sign that the owner set it (`reply_by: "owner"`, hub/mail.ts setMailReply). Older code wrote the mark without that evidence: until
// 2026-10-27 every owed mail row carried a small 답장 안 함 chip beside the 미답장 pill, and the older `noReply` flag became `skipped` in the
// migration, so such a mark may never have been his decision. For each one it prints what the gateway's own reading (hub/mail-state.ts
// replyExpected) says now.
// Dry run by default: nothing is written. --apply rewrites the file: 답장 필요 where replyExpected expects a reply, no reply state otherwise.
// Stop the gateway first (it keeps the mails in memory and writes the file back), and keep a copy.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { addressKey, replyExpected, type StoredMail } from "./mail-state.ts";

export type RepairRow = { key: string; at: string; subject: string; reply: string; expected: boolean };

/** The incoming mails whose 답장 안 함 has no owner evidence, oldest first, with what replyExpected says about each. */
export function unprovenMarks(records: readonly StoredMail[], own: ReadonlySet<string> = new Set()): RepairRow[] {
	return records
		.filter(r => r.dir !== "out" && (r.reply === "skipped" || r.reply === "fyi") && r.reply_by !== "owner")
		.map(r => ({ key: r.key, at: r.at, subject: r.subject, reply: r.reply!, expected: replyExpected({ from: r.from, to: r.to, cc: r.cc, subject: r.subject, text: r.summary || r.preview || "" }, own) }))
		.sort((a, b) => a.at.localeCompare(b.at));
}

/** Applies the listed rows to the records in place: 답장 필요 when a reply is expected, else no reply state. Returns how many changed. */
export function applyRepair(records: StoredMail[], rows: readonly RepairRow[]): number {
	const by = new Map(rows.map(r => [r.key, r]));
	let n = 0;
	for (const r of records) {
		const row = by.get(r.key);
		if (!row || r.reply !== row.reply || r.reply_by === "owner") continue;
		if (row.expected) r.reply = "needs";
		else delete r.reply;
		delete r.reply_at;
		n++;
	}
	return n;
}

export function repairReport(rows: readonly RepairRow[]): string[] {
	if (!rows.length) return ["주인 표시 기록이 없는 '답장 안 함' 메일이 없어요"];
	return [
		`주인 표시 기록 없이 '답장 안 함'인 메일 ${rows.length}개 (지금 판단: 답장 필요 ${rows.filter(r => r.expected).length}개)`,
		...rows.map(r => `${r.at}  ${r.key}  ${r.reply} -> ${r.expected ? "needs" : "(없음)"}  ${r.subject}`),
	];
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--file");
	const file = at >= 0 ? args[at + 1] : join(process.env.DOTZ_DIR ?? join(process.env.HOME ?? "", ".dotz"), "mail-conversations.json");
	if (!file || !existsSync(file)) {
		console.error(`메일 파일이 없어요: ${file ?? "(--file 뒤에 경로가 필요해요)"}`);
		process.exit(2);
	}
	// The owner's addresses as the gateway reads them (config.json mail.own_addresses / zele.aliases next to the mail file), for the CC rule.
	const conf = join(file, "..", "config.json");
	const c = existsSync(conf) ? (JSON.parse(readFileSync(conf, "utf8")) as { mail?: { own_addresses?: unknown }; zele?: { aliases?: unknown } }) : {};
	const own = new Set([c.mail?.own_addresses, c.zele?.aliases].flatMap(v => (Array.isArray(v) ? v : [])).filter((v): v is string => typeof v === "string").map(addressKey).filter(Boolean));
	const records = JSON.parse(readFileSync(file, "utf8")) as StoredMail[];
	const rows = unprovenMarks(records, own);
	for (const line of repairReport(rows)) console.log(line);
	if (!args.includes("--apply")) {
		if (rows.length) console.log("미리보기예요. 바꾸려면 게이트웨이를 멈추고 --apply를 붙여 다시 실행해 주세요");
	} else {
		const n = applyRepair(records, rows);
		await Bun.write(`${file}.tmp`, `${JSON.stringify(records, null, 2)}\n`);
		renameSync(`${file}.tmp`, file);
		console.log(`${n}개를 고쳤어요: ${file}`);
	}
}
