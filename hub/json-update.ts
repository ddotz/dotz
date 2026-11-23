import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** The file exists but cannot be updated: unreadable, not JSON, or JSON that is not an object. Its text is the owner-facing reason. */
export class UnreadableFileError extends Error {}

/**
 * The JSON object a file holds, for a read-modify-write. A file that is not there yet starts as `{}`; a file that cannot be read or is not a JSON
 * object is never taken for an empty one: this throws UnreadableFileError and the caller writes nothing, so the owner's file stays as it is.
 */
export function readObjectForUpdate<T extends object = Record<string, unknown>>(file: string): T {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {} as T;
		throw unreadable(file, (e as Error).message);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (e) {
		throw unreadable(file, (e as Error).message);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw unreadable(file, "JSON 객체가 아니에요");
	return value as T;
}

const unreadable = (file: string, reason: string) => new UnreadableFileError(`${basename(file)}을(를) 읽지 못해서 아무것도 바꾸지 않았어요 (${reason}). 파일을 고친 뒤 다시 해 주세요`);
