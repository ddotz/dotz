// The files a mail draft sends along, as hub/draft-files.ts staged them: <data dir>/draft-files/<draft id>/<n>/<name>, n = 0.. without gaps.
// Pure fs (no hub/config.ts import, the CLI send path reads it too); the data dir is read from DOTZ_DIR on every call like settings.ts.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { dataDir } from "./settings.ts";

export const STAGED_MAX = 10;
export const stagedRoot = () => join(dataDir(), "draft-files");
const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
export type StagedFile = { name: string; size: number; path: string };

// Same rule as hub/files.ts safeName (letters of any script, digits, . - _ and spaces; never a dotfile); kept here because that module reads the gateway config.
export function stagedName(name: string): string {
	const base = basename(String(name || "").replace(/\\/g, "/")).normalize("NFC");
	const clean = base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
	const ext = extname(clean).slice(0, 16);
	return `${clean.slice(0, clean.length - extname(clean).length).slice(0, 100) || "file"}${ext}`;
}

const dirOf = (ref: string, root: string) => {
	if (!REF.test(ref)) throw new Error(`draft ref ${ref} is not usable as a folder name`);
	return join(root, ref);
};

export function stagedFiles(ref: string, root: string = stagedRoot()): StagedFile[] {
	if (!REF.test(ref)) return [];
	const dir = dirOf(ref, root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(n => /^\d{1,2}$/.test(n))
		.sort((a, b) => Number(a) - Number(b))
		.flatMap(n => {
			const name = readdirSync(join(dir, n))[0];
			return name ? [{ name, size: statSync(join(dir, n, name)).size, path: join(dir, n, name) }] : [];
		});
}

function slot(ref: string, name: string, root: string): string {
	const files = stagedFiles(ref, root);
	if (files.length >= STAGED_MAX) throw new Error(`첨부파일은 ${STAGED_MAX}개까지 붙일 수 있어요`);
	const dir = join(dirOf(ref, root), String(files.length));
	mkdirSync(dir, { recursive: true });
	return join(dir, stagedName(name));
}

// Copies a file that already sits on this computer (an upload of /api/upload, a file of the library folder).
export function addStagedFile(ref: string, src: string, root: string = stagedRoot()): StagedFile {
	if (!statSync(src).isFile()) throw new Error(`${src} is not a file`);
	const to = slot(ref, basename(src), root);
	copyFileSync(src, to);
	return { name: basename(to), size: statSync(to).size, path: to };
}

// Bytes that came over the wire (a file added to a peer's draft).
export function addStagedBytes(ref: string, name: string, bytes: Uint8Array, root: string = stagedRoot()): StagedFile {
	const to = slot(ref, name, root);
	writeFileSync(to, bytes);
	return { name: basename(to), size: bytes.length, path: to };
}

// Removes file n and closes the gap, so the n-th `> 첨부:` line and GET /api/drafts/<ref>/files/<n> keep meaning the same file.
export function removeStagedFile(ref: string, index: number, root: string = stagedRoot()): boolean {
	const dir = dirOf(ref, root);
	const count = stagedFiles(ref, root).length;
	if (!Number.isInteger(index) || index < 0 || index >= count) return false;
	rmSync(join(dir, String(index)), { recursive: true, force: true });
	for (let n = index + 1; n < count; n++) renameSync(join(dir, String(n)), join(dir, String(n - 1)));
	return true;
}

// A revised draft is a new draft id: it carries the files of the one it replaces.
export function carryStagedFiles(from: string, to: string, root: string = stagedRoot()): void {
	for (const f of stagedFiles(from, root)) addStagedFile(to, f.path, root);
}
