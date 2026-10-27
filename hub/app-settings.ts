// Per-app settings (모니터링 > 앱 > 설정). Each integration lists its settings as data: key, Korean label, type, help line and where the value
// is stored. The files are the install's own (<dataDir>/custom/<app>/..., the stores the apps already read); nothing is ever written to the repo.
//   GET   /api/integrations/<key>/settings        -> the fields with their current values
//   PATCH /api/integrations/<key>/settings        -> {values:{key:value}}: validated as a whole, then written; unknown key or wrong type = 400
// PATCH is the only write path: the web's switches call it directly (no model), and the 적용 button of a change card calls the same
// request, so a peer gateway can be handed the same plain HTTP call. Pure fs: no import of hub/config.ts, the data dir is a parameter.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appEntries, INTEGRATIONS, readAppsFile } from "./integrations.ts";
import { instanceOf } from "./reply-model.ts";

export type FieldType = "bool" | "enum" | "list" | "text" | "number";
// Where a row belongs on the settings screen, in the order the owner reads it: 알림, 자동 초안과 승인, 감시, 기타 기능, then the rest.
// The web groups rows by this key (web/js/32-app-settings.js AS_SECTIONS), so a row never sits under a heading its value does not belong to.
export type SettingSection = "notify" | "draft" | "watch" | "more" | "advanced";
export const SETTING_SECTIONS: readonly SettingSection[] = ["notify", "draft", "watch", "more", "advanced"];
export type SettingField = {
	key: string;
	label: string;
	type: FieldType;
	help: string;
	/** The section of the settings screen (default 고급). */
	section?: SettingSection;
	/** File under the data dir, and the dotted path of the value inside it. */
	store: string;
	path: string;
	options?: string[];
	/** Words the owner reads for each option (enum). */
	labels?: Record<string, string>;
	/** Whole-number range (number); the longest text (text, default 500). */
	min?: number;
	max?: number;
	def?: boolean | string | string[];
	/** A common setting the web draws as a control above the conversation: a switch (bool), a menu (enum) or a box (number, text). */
	switch?: boolean;
	/** Dotted paths in the same file that are set true together with this switch turned on. */
	alsoOn?: string[];
	/** The stored boolean is the opposite of the value shown (the file says `off`, the switch says 쓰기). */
	invert?: boolean;
	/** Learned in conversation, not set in the settings screen (owner 2026-10-26): the bot saves it with a dotz-settings block of memory keys
	 *  only, which the gateway stores at once (applyMemory), and every turn of that app is told the current value. */
	memory?: true;
};
export type SettingValue = boolean | string | string[] | number;

const DRAFTS = "custom/reply-drafts/config.json";
const SNS = "custom/sns/config.json";
const draftSwitch = (app: string, label: string): SettingField => ({ key: "auto_draft", label: "자동 초안", type: "bool", help: `${label}에 답할 거리가 있으면 초안을 만들어요`, store: DRAFTS, path: `apps.${app}.auto`, def: false, switch: true, section: "draft", alsoOn: ["enabled"] });
const approval: SettingField = { key: "approval", label: "승인 방식", type: "enum", help: "올리기 전에 하나씩 확인할지, 모아서 한 번에 확인할지 정해요. 인스타그램과 유튜브에 함께 적용돼요", store: SNS, path: "approval", options: ["each", "batch"], labels: { each: "하나씩 승인", batch: "모아서 승인" }, def: "each", section: "draft" };

// Every app has this switch, under 고급: custom/apps.json {"<app>":{"off":true}} (hub/app-off.ts). Off wins over every rule that turned the app on here.
const deviceSwitch = (app: string): SettingField => ({ key: "use_here", label: "이 기기에서 쓰기", type: "bool", help: "끄면 이 컴퓨터의 앱 목록에서 빠지고 감시와 알림이 멈춰요. 데이터는 그대로 남아요", store: "custom/apps.json", path: `${app}.off`, def: true, switch: true, section: "advanced", invert: true });

// The instance's name (hub/integrations.ts appEntries): shown in the list, the title and the notices; empty = the app's own name.
const nameField = (app: string): SettingField => ({ key: "label", label: "앱 이름", type: "text", help: "목록과 제목에 보이는 이름이에요. 비우면 기본 이름으로 돌아가요", store: "custom/apps.json", path: `${app}.label`, max: 30, def: INTEGRATIONS.find(e => e.key === app.split("-")[0])?.label ?? "", switch: true, section: "advanced" });

// 답장 모델: the model of the reply drafts of one app or instance (hub/reply-model.ts reads it, then the global 답장 기본값, then Sonnet 5.5 medium).
// The options are the runtime's model list, installed by hub/reply-model-choices.ts before a read or write; "" (기본값) is always valid.
export type ReplyModelChoices = { options: string[]; labels: Record<string, string> };
let replyChoices: ReplyModelChoices = { options: [""], labels: { "": "기본값" } };
export const setReplyModelChoices = (c: ReplyModelChoices): void => {
	replyChoices = c;
};
// 디스코드에도 올리기: custom/apps.json {"<mail instance>":{"discord":true}} (off when missing). Drawn only while Discord is connected; main.ts installs the probe.
let discordConnected = (): boolean => false;
export const setDiscordProbe = (probe: () => boolean): void => {
	discordConnected = probe;
};
/** Whether the mail app instance that owns mail `<key>` (matched by its source like the other instance filters) has 디스코드에도 올리기 on. */
export const mailDiscordOn = (dataDir: string, key: string): boolean => readAppsFile(dataDir)[instanceOf(appEntries(dataDir), "mail", `mail:${key}`)]?.discord === true;
const discordField = (app: string): SettingField => ({ key: "discord", label: "디스코드에도 올리기", type: "bool", help: "새 메일마다 디스코드 메일 채널에 스레드를 만들어요", store: "custom/apps.json", path: `${app}.discord`, def: false, switch: true, section: "notify" });
// 첨부 파일 폴더: where a mail instance looks for the file a reply promises or a mail asks for (features/reply-drafts/lib/library.ts); empty = none.
const attachFolderField = (app: string): SettingField => ({ key: "attach_folder", label: "첨부 파일 폴더", type: "text", help: "오너가 대화에서 알려 준, 자주 보내는 파일을 모아 둔 이 컴퓨터의 폴더예요. 답장에 파일이 필요하면 여기서 맞는 파일을 찾아 붙여 둬요", store: DRAFTS, path: `attachFolders.${app}`, max: 300, section: "advanced", memory: true });
// 이어서 할 일: free text; after an approved action of this app instance the bot checks it once (hub/followup.ts).
const followupField = (app: string): SettingField => ({ key: "followup", label: "이어서 할 일", type: "text", section: "advanced", help: "오너가 대화에서 알려 준, 답글·답장·카톡을 보낸 뒤 이어서 할 일이에요. 예: 파일을 달라는 댓글이면 답글 뒤에 적어 준 주소로 그 파일을 붙인 메일 초안을 만들어요. 조건에 맞을 때만 하고, 메일은 보내기를 누를 때만 나가요", store: DRAFTS, path: `followups.${app}`, max: 500 , memory: true });
const REPLY_APPS = new Set(["mail", "kakao", "instagram", "youtube", "site"]);
const replyModelField = (app: string): SettingField => ({ key: "reply_model", label: "답장 모델", type: "enum", help: "", store: DRAFTS, path: `models.${app}`, options: replyChoices.options, labels: replyChoices.labels, def: "", section: "advanced" });

export const APP_SETTINGS: Record<string, SettingField[]> = {
	site: [],
	mail: [
		draftSwitch("mail", "메일"),
		{ key: "skip_senders", label: "초안에서 뺄 발신자", type: "list", help: "이 발신자(주소나 이름)의 메일에는 초안을 만들지 않아요", store: DRAFTS, path: "senders.skip", def: [], section: "draft" },
		{ key: "only_senders", label: "초안을 만들 발신자", type: "list", help: "여기 적은 발신자에게만 초안을 만들어요. 비우면 모두에게 만들어요", store: DRAFTS, path: "senders.only", def: [], section: "draft" },
	],
	kakao: [
		{ key: "enabled", label: "카카오톡 감시", type: "bool", help: "끄면 어떤 방도 지켜보지 않아요", store: "custom/kakao/config.json", path: "enabled", def: false, switch: true, section: "watch" },
		{ key: "watch_chats", label: "감시할 방", type: "list", help: "새 메시지를 지켜볼 채팅방이에요. 대화방 목록에서 골라요", store: "custom/kakao/config.json", path: "watch_chats", def: [], section: "watch" },
		{ key: "auto_draft_chats", label: "초안을 만들 방", type: "list", help: "감시할 방 가운데 새 메시지에 초안을 만들 방이에요", store: "custom/kakao/config.json", path: "auto_draft_chats", def: [], section: "draft" },
		{ key: "exclude_chats", label: "초안에서 뺄 방", type: "list", help: "초안을 만들지 않을 방이에요", store: "custom/kakao/config.json", path: "exclude_chats", def: [], section: "draft" },
		{ key: "open_chats", label: "오픈채팅방 보기", type: "bool", help: "켜면 오픈채팅방도 대화방 목록에 뜨고 일반 방처럼 지켜보고 답장할 수 있어요", store: "custom/kakao/config.json", path: "open_chats", def: true, section: "watch" },
	],
	instagram: [draftSwitch("instagram", "인스타그램"), approval],
	youtube: [draftSwitch("youtube", "유튜브"), approval],
};

export class SettingsError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

// An app key or an instance id (`mail-2`): the schema is the app's, the switch and the name are the instance's.
export const fieldsOf = (app: string): SettingField[] => {
	const base = app.split("-")[0]!;
	return Object.hasOwn(APP_SETTINGS, base) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(app) ? [deviceSwitch(app), nameField(app), ...APP_SETTINGS[base]!, ...(base === "mail" && discordConnected() ? [discordField(app)] : []), ...(REPLY_APPS.has(base) ? [replyModelField(app), followupField(app)] : []), ...(base === "mail" ? [attachFolderField(app)] : [])] : [];
};

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
	if (f.type === "number") {
		if (typeof v !== "number" || !Number.isInteger(v) || v < (f.min ?? 0) || v > (f.max ?? Number.MAX_SAFE_INTEGER)) throw new SettingsError(`${f.key}: ${f.min ?? 0}에서 ${f.max} 사이 정수여야 해요`);
		return v;
	}
	if (f.type === "text") {
		if (typeof v !== "string" || v.length > (f.max ?? 500)) throw new SettingsError(`${f.key}: ${f.max ?? 500}자 이하 글이어야 해요`);
		return v.trim();
	}
	if (!Array.isArray(v) || v.length > 200 || v.some(x => typeof x !== "string" || !x.trim() || x.length > 200)) throw new SettingsError(`${f.key}: 글 목록(200개 이하)이어야 해요`);
	return [...new Set((v as string[]).map(x => x.trim()))];
}

/** Validates a whole change set against a schema without writing; the clean values keyed by field key. Unknown key, wrong type or an empty set throws. */
export function validateFields(fields: SettingField[], values: unknown): Record<string, SettingValue> {
	if (!values || typeof values !== "object" || Array.isArray(values) || !Object.keys(values).length) throw new SettingsError("values: 바꿀 항목이 있어야 해요");
	const out: Record<string, SettingValue> = {};
	for (const [k, v] of Object.entries(values)) {
		const f = fields.find(x => x.key === k);
		if (!f) throw new SettingsError(`${k}: 알 수 없는 설정이에요`);
		out[k] = clean(f, v);
	}
	return out;
}
export function validate(app: string, values: unknown): Record<string, SettingValue> {
	const fields = fieldsOf(app);
	if (!fields.length) throw new SettingsError(`${app}: 바꿀 수 있는 설정이 없어요`, 404);
	return validateFields(fields, values);
}

export type SettingView = Pick<SettingField, "key" | "label" | "type" | "help" | "section" | "options" | "labels" | "min" | "max" | "switch" | "memory"> & { value: SettingValue };
/** A field with its current value, as GET returns it. */
export const viewOf = (f: SettingField, value: SettingValue): SettingView => ({ key: f.key, label: f.label, type: f.type, help: f.help, ...(f.section ? { section: f.section } : {}), ...(f.options ? { options: f.options } : {}), ...(f.labels ? { labels: f.labels } : {}), ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}), ...(f.switch ? { switch: true } : {}), ...(f.memory ? { memory: true as const } : {}), value });
export function readSettings(dataDir: string, app: string): SettingView[] {
	const cache = new Map<string, Record<string, any>>();
	return fieldsOf(app).map(f => {
		if (!cache.has(f.store)) cache.set(f.store, readJson(join(dataDir, f.store)));
		const raw = getPath(cache.get(f.store)!, f.path);
		let value: SettingValue;
		try {
			value = raw === undefined ? (f.def ?? (f.type === "list" ? [] : f.type === "bool" ? false : "")) : f.invert ? !clean(f, raw) : clean(f, raw);
		} catch {
			value = f.def ?? "";
		}
		return viewOf(f, value);
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
		setPath(doc, f.path, f.invert ? !v : v);
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
// A settings conversation as a name: `settings:<app>` or `settings:w:<watch>` (the form only; whether the app or watch exists is another question).
export const isSettingsTarget = (t: string): boolean => /^settings:(?:w:)?[a-z0-9][a-z0-9._-]*$/.test(t);

const FENCE = "```";
const BLOCK = new RegExp(`${FENCE}dotz-settings[ \\t]*\\n([\\s\\S]*?)${FENCE}`);
export type Proposal = { app: string; changes: Record<string, SettingValue> };
/** The change proposal in an answer, or null. Parsing never writes: a proposal is applied only by the PATCH the 적용 button sends. */
export function parseProposal(text: string, app: string, fields: SettingField[] = fieldsOf(app)): Proposal | null {
	const m = BLOCK.exec(text);
	if (!m) return null;
	try {
		const b = JSON.parse(m[1]!);
		if (b?.app !== app) return null;
		return { app, changes: validateFields(fields, b.changes) };
	} catch {
		return null;
	}
}

const LIST_SHOWN = 20;
const show = (v: SettingValue): string => (Array.isArray(v) ? JSON.stringify(v.slice(0, LIST_SHOWN)) + (v.length > LIST_SHOWN ? ` 외 ${v.length - LIST_SHOWN}개` : "") : JSON.stringify(v));
export type Turn = { from: "owner" | "bot"; text: string };

/** What the orchestrator gets with a settings turn: this app's fields and current values, the proposal format and the last few turns. Nothing else. */
export const settingsContext = (dataDir: string, app: string, label: string, recent: readonly Turn[] = []): string => settingsContextOf(app, label, readSettings(dataDir, app), recent);
export function settingsContextOf(app: string, label: string, views: readonly SettingView[], recent: readonly Turn[] = []): string {
	const rows = views.map(f => `${f.key} | ${f.type}${f.options ? `(${f.options.join("/")})` : ""} | ${f.label} | ${show(f.value)} | ${f.help}`);
	const turns = recent.slice(-4).map(t => `${t.from === "owner" ? "오너" : "봇"}: ${t.text.replace(BLOCK, "(변경 제안)").replace(/\s+/g, " ").trim().slice(0, 300)}`);
	return [
		`[settings:${app}] ${label} 설정 대화입니다. 아래 항목만 바꾸고, 파일을 직접 고치지 않습니다.`,
		`변경은 한 줄 설명과 아래 블록 하나로 제안합니다. 목록은 전체 새 값이고, 오너가 카드에서 적용을 눌러야 저장됩니다.`,
		`${FENCE}dotz-settings`,
		`{"app":"${app}","changes":{"<key>":<value>}}`,
		FENCE,
		"key | 종류 | 이름 | 현재값 | 설명",
		...rows,
		...(views.some(f => f.memory) ? [memoryRule(views.filter(f => f.memory).map(f => f.key))] : []),
		...(turns.length ? ["최근 대화:", ...turns] : []),
	].join("\n");
}

// The keys marked memory are not asked about in the settings screen: the bot keeps what the owner says in any conversation of the app.
const memoryRule = (keys: string[]): string => `기억 항목(${keys.join(", ")})은 설정 화면에 없어요. 오너가 대화에서 알려 주면(파일 폴더, 보낸 뒤에 할 일) 그 키만 담은 같은 블록을 붙이세요. 카드 없이 바로 저장되니 한 줄로 '기억해 뒀어요'라고만 알리세요.`;

/** The memory keys of an answer's dotz-settings block, stored at once (no 적용 card). A block with any other key stays a proposal. Returns what was stored. */
export function applyMemory(dataDir: string, text: string): { app: string; keys: string[] } | undefined {
	const m = BLOCK.exec(text);
	if (!m) return undefined;
	let b: { app?: unknown; changes?: unknown };
	try {
		b = JSON.parse(m[1]!);
	} catch {
		return undefined;
	}
	const app = typeof b.app === "string" ? b.app : "";
	const fields = fieldsOf(app);
	const keys = b.changes && typeof b.changes === "object" && !Array.isArray(b.changes) ? Object.keys(b.changes) : [];
	if (!keys.length || !keys.every(k => fields.find(f => f.key === k)?.memory)) return undefined;
	writeSettings(dataDir, app, b.changes);
	return { app, keys };
}

/** One line for a turn of an app's own conversation (a mail of that app): what it remembers and how to keep something new. "" when the app has no memory keys. */
export function memoryNote(dataDir: string, app: string): string {
	const mem = readSettings(dataDir, app).filter(f => f.memory);
	if (!mem.length) return "";
	const now = mem.map(f => `${f.label}=${f.value === "" ? "없음" : JSON.stringify(f.value)}`).join(", ");
	return `(이 앱(${app})이 기억해 둔 것: ${now}. 오너가 새로 알려 주면 ${FENCE}dotz-settings {"app":"${app}","changes":{"<${mem.map(f => f.key).join("|")}>":"..."}} ${FENCE} 블록으로 기억하세요. 바로 저장돼요.)`;
}

/** Rough token count (Hangul ~1 token per 1.2 chars, the rest ~1 per 3.5): enough to check the 2K budget, not a billing figure. */
export const approxTokens = (s: string): number => Math.ceil((s.match(/[\u3131-\u318e\uac00-\ud7a3]/g)?.length ?? 0) / 1.2 + (s.replace(/[\u3131-\u318e\uac00-\ud7a3]/g, "").length) / 3.5);
