import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claimLearned } from "./edit-learned.ts";
import { claimEditLearned, type Draft } from "./kakao/send.ts";
import { kakaoPaths } from "./kakao/types.ts";

function inDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "dotz-edit-learned-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const writer = (file: string) => (marks: string[]) => writeFileSync(file, JSON.stringify(marks));

test("a key is claimed by its first caller only, and another key of the same list is still free", () => {
	inDir(dir => {
		const file = join(dir, "edit-learned.json");
		expect(claimLearned(file, "K1:2030-01-01", writer(file))).toBe(true);
		expect(claimLearned(file, "K1:2030-01-01", writer(file))).toBe(false);
		expect(claimLearned(file, "K1:2030-02-01", writer(file))).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["K1:2030-01-01", "K1:2030-02-01"]);
	});
});

test("an unreadable list counts as empty, and the list keeps only its newest 2000 keys", () => {
	inDir(dir => {
		const file = join(dir, "edit-learned.json");
		writeFileSync(file, "{not json");
		expect(claimLearned(file, "a", writer(file))).toBe(true);
		writeFileSync(file, JSON.stringify(Array.from({ length: 2000 }, (_, i) => `k${i}`)));
		expect(claimLearned(file, "new", writer(file))).toBe(true);
		const marks: string[] = JSON.parse(readFileSync(file, "utf8"));
		expect(marks).toHaveLength(2000);
		expect(marks[0]).toBe("k1");
		expect(marks.at(-1)).toBe("new");
	});
});

test("a KakaoTalk draft is claimed only once it is sent, once, and the drafts file is not rewritten for it", () => {
	inDir(dir => {
		const paths = kakaoPaths(dir);
		const d: Draft = { code: "KAAAA", chatId: "1", roomName: "방", text: "네 알겠어요", basisLogId: "10", created: "2030-01-01T00:00:00.000Z", status: "pending" };
		mkdirSync(dirname(paths.drafts), { recursive: true });
		writeFileSync(paths.drafts, JSON.stringify([d]));
		expect(claimEditLearned(paths, d.code)).toBe(false);
		writeFileSync(paths.drafts, JSON.stringify([{ ...d, status: "sent" }]));
		const before = readFileSync(paths.drafts, "utf8");
		expect(claimEditLearned(paths, d.code)).toBe(true);
		expect(claimEditLearned(paths, d.code)).toBe(false);
		expect(claimEditLearned(paths, "KNONE")).toBe(false);
		expect(readFileSync(paths.drafts, "utf8")).toBe(before);
	});
});
