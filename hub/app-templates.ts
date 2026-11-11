// The app connection requests, kept like skills: docs/app-templates/<key>.md (frontmatter label, order; the Korean request) and _rule.md
// (the shared closing rule). The bot reads the matching file when the owner names an app; the web shows no list of them and asks for one only
// when 다시 켜기 refills an app that needs reconnecting (GET /api/app-templates, web/js/32-app-settings.js). The owner overrides them in
// custom/app-templates.json {suffix?, templates: [{key, label?, text}]}:
// a template with a shipped key replaces it (a missing label stays), a new key is added after the shipped ones, `suffix` replaces the shared
// closing rule. The text is Korean and holds the owner's own values as {{항목 이름}}; the suffix tells the orchestrator to ask for those in the secure form.
// A shipped file with `listed: false` is a prepared request kept off the list (and off its last-item fallback): only asking by its key
// returns it (GET /api/app-templates?key=coupang); an owner template with that key stays off the list too.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AppTemplate = { key: string; label: string; text: string };
type Raw = { suffix?: unknown; templates?: unknown };

export const TEMPLATES_FILE = "custom/app-templates.json";
export const SHIPPED_DIR = join(import.meta.dir, "..", "docs", "app-templates");

const text = (file: string): string | undefined => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};
// One request file: "---\nlabel: 메일\norder: 1\n---\n<text>".
function shipped(dir: string): Raw {
	const list: { key: string; label?: string; text: string; order: number; hidden: boolean }[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter(n => /^[a-z0-9-]+\.md$/.test(n));
	} catch {
		return {};
	}
	for (const n of names) {
		const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text(join(dir, n)) ?? "");
		if (!m) continue;
		const meta = Object.fromEntries(m[1]!.split("\n").map(l => /^(\w+):\s*(.*)$/.exec(l)).filter(x => !!x).map(x => [x![1]!, x![2]!.trim()]));
		list.push({ key: n.slice(0, -3), label: meta.label, text: m[2]!, order: Number(meta.order) || 999, hidden: meta.listed === "false" });
	}
	list.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
	return { suffix: text(join(dir, "_rule.md")) ?? "", templates: list };
}

const read = (file: string): Raw | undefined => {
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(v) ? { templates: v } : v && typeof v === "object" ? v : undefined;
	} catch {
		return undefined;
	}
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

// The listed requests, or with `key` that one request whether listed or not ([] when none).
export function readAppTemplates(dataDir: string, shippedDir = SHIPPED_DIR, key?: string): AppTemplate[] {
	const base = shipped(shippedDir), mine = read(join(dataDir, TEMPLATES_FILE)) ?? {};
	const suffix = typeof mine.suffix === "string" ? mine.suffix.trim() : typeof base.suffix === "string" ? base.suffix.trim() : "";
	const out = new Map<string, { label: string; text: string; hidden: boolean }>();
	for (const list of [base.templates, mine.templates]) {
		if (!Array.isArray(list)) continue;
		for (const t of list as Record<string, unknown>[]) {
			const k = str(t?.key), text = str(t?.text);
			if (!k || !/^[a-z0-9-]+$/.test(k) || !text) continue;
			const was = out.get(k);
			out.set(k, { label: str(t.label) ?? was?.label ?? k, text: text.trim(), hidden: was?.hidden ?? t.hidden === true });
		}
	}
	return [...out].filter(([k, t]) => (key === undefined ? !t.hidden : k === key))
		.map(([k, t]) => ({ key: k, label: t.label, text: suffix ? `${t.text}\n\n${suffix}` : t.text }));
}
