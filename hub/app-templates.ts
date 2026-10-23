// The prompts the web's 앱 추가 > 새로 추가하기 puts in the chat box (web/js/32-app-settings.js). GET /api/app-templates serves them.
// Shipped: hub/app-templates.json {suffix, templates: [{key, label, text}]}. The owner overrides them in custom/app-templates.json, same shape:
// a template with a shipped key replaces it (a missing label stays), a new key is added after the shipped ones, `suffix` replaces the shared
// closing rule. The text is Korean and holds the owner's own values as {{항목 이름}}; the suffix tells the orchestrator to ask for those in the secure form.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type AppTemplate = { key: string; label: string; text: string };
type Raw = { suffix?: unknown; templates?: unknown };

export const TEMPLATES_FILE = "custom/app-templates.json";
const SHIPPED = join(import.meta.dir, "app-templates.json");

const read = (file: string): Raw | undefined => {
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(v) ? { templates: v } : v && typeof v === "object" ? v : undefined;
	} catch {
		return undefined;
	}
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function readAppTemplates(dataDir: string): AppTemplate[] {
	const base = read(SHIPPED) ?? {}, mine = read(join(dataDir, TEMPLATES_FILE)) ?? {};
	const suffix = typeof mine.suffix === "string" ? mine.suffix.trim() : typeof base.suffix === "string" ? base.suffix.trim() : "";
	const out = new Map<string, { label: string; text: string }>();
	for (const list of [base.templates, mine.templates]) {
		if (!Array.isArray(list)) continue;
		for (const t of list as Record<string, unknown>[]) {
			const key = str(t?.key), text = str(t?.text);
			if (!key || !/^[a-z0-9-]+$/.test(key) || !text) continue;
			out.set(key, { label: str(t.label) ?? out.get(key)?.label ?? key, text: text.trim() });
		}
	}
	return [...out].map(([key, t]) => ({ key, label: t.label, text: suffix ? `${t.text}\n\n${suffix}` : t.text }));
}
