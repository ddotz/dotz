// Per-app settings (모니터링 > 앱 > 설정). Each integration lists its settings as data: key, Korean label, type, help line and where the value
// is stored. The files are the install's own (<dataDir>/custom/<app>/..., the stores the apps already read); nothing is ever written to the repo.
//   GET   /api/integrations/<key>/settings        -> the fields with their current values
//   PATCH /api/integrations/<key>/settings        -> {values:{key:value}}: validated as a whole, then written; unknown key or wrong type = 400
// PATCH is the only write path: the web's switches call it directly (no model), and the 적용 button of a change card calls the same
// request, so a peer gateway can be handed the same plain HTTP call. Pure fs: no import of hub/config.ts, the data dir is a parameter.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FieldType = "bool" | "enum" | "list" | "text";
export type SettingField = {
	key: string;
	label: string;
	type: FieldType;
	help: string;
	/** File under the data dir, and the dotted path of the value inside it. */
	store: string;
	path: string;
	options?: string[];
	def?: boolean | string | string[];
	/** A common setting the web draws as a switch above the conversation (bool only). */
	switch?: boolean;
	/** Dotted paths in the same file that are set true together with this switch turned on. */
	alsoOn?: string[];
};
export type SettingValue = boolean | string | string[];

const DRAFTS = "custom/reply-drafts/config.json";
const SNS = "custom/sns/config.json";
const draftSwitch = (app: string, label: string): SettingField => ({ key: "auto_draft", label: "자동 초안", type: "bool", help: `${label}에 답할 거리가 오면 초안을 알아서 만들어요`, store: DRAFTS, path: `apps.${app}.auto`, def: false, switch: true, alsoOn: ["enabled"] });
const approval: SettingField = { key: "approval", label: "게시 승인 방식", type: "enum", help: "each = 하나씩 확인, batch = 모아서 한 번에 확인", store: SNS, path: "approval", options: ["each", "batch"], def: "each" };

export const APP_SETTINGS: Record<string, SettingField[]> = {
	mail: [
		draftSwitch("mail", "메일"),
		{ key: "skip_senders", label: "초안 제외 발신자", type: "list", help: "이 발신자(주소나 이름)의 메일에는 초안을 만들지 않아요", store: DRAFTS, path: "senders.skip", def: [] },
		{ key: "only_senders", label: "이 발신자만 초안", type: "list", help: "비우면 모든 발신자에 초안을 만들어요", store: DRAFTS, path: "senders.only", def: [] },
	],
	kakao: [
		{ key: "enabled", label: "카카오톡 감시", type: "bool", help: "끄면 어떤 방도 지켜보지 않아요", store: "custom/kakao/config.json", path: "enabled", def: false, switch: true },
		{ key: "watch_chats", label: "감시하는 방", type: "list", help: "채팅방 id 목록이에요 (방 이름은 대화방 목록에서 찾아요)", store: "custom/kakao/config.json", path: "watch_chats", def: [] },
		{ key: "auto_draft_chats", label: "자동 초안 방", type: "list", help: "감시하는 방 가운데 새 메시지에 봇이 깨어나 초안을 만드는 방의 id예요", store: "custom/kakao/config.json", path: "auto_draft_chats", def: [] },
		{ key: "exclude_chats", label: "초안 제외 방", type: "list", help: "초안을 만들지 않는 방의 id예요", store: "custom/kakao/config.json", path: "exclude_chats", def: [] },
	],
	instagram: [draftSwitch("instagram", "인스타그램"), approval],
	youtube: [draftSwitch("youtube", "유튜브"), approval],
};

export class SettingsError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

export const fieldsOf = (app: string): SettingField[] => (Object.hasOwn(APP_SETTINGS, app) ? APP_SETTINGS[app]! : []);

const readJson = (file: string): Record<string, any> => {
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
};
const getPath = (obj: Record<string, any>, path: string): unknown => path.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
function setPath(obj: Record<string, any>, path: string, value: unknown): void {
	const keys = path.split(".");
	let o = obj;
	for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? o[k] : (o[k] = {});
	o[keys[keys.length - 1]!] = value;
}

function clean(f: SettingField, v: unknown): SettingValue {
	if (f.type === "bool") {
		if (typeof v !== "boolean") throw new SettingsError(`${f.key}: true 또는 false여야 해요`);
		return v;
	}
	if (f.type === "enum") {
		if (typeof v !== "string" || !f.options?.includes(v)) throw new SettingsError(`${f.key}: ${f.options?.join(", ")} 중 하나여야 해요`);
		return v;
	}
	if (f.type === "text") {
		if (typeof v !== "string" || v.length > 500) throw new SettingsError(`${f.key}: 500자 이하 글이어야 해요`);
		return v.trim();
	}
	if (!Array.isArray(v) || v.length > 200 || v.some(x => typeof x !== "string" || !x.trim() || x.length > 200)) throw new SettingsError(`${f.key}: 글 목록(200개 이하)이어야 해요`);
	return [...new Set((v as string[]).map(x => x.trim()))];
}

/** Validates a whole change set without writing; the clean values keyed by field key. Unknown key, wrong type or an empty set throws. */
export function validate(app: string, values: unknown): Record<string, SettingValue> {
	const fields = fieldsOf(app);
	if (!fields.length) throw new SettingsError(`${app}: 바꿀 수 있는 설정이 없어요`, 404);
	if (!values || typeof values !== "object" || Array.isArray(values) || !Object.keys(values).length) throw new SettingsError("values: 바꿀 항목이 있어야 해요");
	const out: Record<string, SettingValue> = {};
	for (const [k, v] of Object.entries(values)) {
		const f = fields.find(x => x.key === k);
		if (!f) throw new SettingsError(`${k}: 알 수 없는 설정이에요`);
		out[k] = clean(f, v);
	}
	return out;
}

export type SettingView = Pick<SettingField, "key" | "label" | "type" | "help" | "options" | "switch"> & { value: SettingValue };
export function readSettings(dataDir: string, app: string): SettingView[] {
	const cache = new Map<string, Record<string, any>>();
	return fieldsOf(app).map(f => {
		if (!cache.has(f.store)) cache.set(f.store, readJson(join(dataDir, f.store)));
		const raw = getPath(cache.get(f.store)!, f.path);
		let value: SettingValue;
		try {
			value = raw === undefined ? (f.def ?? (f.type === "list" ? [] : f.type === "bool" ? false : "")) : clean(f, raw);
		} catch {
			value = f.def ?? "";
		}
		return { key: f.key, label: f.label, type: f.type, help: f.help, ...(f.options ? { options: f.options } : {}), ...(f.switch ? { switch: true } : {}), value };
	});
}

/** The single write path. All values are validated first; one file is written once, atomically (tmp + rename). */
export function writeSettings(dataDir: string, app: string, values: unknown): SettingView[] {
	const clean = validate(app, values);
	const byStore = new Map<string, Record<string, any>>();
	for (const [k, v] of Object.entries(clean)) {
		const f = fieldsOf(app).find(x => x.key === k)!;
		if (!byStore.has(f.store)) byStore.set(f.store, readJson(join(dataDir, f.store)));
		const doc = byStore.get(f.store)!;
		setPath(doc, f.path, v);
		if (v === true) for (const p of f.alsoOn ?? []) setPath(doc, p, true);
	}
	for (const [store, doc] of byStore) {
		const file = join(dataDir, store);
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
		renameSync(tmp, file);
	}
	return readSettings(dataDir, app);
}

// ---- the settings conversation: `settings:<app>` ----

export const settingsTarget = (app: string): string => `settings:${app}`;
export const appOfSettingsTarget = (target: string): string | undefined => (target.startsWith("settings:") && fieldsOf(target.slice(9)).length ? target.slice(9) : undefined);

const FENCE = "```";
const BLOCK = new RegExp(`${FENCE}dotz-settings[ \\t]*\\n([\\s\\S]*?)${FENCE}`);
export type Proposal = { app: string; changes: Record<string, SettingValue> };
/** The change proposal in an answer, or null. Parsing never writes: a proposal is applied only by the PATCH the 적용 button sends. */
export function parseProposal(text: string, app: string): Proposal | null {
	const m = BLOCK.exec(text);
	if (!m) return null;
	try {
		const b = JSON.parse(m[1]!);
		if (b?.app !== app) return null;
		return { app, changes: validate(app, b.changes) };
	} catch {
		return null;
	}
}

const LIST_SHOWN = 20;
const show = (v: SettingValue): string => (Array.isArray(v) ? JSON.stringify(v.slice(0, LIST_SHOWN)) + (v.length > LIST_SHOWN ? ` 외 ${v.length - LIST_SHOWN}개` : "") : JSON.stringify(v));
export type Turn = { from: "owner" | "bot"; text: string };

/** What the orchestrator gets with a settings turn: this app's fields and current values, the proposal format and the last few turns. Nothing else. */
export function settingsContext(dataDir: string, app: string, label: string, recent: readonly Turn[] = []): string {
	const rows = readSettings(dataDir, app).map(f => `${f.key} | ${f.type}${f.options ? `(${f.options.join("/")})` : ""} | ${f.label} | ${show(f.value)} | ${f.help}`);
	const turns = recent.slice(-4).map(t => `${t.from === "owner" ? "오너" : "봇"}: ${t.text.replace(BLOCK, "(변경 제안)").replace(/\s+/g, " ").trim().slice(0, 300)}`);
	return [
		`[settings:${app}] ${label} 설정 대화입니다. 아래 항목만 바꾸고, 파일을 직접 고치지 않습니다.`,
		`변경은 한 줄 설명과 아래 블록 하나로 제안합니다. 목록은 전체 새 값이고, 오너가 카드에서 적용을 눌러야 저장됩니다.`,
		`${FENCE}dotz-settings`,
		`{"app":"${app}","changes":{"<key>":<value>}}`,
		FENCE,
		"key | 종류 | 이름 | 현재값 | 설명",
		...rows,
		...(turns.length ? ["최근 대화:", ...turns] : []),
	].join("\n");
}

/** Rough token count (Hangul ~1 token per 1.2 chars, the rest ~1 per 3.5): enough to check the 2K budget, not a billing figure. */
export const approxTokens = (s: string): number => Math.ceil((s.match(/[\u3131-\u318e\uac00-\ud7a3]/g)?.length ?? 0) / 1.2 + (s.replace(/[\u3131-\u318e\uac00-\ud7a3]/g, "").length) / 3.5);
