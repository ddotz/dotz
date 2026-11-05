// The files a mail draft sends along, as hub/draft-files.ts staged them: <data dir>/draft-files/<draft id>/<n>/<name>, n = 0.. without gaps.
// Pure fs (no hub/config.ts import, the CLI send path reads it too); the data dir is read from DOTZ_DIR on every call like settings.ts.
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { dataDir } from "./settings.ts";
import { getDraft, listDrafts, patchDraft } from "./store.ts";

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

// The 첨부 파일 폴더 is often a symlink into iCloud Drive: brctl only works on the real path.
export const brctlArgv = (src: string): string[] => {
	let real = src;
	try {
		real = realpathSync(src);
	} catch {
		// not resolvable (gone, or no access): brctl gets the path as given
	}
	return ["/usr/bin/brctl", "download", real];
};

export const requestDownload: Download = src => {
	if (process.platform !== "darwin") return;
	try {
		Bun.spawn(brctlArgv(src), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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

export type StageOpts = {
	root?: string;
	copy?: CopyFile;
	download?: Download;
	tries?: number;
	waitMs?: number;
	/** false: no background retry of the files still not on a draft (wantFiles). */
	retry?: false;
	/** Called after a background retry put a file on a draft (the gateway re-reads the waiting card). */
	changed?: () => void;
};

// The files a draft gets on its own (a library match, a rule's files): an evicted iCloud file is downloaded and copied once it is back,
// waiting up to tries x waitMs (default 30 s) without blocking.
// The error it throws at the end carries the EDEADLK code, so a caller can tell a file that is merely not downloaded yet.
export async function stageLibraryFile(ref: string, src: string, opts: StageOpts = {}): Promise<StagedFile> {
	const { root = stagedRoot(), copy = copyFileSync, download = requestDownload, tries = 30, waitMs = 1000 } = opts;
	for (let n = 0; ; n++) {
		try {
			return copyInto(ref, src, root, copy);
		} catch (error) {
			if (!isEvicted(error)) throw error;
			if (n === 0) download(src);
			if (n >= tries) throw Object.assign(new Error(EVICTED(basename(src))), { code: "EDEADLK" });
			await Bun.sleep(waitMs);
		}
	}
}

export type Want = { name: string; path: string };
export const EVICTED_LATER = (name: string) => `${name}은(는) iCloud에만 있고 아직 내려받지 못해서 못 붙였어요. 내려받는 대로 붙일게요`;

// Stages each file on the draft `ref`. One that cannot be copied (an iCloud file still away, or any other failure) is not lost: it goes to `want`
// (the draft's wantFiles, which the send gate sees and retryWanted keeps trying) and its reason is returned for the card.
export async function stageFiles(ref: string, paths: string[], want: Want[], opts: StageOpts = {}): Promise<string[]> {
	const why: string[] = [];
	await Promise.all(paths.map(path => stageLibraryFile(ref, path, opts).catch(e => {
		if (!want.some(w => w.path === path)) want.push({ name: basename(path), path });
		why.push(isEvicted(e) ? EVICTED_LATER(basename(path)) : (e as Error).message);
	})));
	return why;
}

// The wait never keeps a short-lived process (the CLI) from exiting: the gateway picks such a draft up when it re-reads its cards (hub/draft-attach.ts).
const nap = (ms: number) => new Promise<void>(done => void setTimeout(done, ms).unref());
const RETRY_TRIES = 10, RETRY_WAIT_MS = 30_000;
const retrying = new Set<string>();
// Drafts whose bounded retry ran out in this process: re-reading the cards does not start another round.
const spent = new Set<string>();

// Tries again, in the background and bounded, for the files a pending draft still waits for (wantFiles): each that copies is staged and leaves
// the list, and `changed` is called so the waiting card updates. The offer queue never waits on this.
export function retryWanted(id: string, opts: StageOpts = {}): void {
	if (opts.retry === false || retrying.has(id)) return;
	retrying.add(id);
	void (async () => {
		for (let n = 0; n < RETRY_TRIES; n++) {
			await nap(RETRY_WAIT_MS);
			const rec = getDraft(id);
			if (!rec?.wantFiles?.length || rec.status !== "pending") return;
			let staged = false;
			const left: Want[] = [];
			for (const w of rec.wantFiles) {
				if (stagedFiles(id, opts.root).some(f => f.name === stagedName(w.name))) continue;
				try {
					await stageLibraryFile(id, w.path, { ...opts, tries: 0 });
					staged = true;
				} catch {
					left.push(w);
				}
			}
			patchDraft(id, { wantFiles: left.length ? left : undefined });
			if (staged) opts.changed?.();
			if (!left.length) return;
		}
		spent.add(id);
	})().catch(e => void console.error(`reply draft: files of draft ${id} not retried: ${(e as Error).message}`)).finally(() => void retrying.delete(id));
}

// Every pending draft that still waits for files gets the retry (one at a time per draft).
export function resumeWantedFiles(opts: StageOpts = {}): void {
	for (const d of listDrafts()) if (d.status === "pending" && d.wantFiles?.length && !spent.has(d.id)) retryWanted(d.id, opts);
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
