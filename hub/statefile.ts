// Reads a JSON state file so that "no such file" and "could not be read or parsed" are different answers. A file of the second kind is not
// taken for an empty one: it is moved aside to <file>.bad-<time> and logged, so the write that follows creates a fresh file and the damaged one
// is still there to recover from. Callers treat "bad" like "absent" afterwards.
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname } from "node:path";

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

/**
 * Whether `file` can be trusted to say what it lacks, without touching it: it is absent or parses, and no copy set aside as damaged
 * (`<file><asideMark><time>`, readState's `.bad-` by default) lies next to it. A set-aside copy may hold records the fresh file lost.
 */
export function stateIntact(file: string, asideMark = ".bad-"): boolean {
	const aside = `${basename(file)}${asideMark}`;
	try {
		if (readdirSync(dirname(file)).some(n => n.startsWith(aside))) return false;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT";
	}
	try {
		JSON.parse(readFileSync(file, "utf8"));
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT";
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
