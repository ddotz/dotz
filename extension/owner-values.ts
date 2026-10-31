// Owner-set compaction thresholds (`orchestrator.rotate_tokens`, `lanes.compact_at` in config.json) stay as the owner set
// them. No gateway code writes these keys; on 2026-10-28 the orchestrator itself wrote rotate_tokens 700000 into config.json
// after the owner only complained about a context limit, and its correction got lost in a compaction ("압축 복구 때
// 되돌아감"). So a change of one of these keys by any tool call is undone unless one of the latest user messages names
// the new number (300000, 300,000, 300k, 30만, 0.3M); the tool result then says so, and the agent asks the owner first.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./guard-config.ts";

export const OWNER_KEYS = [["orchestrator", "rotate_tokens"], ["lanes", "compact_at"]] as const;
const RECENT_USER_MESSAGES = 3;
type Values = Record<string, unknown>;

function readConfig(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
const valuesOf = (c: any): Values => Object.fromEntries(OWNER_KEYS.map(([s, k]) => [`${s}.${k}`, c?.[s]?.[k]]));

export function namesValue(text: string, v: unknown): boolean {
	if (typeof v !== "number" || !Number.isFinite(v)) return false;
	const t = text.toLowerCase().replace(/(\d)[,_](?=\d)/g, "$1");
	const forms = [`${v}(?!\\d)`];
	if (v % 1000 === 0) forms.push(`${v / 1000}\\s*k`);
	if (v % 10_000 === 0) forms.push(`${v / 10_000}\\s*만`);
	if (v % 100_000 === 0) forms.push(`${String(v / 1e6).replace(".", "\\.")}\\s*m(?![a-z])`);
	return forms.some(f => new RegExp(`(?<![\\d.])${f}`).test(t));
}

const textOf = (m: any): string =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n") : "";

export function installOwnerValues(pi: { on: (name: string, fn: (event: any, ctx: any) => any) => void }, file = join(dataDir(), "config.json")): void {
	let recent: string[] = [];
	const before = new Map<string, Values>();
	pi.on("context", (event: any) => {
		if (!Array.isArray(event?.messages)) return;
		recent = event.messages.filter((m: any) => m?.role === "user").slice(-RECENT_USER_MESSAGES).map(textOf);
	});
	pi.on("tool_call", (event: any) => {
		before.set(String(event?.toolCallId ?? ""), valuesOf(readConfig(file)));
	});
	pi.on("tool_result", (event: any) => {
		const id = String(event?.toolCallId ?? "");
		const was = before.get(id);
		before.delete(id);
		if (!was) return;
		const disk = readConfig(file);
		if (!disk) return;
		const now = valuesOf(disk);
		const undone: string[] = [];
		for (const [section, key] of OWNER_KEYS) {
			const name = `${section}.${key}`;
			if (now[name] === was[name] || recent.some(t => namesValue(t, now[name]))) continue;
			disk[section] = { ...disk[section] };
			if (was[name] === undefined) delete disk[section][key];
			else disk[section][key] = was[name];
			undone.push(`${name} ${JSON.stringify(now[name] ?? null)} -> ${JSON.stringify(was[name] ?? null)}`);
		}
		if (!undone.length) return;
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(disk, null, 2)}\n`);
		renameSync(tmp, file);
		const note = `[dotz] Undone in ${file}: ${undone.join(", ")}. Compaction thresholds are the owner's values; change one only when the owner's message names the new number. Ask the owner if you think it should change.`;
		return { content: [...(Array.isArray(event?.content) ? event.content : []), { type: "text", text: note }] };
	});
}
