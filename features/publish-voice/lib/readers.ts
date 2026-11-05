// Turning files into text. Every read of a file goes through guardPath first, so a path outside the stated scope fails before it is opened.
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { walkFolder } from "./folders.ts";
import type { Source } from "./profile.ts";
import { guardPath, type Scope, type Target } from "./targets.ts";

export type Runner = (argv: string[]) => Promise<{ code: number; out: string }>;
export type RawDoc = { key: string; source: Source; text: string; hint: string };
export type Collected = { docs: RawDoc[]; skipped: Record<string, number> };

const RUN_TIMEOUT_MS = 30_000;

export const realRunner: Runner = async argv => {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: RUN_TIMEOUT_MS });
	const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out };
};

export const markdownText = (md: string): string =>
	md
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.trim();

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

export function htmlText(html: string): string {
	const body = /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
	return body
		.replace(/<(script|style|nav|header|footer|aside|noscript|svg)[\s\S]*?<\/\1>/gi, "")
		.replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>|<br\s*\/?>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&[a-z#0-9]+;/gi, e => ENTITIES[e.toLowerCase()] ?? " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
		.trim();
}

// A document the machine cannot convert is skipped and counted, never guessed at.
async function convert(file: string, ext: string, run: Runner): Promise<string | undefined> {
	if (ext === ".docx") {
		const tool = Bun.which("textutil") ? ["textutil", "-convert", "txt", "-stdout", file] : Bun.which("pandoc") ? ["pandoc", "-t", "plain", file] : undefined;
		const r = tool ? await run(tool) : undefined;
		return r?.code === 0 ? r.out : undefined;
	}
	if (!Bun.which("kordoc")) return undefined;
	const r = await run(["kordoc", file]);
	return r.code === 0 ? r.out : undefined;
}

export async function readFolder(scope: Scope, target: Target, run: Runner): Promise<Collected> {
	const out: Collected = { docs: [], skipped: {} };
	const skip = (why: string) => (out.skipped[why] = (out.skipped[why] ?? 0) + 1);
	const walk = target.type === "folder" && target.path ? walkFolder(target.path, target.asked === true) : { files: target.path ? [target.path] : [], links: 0, sensitive: 0 };
	if (walk.links) out.skipped["바로가기(따라가지 않음)"] = walk.links;
	if (walk.sensitive) out.skipped["경로가 민감해 보여 빠짐(--asked 없음)"] = walk.sensitive;
	const files = walk.files;
	for (const file of files) {
		const real = guardPath(scope, file);
		const ext = extname(real).toLowerCase();
		const text = ext === ".md" ? markdownText(readFileSync(real, "utf8"))
			: ext === ".txt" ? readFileSync(real, "utf8")
			: ext === ".html" || ext === ".htm" ? htmlText(readFileSync(real, "utf8"))
			: await convert(real, ext, run);
		if (text === undefined) skip(`${ext.slice(1)} 변환 도구 없음`);
		else out.docs.push({ key: real, source: target.type === "file" ? "file" : "folder", text, hint: basename(real, ext) });
	}
	return out;
}
