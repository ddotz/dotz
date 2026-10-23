// Learning the user's tone: the user's own sent texts -> sentences of 3-120 characters, quoted history and signatures dropped,
// deduped, at most 40 -> the "## 예시" section of ONE tone profile (settings.ts: install, app or app+room). The sources are injected
// (a command runner for the sent-mail reader, a file, ready-made texts such as one messenger room's own lines), so tests never touch mail.
import { readFileSync } from "node:fs";
import { dataDir, writeExamples, type ToneKey } from "./settings.ts";
import { join } from "node:path";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (argv: string[]) => Promise<RunResult>;

export const MAX_EXAMPLES = 40;
export const SWEEP_LIMIT = 200; // sent texts the first sweep reads for the identity (persona.ts)
const MIN_LEN = 3;
const MAX_LEN = 120;

export const realRunner: Runner = async argv => {
	const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const t = setTimeout(() => p.kill("SIGKILL"), 90_000);
	const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const code = await p.exited;
	clearTimeout(t);
	return { code, stdout, stderr };
};

const HEADER = /^\s*(from|to|cc|bcc|subject|date|id|account|labels|thread|snippet)\s*:/i;
const HISTORY = [
	/^\s*on .{3,200}wrote:\s*$/i,
	/^\s*-{2,}\s*(original|forwarded)\b/i,
	/^\s*_{5,}\s*$/,
	/^\s*(보낸\s*사람|From)\s*:/i,
	/^\s*.{0,80}님이.{0,80}작성/,
	/^\s*-- ?$/,
	/^\s*sent from my\b/i,
];

// The user's own words of one mail: header lines at the top, quoted lines, and everything after a quoted-history or signature marker are dropped.
export function ownText(mail: string): string {
	const lines = mail.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length && (HEADER.test(lines[i]!) || !lines[i]!.trim())) i++;
	const out: string[] = [];
	for (const line of lines.slice(i)) {
		if (HISTORY.some(r => r.test(line))) break;
		if (/^\s*>/.test(line)) continue;
		out.push(line);
	}
	return out.join("\n");
}

// What the user's mail answered: the quoted lines and the history after the first marker (the reply's context for the identity sweep).
export function quotedText(mail: string): string {
	const lines = mail.replace(/\r\n?/g, "\n").split("\n");
	const at = lines.findIndex((l, i) => i > 0 && HISTORY.some(r => r.test(l)));
	const after = at < 0 ? [] : lines.slice(at + 1);
	return [...lines.filter(l => /^\s*>/.test(l)), ...after].map(l => l.replace(/^\s*>+\s?/, "")).join("\n").trim();
}

export function sentencesOf(text: string): string[] {
	return text
		.split("\n")
		.flatMap(l => l.split(/(?<=[.!?。…])\s+/))
		.map(s => s.replace(/\s+/g, " ").trim())
		.filter(s => s.length >= MIN_LEN && s.length <= MAX_LEN && !/https?:\/\/|\S+@\S+\.\S+/.test(s) && !/^[-=*_#~.\s]+$/.test(s));
}

export function pickExamples(texts: string[], max = MAX_EXAMPLES): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of texts) {
		for (const s of sentencesOf(ownText(t))) {
			const k = s.toLowerCase();
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(s);
			if (out.length >= max) return out;
		}
	}
	return out;
}

// The user's sent mail through the mail CLI (newest first as it lists them); a mail whose body cannot be read falls back to its snippet.
export async function sentMailTexts(run: Runner, limit = MAX_EXAMPLES): Promise<string[]> {
	const listed = await run(["zele", "mail", "list", "--folder", "sent", "--limit", String(limit)]);
	if (listed.code !== 0) throw new Error(`보낸 메일 목록을 못 읽었어요: ${(listed.stderr || listed.stdout).trim().slice(0, 160)}`);
	const items = ((Bun.YAML.parse(listed.stdout) as { items?: Record<string, unknown>[] } | null)?.items ?? []).slice(0, limit);
	const texts: string[] = [];
	for (const m of items) {
		const id = String(m.id ?? "");
		const body = id ? await run(["zele", "mail", "read", id]) : undefined;
		const text = body && body.code === 0 && body.stdout.trim() ? body.stdout : String(m.snippet ?? "");
		if (text.trim()) texts.push(text);
	}
	return texts;
}

// Only an install whose config.json turned zele on reads mail with it (MODE: zele.enabled true); an installed CLI alone is not enough.
export function zeleEnabled(config: Record<string, any> | undefined): boolean {
	return config?.zele?.enabled === true && !!Bun.which("zele");
}

// The install's sent mail for the identity sweep: read with zele only when this install's config.json turned zele on, else nothing.
export async function installSentMail(run: Runner): Promise<string[]> {
	let config: Record<string, any> | undefined;
	try {
		config = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"));
	} catch {}
	return zeleEnabled(config) ? sentMailTexts(run, SWEEP_LIMIT) : [];
}

export type LearnOpts = { fromFile?: string; run?: Runner; zeleOn?: boolean; texts?: string[]; textsLabel?: string };
export type LearnResult = { examples: string[]; from: string[]; texts: string[]; warning?: string };

// The sent-mail source (zele) belongs to the mail app only; any key can take a file or ready-made texts.
export async function learnTone(key: ToneKey | "install", opts: LearnOpts): Promise<LearnResult> {
	const texts: string[] = [];
	const from: string[] = [];
	if (opts.texts?.length) {
		texts.push(...opts.texts);
		from.push(opts.textsLabel ?? `보낸 글 ${opts.texts.length}개`);
	}
	if (opts.fromFile) {
		texts.push(readFileSync(opts.fromFile, "utf8"));
		from.push("파일");
	}
	let warning: string | undefined;
	if (opts.zeleOn && opts.run && key !== "install" && key.app === "mail" && key.room === undefined) {
		try {
			const mails = await sentMailTexts(opts.run, SWEEP_LIMIT);
			texts.push(...mails);
			if (mails.length) from.push(`보낸 메일 ${mails.length}통`);
		} catch (e) {
			warning = (e as Error).message;
		}
	}
	const examples = pickExamples(texts);
	if (examples.length) writeExamples(key, examples);
	return { examples, from, texts, ...(warning ? { warning } : {}) };
}

export const toneSummary = (r: LearnResult): string =>
	(r.examples.length
		? `말투를 배웠어요: ${r.from.join(", ")}에서 문장 ${r.examples.length}개를 예시로 저장했어요.`
		: "배울 수 있는 보낸 글이 없어서 정중한 기본 말투로 쓰고, 고치기로 알려 주시면 그대로 따라가요.") + (r.warning ? ` (${r.warning})` : "");
