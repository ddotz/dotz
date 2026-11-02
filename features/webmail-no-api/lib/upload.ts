// A draft's files go to the site before send, per spec.send.upload. A draft records only paths and sizes; at send each
// file is streamed from disk (Bun.file slices) into a multipart body with an exact Content-Length, whole or in parts of
// `chunkBytes`, so a file of any size never sits in a command line or one in-memory base64 string. A file counts as
// accepted only when its last response carries an id and an ok status; bin/mail.ts sends nothing unless every file is.
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { endpointUrl, fillRaw, getPath, parseJson, type SiteSpec } from "./spec.ts";
import { headers } from "./session.ts";
import { type Ctx } from "./config.ts";

export type DraftFile = { path: string; name: string; size: number };
export type UploadedFile = { name: string; size: number; id: string; link?: boolean; url?: string };

const PART_TIMEOUT_MS = 10 * 60_000;
const str = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : String(v));

// A file named on `draft --file`: it must exist and hold bytes now; send checks the size again.
export function draftFile(path: string): DraftFile {
	const abs = resolve(path);
	if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`첨부 파일이 없어요: ${path}`);
	const size = statSync(abs).size;
	if (!size) throw new Error(`첨부 파일이 비어 있어요: ${path}`);
	return { path: abs, name: basename(abs), size };
}

// multipart/form-data as a stream: text fields, then the file part read lazily from `blob`, then the closing boundary.
export function multipartStream(fields: Record<string, string>, field: string, filename: string, type: string, blob: Blob): { body: ReadableStream<Uint8Array>; length: number; boundary: string } {
	const boundary = `----dotz${crypto.randomUUID().replace(/-/g, "")}`;
	const enc = new TextEncoder();
	const q = (s: string) => s.replace(/[\r\n]/g, " ").replace(/"/g, "%22");
	let headText = "";
	for (const [k, v] of Object.entries(fields)) headText += `--${boundary}\r\nContent-Disposition: form-data; name="${q(k)}"\r\n\r\n${v}\r\n`;
	headText += `--${boundary}\r\nContent-Disposition: form-data; name="${q(field)}"; filename="${q(filename)}"\r\nContent-Type: ${type}\r\n\r\n`;
	const head = enc.encode(headText);
	const tail = enc.encode(`\r\n--${boundary}--\r\n`);
	const reader = blob.stream().getReader();
	let stage = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(c) {
			if (stage === 0) {
				stage = 1;
				return c.enqueue(head);
			}
			if (stage === 1) {
				const { done, value } = await reader.read();
				if (!done) return c.enqueue(value);
				stage = 2;
			}
			c.enqueue(tail);
			c.close();
		},
		cancel: (why) => reader.cancel(why),
	});
	return { body, length: head.byteLength + blob.size + tail.byteLength, boundary };
}

// Upload one file and return what the site accepted. Throws an owner-facing Korean reason on any refusal.
export async function uploadFile(ctx: Ctx, spec: SiteSpec, cookie: string, f: DraftFile): Promise<UploadedFile> {
	const up = spec.send?.upload;
	if (!up) throw new Error("이 사이트 스펙에는 파일 올리기(send.upload)가 없어요");
	const file = Bun.file(f.path);
	if (!(await file.exists()) || file.size !== f.size) throw new Error(`${f.name}: 초안을 만든 뒤 파일이 없어지거나 크기가 바뀌었어요`);
	const big = !!up.large && f.size >= up.large.minBytes;
	const path = (big && up.large!.path) || up.path;
	const form = { ...(up.form ?? {}), ...(big ? (up.large!.form ?? {}) : {}) };
	const step = up.chunkBytes ?? f.size;
	const count = Math.max(1, Math.ceil(f.size / step));
	const type = file.type.split(";")[0] || "application/octet-stream";
	let uploadId = "";
	let last: unknown;
	for (let index = 0; index < count; index++) {
		const offset = index * step;
		const end = Math.min(f.size, offset + step);
		const tokens = { name: f.name, size: f.size, index, count, offset, chunk: end - offset, upload: uploadId };
		const fields = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, fillRaw(v, tokens)]));
		const { body, length, boundary } = multipartStream(fields, up.field ?? "file", f.name, type, file.slice(offset, end));
		const h = headers(spec, cookie, { Accept: "application/json", "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(length) });
		const r = await ctx.fetch(endpointUrl(spec.origin, { path }, tokens), { method: "POST", headers: h, body, redirect: "manual", signal: AbortSignal.timeout(PART_TIMEOUT_MS) });
		const where = count > 1 ? ` ${index + 1}/${count}번째 조각` : "";
		if (!r.ok) throw new Error(`${f.name}:${where} 사이트가 받지 않았어요 (HTTP ${r.status})`);
		try {
			last = parseJson(await r.text());
		} catch {
			throw new Error(`${f.name}:${where} 응답이 JSON이 아니에요 (로그인이 풀렸거나 주소가 달라요)`);
		}
		if (up.uploadIdPath) uploadId = str(getPath(last, up.uploadIdPath)) || uploadId;
	}
	const id = str(getPath(last, up.idPath));
	if (!id) throw new Error(`${f.name}: 응답에 파일 id(${up.idPath})가 없어요`);
	if (up.statusPath) {
		const status = str(getPath(last, up.statusPath));
		if (!status || (up.okStatus && !new RegExp(up.okStatus).test(status))) throw new Error(`${f.name}: 사이트가 파일을 받지 않았어요 (상태 ${status || "없음"})`);
	}
	const url = up.large?.linkPath ? str(getPath(last, up.large.linkPath)) : "";
	return { name: f.name, size: f.size, id, ...(big || url ? { link: true } : {}), ...(url ? { url } : {}) };
}
