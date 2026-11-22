import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftAttachRoute } from "../../../hub/draft-attach.ts";
import { paths } from "../lib/settings.ts";
import { addStagedBytes, addStagedFile, fileDigest, stagedFiles, stagedName, stageLibraryFile } from "../lib/staged.ts";
import { addDraft, type DraftRec } from "../lib/store.ts";
import { enable, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
const MB = 1024 * 1024;
const src = join(env.dir, "src");
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), join(env.dir, "draft-files"), src]) rmSync(p, { force: true, recursive: true });
	mkdirSync(src, { recursive: true });
	enable(env, { attachFolders: { mail: src } });
});

const bytes = (mb: number) => new Uint8Array(mb * MB).fill(97);
const onDisk = (name: string, mb: number) => {
	const path = join(src, name);
	writeFileSync(path, bytes(mb));
	return path;
};
const names = (ref: string) => stagedFiles(ref).map(f => f.name);

describe("one limit: the attachments of a mail weigh 25MB together, whichever way a file comes in", () => {
	test("bytes that would push the total over 25MB are refused and the files already there stay", () => {
		addStagedBytes("RLIM01", "a.bin", bytes(20));
		expect(() => addStagedBytes("RLIM01", "b.bin", bytes(6))).toThrow("25MB");
		expect(names("RLIM01")).toEqual(["a.bin"]);
	});

	test("a file of the disk (the library, the CLI, reply_files) is refused the same way", async () => {
		addStagedBytes("RLIM02", "a.bin", bytes(20));
		expect(() => addStagedFile("RLIM02", onDisk("b.bin", 6))).toThrow("25MB");
		await expect(stageLibraryFile("RLIM02", onDisk("c.bin", 6))).rejects.toThrow("25MB");
		expect(names("RLIM02")).toEqual(["a.bin"]);
	});

	test("a single file over 25MB is refused, and exactly 25MB in total is taken", async () => {
		await expect(stageLibraryFile("RLIM03", onDisk("big.bin", 26))).rejects.toThrow("25MB");
		addStagedBytes("RLIM03", "a.bin", bytes(10));
		addStagedFile("RLIM03", onDisk("b.bin", 15));
		expect(names("RLIM03")).toEqual(["a.bin", "b.bin"]);
	});

	test("an empty file is refused as empty, not as too big", async () => {
		expect(() => addStagedBytes("RLIM04", "e.txt", new Uint8Array())).toThrow("빈 파일이에요");
		expect(() => addStagedFile("RLIM04", onDisk("e.txt", 0))).toThrow("빈 파일이에요");
		await expect(stageLibraryFile("RLIM04", onDisk("e2.txt", 0))).rejects.toThrow("빈 파일이에요");
		expect(names("RLIM04")).toEqual([]);
	});

	describe("the send sheet's route", () => {
		const rec = (id: string): DraftRec => ({ id, kind: "mail", app: "mail", source: "zele", mailId: `m-${id}`, ref: `ref-${id}`, to: "kim@example.com", subject: "Re: 문의", body: "확인했어요.", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "kim@example.com", text: "문의" } as never });
		const post = async (id: string, body: object) => {
			const url = new URL(`http://x/api/drafts/${id}/files`);
			const res = await draftAttachRoute(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, id, "files");
			const out: { error?: string } = await res.json();
			return { status: res.status, error: out.error };
		};

		test("{name, data} over the total names the limit; an empty one says it is empty", async () => {
			addDraft(rec("RLIMR1"));
			addStagedBytes("RLIMR1", "a.bin", bytes(20));
			const over = await post("RLIMR1", { name: "b.bin", data: Buffer.from(bytes(6)).toString("base64") });
			expect(over.status).toBeGreaterThanOrEqual(400);
			expect(over.error).toContain("25MB");
			const empty = await post("RLIMR1", { name: "e.txt", data: "" });
			expect(empty.status).toBeGreaterThanOrEqual(400);
			expect(empty.error).toBe("빈 파일이에요");
			expect(names("RLIMR1")).toEqual(["a.bin"]);
		});

		test("a file of the library folder over the total names the limit", async () => {
			addDraft(rec("RLIMR2"));
			addStagedBytes("RLIMR2", "a.bin", bytes(20));
			onDisk("lib.bin", 6);
			const over = await post("RLIMR2", { library: "lib.bin" });
			expect(over.status).toBeGreaterThanOrEqual(400);
			expect(over.error).toContain("25MB");
			expect(names("RLIMR2")).toEqual(["a.bin"]);
		});
	});
});

describe("a slot that vanished", () => {
	test("the next file takes the free number, so it is listed and sent", () => {
		for (const n of ["a.txt", "b.txt", "c.txt"]) addStagedBytes("RGAP01", n, new TextEncoder().encode(n));
		rmSync(join(env.dir, "draft-files", "RGAP01", "1"), { recursive: true });
		const added = addStagedBytes("RGAP01", "d.txt", new TextEncoder().encode("d"));
		expect(names("RGAP01").sort()).toEqual(["a.txt", "c.txt", "d.txt"]);
		expect(stagedFiles("RGAP01").map(f => f.path)).toContain(added.path);
	});

	test("an emptied slot folder is reused, and a lost last slot is taken again", () => {
		for (const n of ["a.txt", "b.txt"]) addStagedBytes("RGAP02", n, new TextEncoder().encode(n));
		rmSync(join(env.dir, "draft-files", "RGAP02", "1", "b.txt"));
		addStagedBytes("RGAP02", "c.txt", new TextEncoder().encode("c"));
		expect(names("RGAP02")).toEqual(["a.txt", "c.txt"]);
	});
});

describe("hashing a staged file", () => {
	test("the file is not read whole into memory, and the digest is the same for the same bytes", () => {
		const a = addStagedBytes("RHASH1", "a.bin", bytes(3));
		const b = addStagedBytes("RHASH2", "a.bin", bytes(3));
		const whole = spyOn(fs, "readFileSync");
		try {
			const digest = fileDigest(a.path);
			expect(whole.mock.calls.filter(c => c[0] === a.path)).toEqual([]);
			expect(fileDigest(b.path)).toBe(digest);
			expect(digest).toMatch(/^[0-9a-f]{16}$/);
		} finally {
			whole.mockRestore();
		}
	});

	test("other bytes of the same size are another version", () => {
		const a = addStagedBytes("RHASH3", "a.bin", new TextEncoder().encode("aaaa"));
		const b = addStagedBytes("RHASH4", "a.bin", new TextEncoder().encode("aaab"));
		expect(fileDigest(a.path)).not.toBe(fileDigest(b.path));
	});
});

describe("the name a recipient sees", () => {
	test("direction overrides, isolates and zero-width spaces are gone; joiners and ordinary names stay", () => {
		const cases: [string, string][] = [
			["invoice\u202Efdp.exe", "invoicefdp.exe"],
			["a\u2066b\u2069c.pdf", "abc.pdf"],
			["a\u200Bb\u200E\u200F\uFEFFc.pdf", "abc.pdf"],
			["\u202D\u202A.txt", "txt"],
			["가\u200D나\u200C다.pdf", "가\u200D나\u200C다.pdf"],
			["(마크추가) 견적서.pdf", "(마크추가) 견적서.pdf"],
		];
		for (const [given, sent] of cases) expect(stagedName(given)).toBe(sent);
	});

	test("a file staged under such a name is listed without them", () => {
		const f = addStagedBytes("RNAME1", "invoice\u202Efdp.exe", new TextEncoder().encode("x"));
		expect(f.name).toBe("invoicefdp.exe");
		expect(names("RNAME1")).toEqual(["invoicefdp.exe"]);
	});
});
