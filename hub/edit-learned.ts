import { readFileSync } from "node:fs";
import { withLock } from "./file-lock.ts";

const MAX_MARKS = 2000;

function marksOf(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : [];
	} catch {
		return [];
	}
}

/** Claims the mark that the owner's edit of one sent draft was taken for learning, in a list of its own beside the drafts file (the drafts file is never written for it): true for the one caller, in any process, that adds `key` to the JSON list in `file` under that file's lock (`write` stores the new list); false when the key is already there. The list keeps its newest 2000 keys. */
export function claimLearned(file: string, key: string, write: (marks: string[]) => void): boolean {
	return withLock(file, "고침 학습 표시", () => {
		const marks = marksOf(file);
		if (marks.includes(key)) return false;
		write([...marks, key].slice(-MAX_MARKS));
		return true;
	});
}
