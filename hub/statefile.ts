// Reads a JSON state file so that "no such file" and "could not be read or parsed" are different answers. A file of the second kind is not
// taken for an empty one: it is moved aside to <file>.bad-<time> and logged, so the write that follows creates a fresh file and the damaged one
// is still there to recover from. Callers treat "bad" like "absent" afterwards.
import { readFileSync, renameSync } from "node:fs";

export type StateRead = { state: "absent" } | { state: "ok"; value: unknown } | { state: "bad" };

export function readState(file: string, note: (line: string) => void): StateRead {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : setAside(file, e, note);
	}
	try {
		return { state: "ok", value: JSON.parse(text) };
	} catch (e) {
		return setAside(file, e, note);
	}
}

function setAside(file: string, why: unknown, note: (line: string) => void): StateRead {
	const aside = `${file}.bad-${Date.now()}`;
	const reason = (why as Error).message ?? String(why);
	try {
		renameSync(file, aside);
		note(`state file ${file} could not be read (${reason}); kept as ${aside}`);
	} catch (e) {
		note(`state file ${file} could not be read (${reason}) and could not be set aside (${(e as Error).message})`);
	}
	return { state: "bad" };
}
