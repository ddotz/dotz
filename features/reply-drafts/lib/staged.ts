// The files a mail draft sends along, as hub/draft-files.ts staged them: <data dir>/draft-files/<draft id>/<n>/<name>, n = 0.. without gaps.
// Pure fs (no hub/config.ts import, the CLI send path reads it too); the data dir is read from DOTZ_DIR on every call like settings.ts.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { dataDir } from "./settings.ts";

export const STAGED_MAX = 10;
export const stagedRoot = () => join(dataDir(), "draft-files");
const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
export type StagedFile = { name: string; size: number; path: string };

// The name the receiver sees is the file's own name (parentheses, brackets and the like stay: "(마크추가)….pdf" is sent as it is); only what is unsafe in a path changes:
// a slash or backslash (the last path part is kept), control characters and NUL, and leading dots (never a dotfile).
export function stagedName(name: string): string {
	const base = basename(String(name || "").replace(/\\/g, "/")).normalize("NFC");
	const clean = base.replace(/[\u0000-\u001f\u007f]+/g, "_").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
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
	// A second file of the same name gets " (2)", " (3)"... so the receiver can tell them apart.
	const taken = new Set(files.map(f => f.name));
	const wanted = stagedName(name), ext = extname(wanted), stem = wanted.slice(0, wanted.length - ext.length);
	let unique = wanted;
	for (let n = 2; taken.has(unique); n++) unique = `${stem} (${n})${ext}`;
	return join(dir, unique);
}

// macOS iCloud Drive keeps a file it evicted as a placeholder of the same size: reading it fails with EDEADLK (cp gets 0 bytes) until
// `brctl download` brings the bytes back, which happens in the background. A 첨부 파일 폴더 often points into iCloud Drive.
export const isEvicted = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "EDEADLK";
export const EVICTED = (name: string) => `${name}은(는) iCloud에만 있고 이 컴퓨터에 내려받지 않은 파일이라 붙이지 못했어요. 내려받기를 시작했으니 잠시 뒤 다시 붙여 주세요`;
export type CopyFile = (src: string, to: string) => void;
export type Download = (src: string) => void;

export const requestDownload: Download = src => {
	if (process.platform !== "darwin") return;
	try {
		Bun.spawn(["brctl", "download", src], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch {
		// no brctl: the owner downloads the file in Finder
	}
};

// A copy that fails takes its slot away again, so no empty <n> folder is left between the files.
function copyInto(ref: string, src: string, root: string, copy: CopyFile): StagedFile {
	if (!statSync(src).isFile()) throw new Error(`${src} is not a file`);
	const to = slot(ref, basename(src), root);
	try {
		copy(src, to);
	} catch (error) {
		rmSync(dirname(to), { recursive: true, force: true });
		throw error;
	}
	return { name: basename(to), size: statSync(to).size, path: to };
}

// Copies a file that already sits on this computer (an upload of /api/upload, a file of the library folder). An evicted iCloud file
// starts its download and fails with a message that says so.
export function addStagedFile(ref: string, src: string, root: string = stagedRoot(), copy: CopyFile = copyFileSync, download: Download = requestDownload): StagedFile {
	try {
		return copyInto(ref, src, root, copy);
	} catch (error) {
		if (!isEvicted(error)) throw error;
		download(src);
		throw new Error(EVICTED(basename(src)));
	}
}

export type StageOpts = { root?: string; copy?: CopyFile; download?: Download; tries?: number; waitMs?: number };

// The files a draft gets on its own (a library match, a rule's files): an evicted iCloud file is downloaded and copied once it is back,
// waiting up to tries x waitMs (default 30 s) without blocking.
export async function stageLibraryFile(ref: string, src: string, opts: StageOpts = {}): Promise<StagedFile> {
	const { root = stagedRoot(), copy = copyFileSync, download = requestDownload, tries = 30, waitMs = 1000 } = opts;
	for (let n = 0; ; n++) {
		try {
			return copyInto(ref, src, root, copy);
		} catch (error) {
			if (!isEvicted(error)) throw error;
			if (n === 0) download(src);
			if (n >= tries) throw new Error(EVICTED(basename(src)));
			await Bun.sleep(waitMs);
		}
	}
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
