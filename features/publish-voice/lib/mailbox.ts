// The owner's sent mail (through the `zele` CLI) and the messages the owner sent to dotz (inbox.jsonl). Both feed the short cells only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Collected, Runner } from "./readers.ts";
import type { Target } from "./targets.ts";

const SEPARATOR = /^\s*─{3,}\s*$/;
const QUOTE_START = [/^On .+wrote:\s*$/i, /^20\d\d[.\-/년 ].*작성:?\s*$/, /^-{2,}\s*(Original Message|원본 메시지)\s*-{2,}$/i, /^(From|보낸 사람):\s/i, /^-- ?$/];
const CONCURRENT = 4;

// `zele mail read` prints one block per message split by a line of `─`: From:, To:, Date:, a blank line, the body. Only the owner's own messages count.
export function ownText(readOutput: string, account: string): string {
	const blocks: string[][] = [[]];
	for (const line of readOutput.replace(/\r\n?/g, "\n").split("\n")) {
		if (SEPARATOR.test(line)) blocks.push([]);
		else blocks.at(-1)?.push(line);
	}
	const mine: string[] = [];
	for (const lines of blocks) {
		const at = lines.findIndex(l => /^From:\s/.test(l));
		if (at < 0 || !lines[at]?.toLowerCase().includes(account.toLowerCase())) continue;
		const blank = lines.findIndex((l, i) => i > at && !l.trim());
		const body: string[] = [];
		for (const l of blank < 0 ? [] : lines.slice(blank + 1)) {
			if (QUOTE_START.some(re => re.test(l))) break;
			if (!l.startsWith(">")) body.push(l);
		}
		mine.push(body.join("\n").trim());
	}
	return mine.filter(Boolean).join("\n\n");
}

export async function readSentMail(target: Target, run: Runner): Promise<Collected> {
	const out: Collected = { docs: [], skipped: {} };
	const account = target.account ?? "";
	const listed = await run(["zele", "mail", "list", "--folder", "sent", "--limit", String(target.limit ?? 200), "--account", account]);
	if (listed.code !== 0) throw new Error(`zele mail list 실패: ${listed.out.trim().slice(0, 200)}`);
	const parsed: unknown = Bun.YAML.parse(listed.out);
	const items = parsed && typeof parsed === "object" && "items" in parsed && Array.isArray(parsed.items) ? parsed.items : [];
	const ids = items.flatMap((i: unknown) => (i && typeof i === "object" && "id" in i && typeof i.id === "string" ? [i.id] : []));
	for (let at = 0; at < ids.length; at += CONCURRENT) {
		await Promise.all(ids.slice(at, at + CONCURRENT).map(async id => {
			const read = await run(["zele", "mail", "read", id, "--account", account]);
			const text = read.code === 0 ? ownText(read.out, account) : "";
			if (text) out.docs.push({ key: id, source: "mail", text, hint: "" });
			else out.skipped["읽지 못했거나 본문 없음"] = (out.skipped["읽지 못했거나 본문 없음"] ?? 0) + 1;
		}));
	}
	return out;
}

const countOf = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

export function readMessages(dataDir: string, target: Target): Collected {
	const out: Collected = { docs: [], skipped: {} };
	const file = join(dataDir, "inbox.jsonl");
	if (!existsSync(file)) return out;
	const mine: { ts: string; text: string }[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec: unknown = JSON.parse(line);
			if (rec && typeof rec === "object" && "kind" in rec && rec.kind === "message" && "text" in rec && typeof rec.text === "string" && !/^결정 답/.test(rec.text)) {
				mine.push({ ts: "ts" in rec && typeof rec.ts === "string" ? rec.ts : "", text: rec.text });
			}
		} catch (e) {
			if (!(e instanceof SyntaxError)) throw e;
			out.skipped["깨진 줄"] = (out.skipped["깨진 줄"] ?? 0) + 1;
		}
	}
	for (const [n, m] of mine.slice(-(target.limit ?? 500)).entries()) {
		if (countOf(m.text, /[A-Za-z]/g) > countOf(m.text, /[가-힣]/g)) out.skipped["영어·코드 위주"] = (out.skipped["영어·코드 위주"] ?? 0) + 1;
		else out.docs.push({ key: `${m.ts}#${n}`, source: "messages", text: m.text, hint: "" });
	}
	return out;
}
