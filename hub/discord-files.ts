// Result files on Discord (outgoing `[file]` lines): which files ride along as attachments and the notes for the rest. Moved out of
// discord.ts unchanged; discord.ts re-exports the public functions. No Discord I/O here.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { cfg } from "./config.ts";
import type { Body } from "./discord-format.ts";

export type Attach = { path: string; name: string; size: number };
export const attach = { maxBytes: Math.max(1, Number((cfg as any).discord?.attach_max_mb ?? 10)) * 1024 * 1024 };
const MAX_FILES = 10;
let resolveFile: (path: string) => string = () => {
	throw new Error("file sending is not set up");
};
let fileLink: (path: string) => string | undefined = () => undefined;
export function setFileResolver(fn: (path: string) => string): void {
	resolveFile = fn;
}
export function setFileLink(fn: (path: string) => string | undefined): void {
	fileLink = fn;
}

const FILE_LINE = /^\s*\[file\]\s+`?(.+?)`?\s*$/;
export function fileLines(text: string): { text: string; files: string[] } {
	const files: string[] = [];
	const kept: string[] = [];
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = fence ? null : FILE_LINE.exec(line);
		if (m) files.push(m[1]!);
		else kept.push(line);
	}
	return { text: kept.join("\n"), files };
}

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
export const linkLine = (f: Attach) => {
	const url = fileLink(f.path);
	return url ? `-# ${f.name} (${mb(f.size)}, 첨부 한도 초과) 다운로드: ${url}` : `-# ${f.name} (${mb(f.size)}): 첨부 한도를 넘었어요, 파일은 \`${f.path}\``;
};

// Which files ride along as attachments (together within the upload limit, at most 10) and the note lines for the rest.
export function planFiles(paths: string[]): { files: Attach[]; notes: string[] } {
	const files: Attach[] = [];
	const notes: string[] = [];
	let total = 0;
	for (const input of paths) {
		let f: Attach;
		try {
			const path = resolveFile(input);
			f = { path, name: basename(path), size: statSync(path).size };
		} catch (error) {
			notes.push(`-# ${basename(input)}: ${(error as Error).message}`);
			continue;
		}
		if (files.length < MAX_FILES && total + f.size <= attach.maxBytes) {
			files.push(f);
			total += f.size;
		} else notes.push(linkLine(f));
	}
	return { files, notes };
}

export const withNotes = (body: Body, notes: string[]): Body => (notes.length ? { ...body, content: [body.content, ...notes].filter(Boolean).join("\n").slice(0, 2000) } : body);
