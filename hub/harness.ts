// "구성" view backend (read-only): the harness as a graph (inbound channels -> gateway -> orchestrator -> lanes -> workers,
// plus the support systems), built at runtime from the live process state and ~/.dotz, with the whitelist of config.json
// keys and the prompt files the owner can ask the orchestrator to change. This module writes nothing: edits are requests
// the web UI sends to the main orchestrator. Secrets, Discord ids, ports and the allowed-login list are shown as
// "설정됨"/counts only.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runningSubagents } from "./activity.ts";
import { cfg, CONFIG_FILE, DATA_DIR, IDENTITY_FILE, NAME, orchestratorModel, lanesModel, parseSelector, paths, THINKING_LEVELS, uiOriginView, workerModel } from "./config.ts";
import { kTokens, percentOf } from "./context.ts";
import * as discord from "./discord.ts";
import { modeFile, lang } from "./i18n.ts";
import { lanes, WORKER_SLOTS } from "./lanes.ts";
import { orch } from "./orchestrator.ts";
import { availableModels, ControlError, type ModelInfo, quota } from "./providers.ts";
import { listSchedules } from "./schedule.ts";
import { listSetups } from "./workchannels.ts";
import { allWatches } from "./watch.ts";

export type Applies = "live" | "restart" | "next-turn";
type SettingType = "text" | "number" | "bool" | "select" | "model" | "effort";
export type Setting = {
	key: string;
	label: string;
	value: string | number | boolean;
	type: SettingType;
	options?: { value: string; label: string }[];
	editable: boolean;
	applies: Applies;
	source: string;
	default?: string | number | boolean;
	hint?: string;
	unit?: string;
	min?: number;
	max?: number;
	multiline?: boolean;
	pending?: boolean;
};
export type HarnessNode = {
	id: string;
	kind: "channel" | "gateway" | "orchestrator" | "lanes" | "workers" | "file" | "system";
	group: "flow" | "files" | "support";
	anchor?: string;
	order?: number;
	label: string;
	summary: string;
	desc: string;
	status?: "ok" | "busy" | "warn" | "err" | "off";
	facts: { label: string; value: string }[];
	settings: Setting[];
	file?: string;
	fileEditable?: boolean;
	// only with `ui.origin_view`: which side the node belongs to, the settings whose value differs from their default, and a personal file's size/mtime
	origin?: "shipped" | "personal";
	custom?: { key: string; label: string; value: string | number | boolean; default: string | number | boolean; unit?: string }[];
	fileMeta?: { bytes: number; modified?: string };
};
export type HarnessEdge = { from: string; to: string; label: string };

// ---- editable config keys ----------------------------------------------------------------------------------------
// Defaults mirror the module that owns each key (the comment names it); the owner's values live in config.json only.
type Def = {
	label: string;
	type: SettingType;
	applies: Applies;
	default?: string | number | boolean;
	options?: { value: string; label: string }[];
	unit?: string;
	hint?: string;
	min?: number;
	max?: number;
	multiline?: boolean;
	mirror?: boolean; // the owner module reads cfg per use (a changed value needs no restart); false = read once at start
	source?: string;
};

const EFFORT_OPTIONS = THINKING_LEVELS.map(v => ({ value: v, label: v }));

const DEFS = new Map<string, Def>([
	["orchestrator.model", { label: "모델", type: "model", applies: "live", mirror: true }],
	["orchestrator.thinking", { label: "추론 강도", type: "effort", applies: "live", mirror: true }],
	// orchestrator.ts ROTATE_TOKENS
	["orchestrator.rotate_tokens", { label: "새 세션으로 넘어가는 기준", type: "number", applies: "restart", default: 150_000, unit: "토큰", min: 20_000, max: 1_000_000, hint: "대화가 이만큼 길어지면 한가한 때 핸드오버와 함께 새 세션으로 넘어가요" }],
	["lanes.model", { label: "새 레인 기본 모델", type: "model", applies: "next-turn", mirror: true }],
	["lanes.thinking", { label: "새 레인 추론 강도", type: "effort", applies: "next-turn", mirror: true }],
	// lanes.ts MAX_ACTIVE
	["lanes.max_active", { label: "동시에 일하는 레인 수", type: "number", applies: "restart", default: 4, unit: "개", min: 1, max: 16 }],
	// config.ts lanesCompactAt / lanesKeepRecent (read when a lane process starts)
	["lanes.compact_at", { label: "자동 압축 시작", type: "number", applies: "next-turn", mirror: true, default: 400_000, unit: "토큰", min: 50_000, max: 2_000_000, hint: "레인 컨텍스트가 이만큼 차면 요약해서 줄여요" }],
	["lanes.keep_recent", { label: "압축해도 남기는 최근 대화", type: "number", applies: "next-turn", mirror: true, default: 40_000, unit: "토큰", min: 5_000, max: 400_000 }],
	["lanes.worker_model", { label: "작업자 모델", type: "model", applies: "next-turn", mirror: true }],
	["lanes.worker_effort", { label: "작업자 추론 강도", type: "effort", applies: "next-turn", mirror: true, source: "config.json:lanes.worker_model" }],
	// config.ts lanesNightlyAt (hygiene.ts arms its timer at start)
	["lanes.nightly_at", { label: "야간 정리 시각", type: "text", applies: "restart", default: "04:30", hint: "HH:MM 또는 off" }],
	["lanes.nightly_compact_at", { label: "야간 압축 기준", type: "number", applies: "live", mirror: true, default: 300_000, unit: "토큰", min: 50_000, max: 2_000_000 }],
	["lanes.rotate_mb", { label: "세션 파일 교체 크기", type: "number", applies: "live", mirror: true, default: 50, unit: "MB", min: 5, max: 1000 }],
	// memguard.ts reads the limit on every check, but only starts its timer when it is above 0 at start
	["lanes.max_rss_gb", { label: "프로세스 메모리 한도", type: "number", applies: "restart", default: 8, unit: "GB", min: 1, max: 128, hint: "넘으면 같은 세션으로 다시 시작해요. 끄려면 config.json 에서 0 으로" }],
	// main.ts COALESCE_MS
	["gateway.coalesce_ms", { label: "연달아 온 메시지 묶는 시간", type: "number", applies: "restart", default: 4000, unit: "ms", min: 0, max: 20_000, hint: "같은 채널에서 이 시간 안에 온 메시지는 한 번에 처리해요" }],
	// reflect.ts / token-audit.ts / update.ts
	["reflect_at", { label: "야간 회고 시각", type: "text", applies: "restart", default: "04:40", hint: "HH:MM 또는 off" }],
	["token_audit_at", { label: "토큰 감사 시각", type: "text", applies: "restart", default: "04:30", hint: "HH:MM 또는 off" }],
	["omp_update.mode", { label: "업데이트 방식", type: "select", applies: "restart", default: "check", options: [{ value: "check", label: "새 버전만 알림" }, { value: "install", label: "자동 설치 후 재시작" }, { value: "off", label: "끄기" }] }],
	["omp_update.at", { label: "업데이트 확인 시각", type: "text", applies: "restart", default: "04:20", hint: "HH:MM 또는 off" }],
	// reflect.ts reads backup.remote on every snapshot
	["backup.remote", { label: "백업 저장소 주소", type: "text", applies: "live", mirror: true, default: "", hint: "비우면 이 컴퓨터에만 스냅샷을 남겨요. 비밀이 든 파일은 올리지 않아요" }],
	// outlang.ts
	["output_language.mode", { label: "출력 언어 점검", type: "select", applies: "live", mirror: true, default: "rewrite", options: [{ value: "rewrite", label: "다른 언어면 다시 쓰기" }, { value: "off", label: "끄기" }] }],
	["output_language.model", { label: "다시 쓰기에 쓸 모델", type: "text", applies: "live", mirror: true, default: "", hint: "비우면 omp 의 기본 작은 모델" }],
	["output_language.timeout_s", { label: "다시 쓰기 제한 시간", type: "number", applies: "live", mirror: true, default: 30, unit: "초", min: 5, max: 300 }],
	// zele.ts
	["zele.enabled", { label: "메일·캘린더 확인", type: "bool", applies: "restart", default: true }],
	["zele.poll_sec", { label: "확인 간격", type: "number", applies: "restart", default: 120, unit: "초", min: 60, max: 3600 }],
	["zele.brief_hour", { label: "아침 브리핑 시각", type: "number", applies: "restart", default: 8, unit: "시", min: 0, max: 23 }],
	["identity.name", { label: "이름", type: "text", applies: "restart" }],
	["identity.language", { label: "응답 언어", type: "text", applies: "live", mirror: true, default: "", hint: "ko, en, ja … 비우면 정체성 글에서 자동 감지" }],
	["identity.character", { label: "성격", type: "text", applies: "next-turn", mirror: true, multiline: true, hint: "정체성 파일(IDENTITY.md)이 있으면 그쪽이 우선이에요" }],
	["identity.tone", { label: "말투", type: "text", applies: "next-turn", mirror: true, multiline: true, hint: "출력 언어 다시 쓰기의 말투 기준이기도 해요" }],
]);

// ---- config.json access ------------------------------------------------------------------------------------------
// The keys this view reads from disk; everything else in config.json passes through untouched.
type Disk = {
	identity?: { name?: string };
	discord?: { token_file?: string; owner_id?: string; guild?: string };
	web?: { port?: number; tailscale_https_port?: number; allow_logins?: string[] };
	lanes?: { max_active?: number; compact_at?: number; nightly_at?: string; max_rss_gb?: number };
	gateway?: { coalesce_ms?: number };
	zele?: { enabled?: boolean; poll_sec?: number; brief_hour?: number };
	omp_update?: { mode?: string; at?: string };
	output_language?: string | { mode?: string };
	backup?: { remote?: string };
	reflect_at?: string;
	token_audit_at?: string;
};
type Tree = Record<string, unknown>;
const readDisk = (): Disk => JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Disk;
const STARTED: Tree = JSON.parse(JSON.stringify(cfg)) as Tree; // what this process was started with
const getPath = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Tree)[k] : undefined), o);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// output_language may be a bare string ("off"); address it as { mode } for reading.
const outLang = (o: Tree): Tree => (typeof o.output_language === "string" ? { ...o, output_language: { mode: o.output_language } } : o);
const modeOf = (d: Disk) => (typeof d.output_language === "string" ? d.output_language : d.output_language?.mode);

function effective(path: string, disk: Disk): unknown {
	switch (path) {
		case "orchestrator.model": return orchestratorModel().model;
		case "orchestrator.thinking": return orchestratorModel().thinking;
		case "lanes.model": return lanesModel().model;
		case "lanes.thinking": return lanesModel().thinking;
		case "lanes.worker_model": return parseSelector(workerModel()).model;
		case "lanes.worker_effort": return parseSelector(workerModel()).thinking;
		case "identity.name": return disk.identity?.name ?? NAME;
	}
	return getPath(outLang(disk as Tree), path) ?? DEFS.get(path)?.default;
}

function settingOf(path: string, disk: Disk, over: Partial<Setting> = {}): Setting {
	const d = DEFS.get(path)!;
	const value = effective(path, disk);
	const startedValue = getPath(outLang(STARTED), path);
	const stored = getPath(outLang(disk as Tree), path);
	return {
		key: path,
		label: d.label,
		value: (value ?? "") as string | number | boolean,
		type: d.type,
		...(d.type === "effort" ? { options: EFFORT_OPTIONS } : d.options ? { options: d.options } : {}),
		editable: true,
		applies: d.applies,
		source: d.source ?? `config.json:${path}`,
		...(d.default !== undefined ? { default: d.default } : {}),
		...(d.hint ? { hint: d.hint } : {}),
		...(d.unit ? { unit: d.unit } : {}),
		...(d.min !== undefined ? { min: d.min } : {}),
		...(d.max !== undefined ? { max: d.max } : {}),
		...(d.multiline ? { multiline: true } : {}),
		...(d.applies === "restart" && !d.mirror && !same(stored, startedValue) ? { pending: true } : {}),
		...over,
	};
}

// ---- prompt files ------------------------------------------------------------------------------------------------
type FileDef = { path: () => string; editable: boolean; label: string; cap?: number; applies: Applies; note: string };
const FILES: Record<string, FileDef> = {
	"MODE.md": { path: modeFile, editable: false, label: "행동 규칙(MODE)", applies: "next-turn", note: "저장소와 함께 배포되는 파일이라 여기서는 읽기만 돼요." },
	"RULES.md": { path: () => paths.rules, editable: true, label: "내 규칙", cap: 12_000, applies: "next-turn", note: "차단 명령은 바로, 나머지는 다음 세션·압축 뒤 다시 읽을 때 반영돼요." },
	"LESSONS.md": { path: () => paths.lessons, editable: true, label: "교훈", cap: 3_000, applies: "next-turn", note: "다음 세션·압축 뒤 다시 읽을 때 반영돼요." },
	"identity/IDENTITY.md": { path: () => IDENTITY_FILE, editable: true, label: "정체성", cap: 3_000, applies: "next-turn", note: "다음 세션·압축 뒤 다시 읽을 때 반영돼요." },
};

function fileDef(name: string): FileDef {
	const d = FILES[name === "IDENTITY.md" ? "identity/IDENTITY.md" : name];
	if (!d) throw new ControlError(`"${name}" 은(는) 열 수 있는 파일이 아니에요 (MODE.md, RULES.md, LESSONS.md, identity/IDENTITY.md)`, 404);
	return d;
}
const denyLines = (text: string) => [...((text.split(/^## Blocked commands\s*$/m)[1]?.split(/^## /m)[0] ?? "").matchAll(/^- deny:\s*(.+)\s+\|\s+(.+?)\s*$/gm))];

export function readHarnessFile(name: string) {
	const d = fileDef(name);
	const file = d.path();
	const exists = existsSync(file);
	const st = exists ? statSync(file) : undefined;
	return { name, label: d.label, path: file, text: exists ? readFileSync(file, "utf8") : "", exists, editable: d.editable, bytes: st?.size ?? 0, modified: st?.mtime.toISOString(), applies: d.applies, note: d.note, cap: d.cap };
}

// ---- the graph ---------------------------------------------------------------------------------------------------
const STATUS_KO: Record<string, string> = { working: "작업 중", idle: "대기", starting: "시작 중", stopped: "멈춤", "rate-limited": "한도 제한", exited: "종료됨" };
const sleep = <T,>(ms: number, v: T) => new Promise<T>(res => setTimeout(() => res(v), ms));
function ago(ms: number): string {
	const m = Math.round(ms / 60_000);
	return m < 1 ? "방금" : m < 60 ? `${m}분` : m < 48 * 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.round(m / 1440)}일`;
}
const fileFact = (name: string): { label: string; value: string }[] => {
	const f = fileDef(name).path();
	if (!existsSync(f)) return [{ label: "파일", value: "아직 없어요" }];
	const st = statSync(f);
	return [{ label: "크기", value: `${readFileSync(f, "utf8").length.toLocaleString("ko-KR")}자` }, { label: "마지막 수정", value: `${ago(Date.now() - st.mtimeMs)} 전` }];
};
const timeOr = (v: unknown, dflt: string) => (String(v ?? dflt) === "off" ? "꺼짐" : `매일 ${v ?? dflt}`);

// `ui.origin_view`: prompt files the owner wrote and the omp extension installed under ~/.omp are personal; MODE and the gateway's own systems ship with dotz.
const PERSONAL_NODES: Record<string, true> = { rules: true, lessons: true, identity: true, guard: true };
function markOrigin(nodes: HarnessNode[]): void {
	for (const n of nodes) {
		n.origin = PERSONAL_NODES[n.id] ? "personal" : "shipped";
		n.custom = n.settings.filter(s => s.editable && s.default !== undefined && !same(s.value, s.default)).map(s => ({ key: s.key, label: s.label, value: s.value, default: s.default!, ...(s.unit ? { unit: s.unit } : {}) }));
		if (n.origin === "personal" && n.file) {
			const f = fileDef(n.file).path();
			if (existsSync(f)) {
				const st = statSync(f);
				n.fileMeta = { bytes: readFileSync(f, "utf8").length, modified: st.mtime.toISOString() };
			}
		}
	}
}

export async function harnessGraph(opts: { terminals?: number; light?: boolean } = {}) {
	const disk = readDisk();
	const models = opts.light ? ([] as ModelInfo[]) : await Promise.race([availableModels().catch((): ModelInfo[] => []), sleep(2500, [] as ModelInfo[])]);
	const mName = (sel: string) => models.find(m => m.selector === sel)?.name ?? (sel.split("/").pop() ?? sel);
	const om = orchestratorModel(), lm = lanesModel(), wm = parseSelector(workerModel());
	const S = (p: string, over: Partial<Setting> = {}) => settingOf(p, disk, over);
	const ro = (key: string, label: string, value: string | number, source: string, extra: Partial<Setting> = {}): Setting => ({ key, label, value, type: "text", editable: false, applies: "restart", source, ...extra });

	// -- live state
	const dStat = discord.status;
	const laneList = [...lanes.values()];
	const aliveLanes = laneList.filter(l => l.status !== "exited");
	const working = laneList.filter(l => l.status === "working" || l.status === "starting").length;
	const schedules = listSchedules();
	const watches = allWatches();
	const failing = watches.filter(w => w.state.fails >= 2).length;
	const setups = listSetups();
	const maxActive = typeof disk.lanes?.max_active === "number" ? disk.lanes.max_active : 4;
	const guardFile = join(homedir(), ".omp", "agent", "extensions", "orchestrator-guard.ts");
	const guardOn = existsSync(guardFile);
	const rules = existsSync(paths.rules) ? readFileSync(paths.rules, "utf8") : "";
	const subagents = ["orchestrator", ...laneList.map(l => `lane:${l.name}`)].reduce((n, s) => n + runningSubagents(s), 0);
	const zeleOn = disk.zele?.enabled !== false;
	const nextSchedule = schedules.map(s => Date.parse(s.at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
	const orchTone: HarnessNode["status"] = ({ idle: "ok", working: "busy", starting: "busy", "rate-limited": "warn", stopped: "err" } as const)[orch.status];

	// -- provider quota (one 2.5 s try; the usage call finishes in the background and the next refresh has it)
	const q = opts.light ? undefined : await Promise.race([quota().catch(() => undefined), sleep(2500, undefined)]);
	const used = [...new Set([om.model, lm.model, wm.model].map(m => m.split("/")[0]))];
	const limits = (q?.providers ?? []).filter(p => used.includes(p.provider)).flatMap(p => p.limits.filter(l => l.limit && l.remaining != null).map(l => ({ p: p.provider, label: l.label, pct: Math.round((l.remaining! / l.limit!) * 100) })));
	const low = limits.length ? Math.min(...limits.map(l => l.pct)) : undefined;

	const nodes: HarnessNode[] = [
		// ---- inbound
		{
			id: "discord", kind: "channel", group: "flow", label: "Discord", status: !dStat.enabled ? "off" : dStat.connected ? "ok" : "err",
			summary: !dStat.enabled ? "꺼져 있어요" : dStat.connected ? `연결됨 · 작업 채널 ${Object.keys(discord.channels.work).length}개` : "연결 끊김",
			desc: "대화방·작업 채널·레인 스레드에 쓴 글을 받아 게이트웨이로 넘기고, 답장을 같은 곳에 올려요. 받은 글에는 👀 로 먼저 표시해요. 연결 정보(토큰·서버·소유자)는 보안상 화면에서 바꿀 수 없어요.",
			facts: [{ label: "상태", value: !dStat.enabled ? "꺼짐 (토큰·서버·소유자 중 빠진 게 있어요)" : dStat.connected ? "연결됨" : `끊김${dStat.error ? ` · ${dStat.error.slice(0, 80)}` : ""}` }, { label: "작업 채널", value: `${Object.keys(discord.channels.work).length}개` }, { label: "레인 스레드", value: `${Object.keys(discord.channels.lanes ?? {}).length}개` }],
			settings: [ro("discord.token_file", "봇 토큰", disk.discord?.token_file ? "설정됨" : "없음", "config.json:discord.token_file"), ro("discord.owner_id", "소유자", disk.discord?.owner_id ? "설정됨" : "없음", "config.json:discord.owner_id"), ro("discord.guild", "서버", disk.discord?.guild ? "설정됨" : "없음", "config.json:discord.guild")],
		},
		{
			id: "web", kind: "channel", group: "flow", label: "웹 앱", status: "ok", summary: "이 화면 · tailnet 안에서만 열려요",
			desc: "지금 보고 있는 화면이에요. 채팅·레인·설정을 보고, 메시지를 보내면 게이트웨이를 거쳐 오케스트레이터에게 가요. 서버는 이 컴퓨터(127.0.0.1)에만 열리고, 밖에서는 Tailscale 이 로그인 신원을 붙여 들여보내요.",
			facts: [{ label: "접속", value: "Tailscale 로 허용된 로그인만" }, { label: "메시지 보내기", value: "보통 / 끼워넣기 / 중단하고 보내기" }],
			settings: [ro("web.port", "포트", String(disk.web?.port ?? 7420), "config.json:web.port"), ro("web.tailscale_https_port", "Tailscale HTTPS 포트", String(disk.web?.tailscale_https_port ?? ""), "config.json:web.tailscale_https_port"), ro("web.allow_logins", "허용된 로그인", `${(disk.web?.allow_logins ?? []).length}명`, "config.json:web.allow_logins")],
		},
		{
			id: "terminal", kind: "channel", group: "flow", label: "터미널", status: opts.terminals ? "ok" : "off", summary: opts.terminals ? `연결된 터미널 ${opts.terminals}개` : "연결된 터미널 없음",
			desc: `터미널에서 "${NAME}모드 켜"라고 하면 그 터미널이 입력창이 돼서 쓴 글이 게이트웨이 오케스트레이터에게 가요. 꺼"라고 하면 다시 일반 터미널이에요.`,
			facts: [{ label: "연결된 터미널", value: `${opts.terminals ?? 0}개` }], settings: [],
		},
		{
			id: "schedule", kind: "channel", group: "flow", label: "예약 작업", status: "ok", summary: schedules.length ? `예약 ${schedules.length}개${nextSchedule ? ` · 다음은 ${ago(Math.abs(nextSchedule - Date.now()))} ${nextSchedule > Date.now() ? "뒤" : "전"}` : ""}` : "예약 없음",
			desc: "정해진 시각(한 번 또는 5분 이상 간격 반복)에 정해 둔 문장을 오케스트레이터에게 보내요. 오케스트레이터가 예약을 만들고 지울 수 있어요.",
			facts: [{ label: "예약", value: `${schedules.length}개` }, ...(nextSchedule ? [{ label: "다음 실행", value: new Date(nextSchedule).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }] : []), { label: "반복 예약", value: `${schedules.filter(s => s.every_minutes).length}개` }], settings: [],
		},
		{
			id: "watch", kind: "channel", group: "flow", label: "감시", status: failing ? "warn" : watches.length ? "ok" : "off", summary: watches.length ? `감시 ${watches.length}개${failing ? ` · 연속 실패 ${failing}개` : ""}` : "감시 없음",
			desc: "모델을 깨우지 않고 정해진 간격으로 명령을 실행해서, 값이 바뀌었거나 조건에 맞거나 실패했을 때만 알려요. 로그인 유지(세션 확인)도 여기서 해요. 2번 연속 실패하면 12시간에 한 번만 알리고, 복구되면 한 번 알려요.",
			facts: [{ label: "감시", value: `${watches.length}개` }, { label: "작업 채널별 설정", value: `${setups.length}개` }, { label: "연속 실패 중", value: `${failing}개` }], settings: [],
		},
		{
			id: "mail", kind: "channel", group: "flow", label: "메일·캘린더", status: zeleOn ? "ok" : "off", summary: zeleOn ? `${disk.zele?.poll_sec ?? 120}초마다 확인 · 아침 ${disk.zele?.brief_hour ?? 8}시 브리핑` : "꺼져 있어요",
			desc: "zele 로 구글 메일·캘린더를 확인해서 새 메일은 메일 채널 스레드로, 곧 있을 일정은 알림으로, 아침에는 하루 브리핑으로 보내요. 광고·알림성 메일은 걸러요.",
			facts: [{ label: "상태", value: zeleOn ? "켜짐 (계정이 없으면 10분마다 다시 확인)" : "꺼짐" }],
			settings: [S("zele.enabled"), S("zele.poll_sec"), S("zele.brief_hour")],
		},
		// ---- gateway
		{
			id: "gateway", kind: "gateway", group: "flow", label: "게이트웨이", status: "ok", summary: "메시지 묶기 · 명령 처리 · 답장 전달",
			desc: "모든 입력이 지나가는 문이에요. 같은 채널에서 연달아 온 글은 한 번에 묶어서 넘기고, /model·/restart 같은 명령과 \"한도\" 질문은 오케스트레이터를 깨우지 않고 직접 답해요. 답장은 질문한 채널로 돌려보내고, 60초 안에 답이 안 나가면 중간 보고를 요청해요. 재시작해도 답 못 한 메시지는 다시 처리해요.",
			facts: [{ label: "묶는 시간", value: `${disk.gateway?.coalesce_ms ?? 4000}ms (최대 20초까지)` }, { label: "직접 답하는 것", value: "/명령, \"한도\"" }, { label: "답장 길", value: "질문이 온 채널(Discord·웹·터미널)로" }, { label: "재시작", value: "작업이 모두 끝난 뒤(최대 20분) 새 코드로 다시 시작" }],
			settings: [S("gateway.coalesce_ms")],
		},
		// ---- orchestrator
		{
			id: "orchestrator", kind: "orchestrator", group: "flow", label: `오케스트레이터 (${NAME})`, status: orchTone,
			summary: `${mName(om.model)} · ${om.thinking} · ${STATUS_KO[orch.status] ?? orch.status}`,
			desc: "모든 메시지를 받는 상시 비서예요(omp 세션 하나). 가벼운 일은 직접 하고, 오래 걸리는 일은 레인에 맡겨요. 사용량 한도에 걸리면 메시지를 모아 뒀다가 리셋 직후 순서대로 처리하고, 서버 오류는 최대 4번 재시도해요. 죽으면 자동으로 다시 띄우고(10분에 3번까지), 대화가 길어지면 핸드오버와 함께 새 세션으로 넘어가요. 모델을 바꾸면 새 세션으로 시작해요.",
			facts: [
				{ label: "상태", value: STATUS_KO[orch.status] ?? orch.status },
				{ label: "컨텍스트", value: orch.ctx.window ? `${kTokens(orch.ctx.tokens)} / ${kTokens(orch.ctx.window)} (${percentOf(orch.ctx) ?? 0}%)` : orch.ctx.tokens ? kTokens(orch.ctx.tokens) : "-" },
				...(orch.status === "rate-limited" && orch.rateLimitedUntil ? [{ label: "재개 예정", value: new Date(orch.rateLimitedUntil).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }] : []),
				{ label: "캐시 유지", value: "한가할 때 50~58분에 한 번 신호(최대 12번)" },
				{ label: "시작 프롬프트", value: "행동 규칙 + 정체성 + 내 규칙 + 교훈 + 작업 채널 요약" },
			],
			settings: [S("orchestrator.model"), S("orchestrator.thinking"), S("orchestrator.rotate_tokens")],
		},
		// ---- prompt files
		{ id: "mode", kind: "file", group: "files", anchor: "orchestrator", order: 1, label: "행동 규칙 (MODE)", status: existsSync(modeFile()) ? "ok" : "err", summary: `${modeFile().split("/").pop()} · 읽기 전용`, desc: "오케스트레이터와 레인이 어떻게 일할지 정한 기본 계약이에요. 저장소와 함께 배포되는 파일이라 여기서는 읽기만 돼요.", facts: [{ label: "사용 중인 파일", value: modeFile().split("/").pop() ?? "" }, { label: "언어", value: lang() }], settings: [], file: "MODE.md", fileEditable: false },
		{ id: "identity", kind: "file", group: "files", anchor: "orchestrator", order: 2, label: "정체성", status: existsSync(IDENTITY_FILE) ? "ok" : "warn", summary: `이름 ${NAME} · 응답 언어 ${lang()}`, desc: "이름·성격·말투예요. IDENTITY.md 가 있으면 그 내용을, 없으면 설정의 성격·말투를 시작 프롬프트에 넣어요. 응답 언어는 출력 언어 점검의 기준이기도 해요.", facts: fileFact("identity/IDENTITY.md"), settings: [S("identity.name"), S("identity.language"), S("identity.character"), S("identity.tone")], file: "identity/IDENTITY.md", fileEditable: true },
		{ id: "rules", kind: "file", group: "files", anchor: "orchestrator", order: 3, label: "내 규칙 (RULES)", status: "ok", summary: `규칙 파일 · 차단 명령 ${denyLines(rules).length}개`, desc: "내가 정한 상시 규칙과 금지예요. 행동 규칙보다 우선하고 레인도 읽어요. \"Blocked commands\" 줄은 오케스트레이터·레인·작업자가 실행하기 전에 막아요.", facts: [...fileFact("RULES.md"), { label: "차단 명령", value: `${denyLines(rules).length}개` }], settings: [], file: "RULES.md", fileEditable: true },
		{ id: "lessons", kind: "file", group: "files", anchor: "orchestrator", order: 4, label: "교훈 (LESSONS)", status: "ok", summary: "야간 회고가 쌓는 메모", desc: "오케스트레이터가 매일 밤 회고하면서 스스로 정리하는 메모예요(대략 30줄). 내 규칙이 항상 우선해요. 고치거나 지워도 돼요.", facts: fileFact("LESSONS.md"), settings: [], file: "LESSONS.md", fileEditable: true },
		// ---- lanes
		{
			id: "lanes", kind: "lanes", group: "flow", label: "레인", status: working ? "busy" : aliveLanes.length ? "ok" : "off",
			summary: aliveLanes.length ? `${aliveLanes.length}개 · 작업 중 ${working} · 동시 ${maxActive}개까지` : `없음 · 동시 ${maxActive}개까지`,
			desc: "오래 걸리는 프로젝트 작업을 맡는 독립 세션이에요(채널 하나에 레인 하나). git 저장소면 레인마다 전용 작업 폴더(worktree)와 브랜치에서 일해서 내 작업 폴더를 건드리지 않고, 끝나서 병합되면 정리해요. 시작할 때마다 설정 파일(omp 오버레이)을 새로 써서 작업자 모델과 자동 압축 기준을 적용해요. 멈춘 레인은 자동으로 이어서 시작해요(1시간에 3번까지).",
			facts: [{ label: "레인", value: `${aliveLanes.length}개 (작업 중 ${working})` }, ...aliveLanes.slice(0, 8).map(l => ({ label: l.name, value: `${mName(l.model)} · ${STATUS_KO[l.status] ?? l.status}` })), { label: "작업 폴더", value: "git 저장소면 레인 전용 worktree" }, { label: "압축", value: `컨텍스트 ${(disk.lanes?.compact_at ?? 400_000).toLocaleString("ko-KR")}토큰에서 자동` }],
			settings: [S("lanes.model"), S("lanes.thinking"), S("lanes.max_active"), S("lanes.compact_at"), S("lanes.keep_recent")],
		},
		// ---- workers
		{
			id: "workers", kind: "workers", group: "flow", label: "작업자 (서브에이전트)", status: subagents ? "busy" : "ok", summary: `${mName(workerModel().replace(/:[a-z]+$/, ""))} · ${wm.thinking}${subagents ? ` · 실행 중 ${subagents}개` : ""}`,
			desc: "레인이 구현·테스트·탐색을 나눠 맡기는 일꾼이에요. 레인은 계획과 검토를 자기 모델로 하고, 작업자는 더 싼 모델로 병렬 실행해요. 파일을 쓰는 작업자는 격리된 사본에서 일하고 결과를 패치로 돌려줘요. 패치는 읽어 본 뒤에만 적용할 수 있어요.",
			facts: [{ label: "종류", value: "task(구현·테스트·렌더), scout(탐색)" }, { label: "동시 실행 상한", value: `레인당 ${WORKER_SLOTS}개 (이 컴퓨터 사양 기준)` }, { label: "실행 중", value: `${subagents}개` }, { label: "격리", value: "쓰기 작업자는 격리 사본 + 패치 검토 후 적용" }, { label: "비싼 모델", value: "Fable·최고 강도는 내가 직접 요청한 때만" }],
			settings: [S("lanes.worker_model"), S("lanes.worker_effort")],
		},
		// ---- support: around the gateway
		{ id: "outlang", kind: "system", group: "support", anchor: "gateway", order: 1, label: "출력 언어 점검", status: modeOf(disk) === "off" ? "off" : "ok", summary: modeOf(disk) === "off" ? "꺼져 있어요" : `${lang()} 가 아니면 다시 써서 보내요`, desc: "내게 가는 글이 정체성 언어와 다르면(영어로 생각하다 새어 나온 경우 등) 작은 모델 한 번으로 번역해서 보내요. 언어 감지는 로컬이라 공짜고, 실패하면 원문이 그대로 나가요.", facts: [{ label: "기준 언어", value: lang() }], settings: [S("output_language.mode"), S("output_language.model"), S("output_language.timeout_s")] },
		{ id: "update", kind: "system", group: "support", anchor: "gateway", order: 2, label: "omp 업데이트 확인", status: disk.omp_update?.mode === "off" || disk.omp_update?.at === "off" ? "off" : "ok", summary: disk.omp_update?.mode === "off" ? "꺼져 있어요" : `${timeOr(disk.omp_update?.at, "04:20")} · ${disk.omp_update?.mode === "install" ? "자동 설치" : "새 버전만 알림"}`, desc: "매일 새 omp 버전이 있는지 확인해서 작업 로그 채널에 알려요. '자동 설치'로 두면 설치하고 모두 한가해질 때 게이트웨이를 재시작해요.", facts: [], settings: [S("omp_update.mode"), S("omp_update.at")] },
		{ id: "audit", kind: "system", group: "support", anchor: "gateway", order: 3, label: "토큰 사용 감사", status: String(disk.token_audit_at ?? "04:30") === "off" ? "off" : "ok", summary: timeOr(disk.token_audit_at, "04:30"), desc: "매일 omp 세션 기록을 훑어서 이유 없이 캐시가 깨졌거나 컨텍스트가 비정상적으로 큰 세션 같은 낭비를 찾아내요. 이상이 있으면 알림 채널로 알려요.", facts: [], settings: [S("token_audit_at")] },
		{ id: "reflect", kind: "system", group: "support", anchor: "gateway", order: 4, label: "야간 회고", status: String(disk.reflect_at ?? "04:40") === "off" ? "off" : "ok", summary: `${timeOr(disk.reflect_at, "04:40")} · 교훈 정리 + 백업`, desc: "매일 밤 전날 대화를 요약해서 오케스트레이터에게 돌아보게 하고, 배운 것을 교훈 파일에 적게 해요. 그 전에 설정 폴더를 git 스냅샷으로 남겨요. 조용한 날은 건너뛰어요.", facts: [], settings: [S("reflect_at")] },
		{ id: "backup", kind: "system", group: "support", anchor: "reflect", order: 1, label: "백업", status: disk.backup?.remote ? "ok" : "off", summary: disk.backup?.remote ? "스냅샷 + 외부 저장소" : "이 컴퓨터에만 스냅샷", desc: "매일 밤 설정·규칙·교훈을 git 으로 스냅샷해요. 저장소 주소를 적으면 밖으로도 올리는데, 비밀처럼 보이는 파일이 하나라도 있으면 올리지 않아요.", facts: [{ label: "외부 저장소", value: disk.backup?.remote ? "설정됨" : "없음" }], settings: [S("backup.remote", disk.backup?.remote && /\/\/[^/@\s]+@/.test(String(disk.backup.remote)) ? { value: "설정됨 (인증 정보 포함)", editable: false, hint: "인증 정보가 들어 있어서 화면에서는 바꿀 수 없어요" } : {})] },
		// ---- support: orchestrator column
		{ id: "providers", kind: "system", group: "support", anchor: "orchestrator", order: 5, label: "공급자·한도", status: low === undefined ? "ok" : low <= 10 ? "err" : low <= 30 ? "warn" : "ok", summary: limits.length ? `${used.length}곳 사용 · 가장 적은 한도 ${low}% 남음` : `${used.length}곳 사용 중`, desc: "모델 제공자(Anthropic 등) 로그인·키와 사용량이에요. 레인을 시작하기 전에 5시간 한도를 보고, 이 작업이 쓸 몫(기본 15%)을 빼고도 10%가 안 남으면 먼저 물어봐요. 7일 한도는 보여주기만 해요.", facts: [{ label: "쓰는 공급자", value: used.join(", ") }, ...limits.slice(0, 6).map(l => ({ label: `${l.p} ${l.label}`, value: `${l.pct}% 남음` }))], settings: [] },
		// ---- support: lanes column
		{ id: "hygiene", kind: "system", group: "support", anchor: "lanes", order: 1, label: "레인 야간 정리", status: String(disk.lanes?.nightly_at ?? "04:30") === "off" ? "off" : "ok", summary: `${timeOr(disk.lanes?.nightly_at, "04:30")} · 길어진 레인 압축·교체`, desc: "매일 정해진 시각에 한가한 레인을 살펴서, 세션 파일이 크면 새 세션으로 넘기고(핸드오버) 컨텍스트가 크면 압축해요. 일하던 레인은 건드리지 않아요. 끝난 작업자의 남은 임시 폴더도 한 시간마다 지워요.", facts: [], settings: [S("lanes.nightly_at"), S("lanes.nightly_compact_at"), S("lanes.rotate_mb")] },
		{ id: "memguard", kind: "system", group: "support", anchor: "lanes", order: 2, label: "메모리 가드", status: (disk.lanes?.max_rss_gb ?? 8) === 0 ? "off" : "ok", summary: (disk.lanes?.max_rss_gb ?? 8) === 0 ? "꺼져 있어요" : `프로세스당 ${disk.lanes?.max_rss_gb ?? 8}GB 넘으면 재시작`, desc: "30초마다 오케스트레이터·레인 프로세스의 메모리를 보고 한도를 넘으면 같은 세션으로 다시 시작해요(엉뚱한 grep 하나가 수십 GB를 먹는 일을 막아요). 한 시간에 3번을 넘기면 알림만 보내고 멈춰요.", facts: [], settings: [S("lanes.max_rss_gb")] },
		// ---- support: workers column
		{
			id: "guard", kind: "system", group: "support", anchor: "workers", order: 1, label: "작업 가드 (omp 확장)", status: guardOn ? "ok" : "warn", summary: guardOn ? "브리핑·패치·예산·외부 명령 점검" : "설치돼 있지 않아요",
			desc: "omp 쪽에 설치된 orchestrator-guard 확장이에요(게이트웨이 밖, 이 컴퓨터의 omp 설정). 작업자를 부르는 순간과 작업자가 도는 동안 아래 규칙을 강제해요. 여기서는 읽기만 돼요.",
			facts: [
				{ label: "상태", value: guardOn ? "설치됨" : "설치 안 됨 (규칙이 강제되지 않아요)" },
				{ label: "브리핑", value: "완료 조건 필수 · 8000자·코드 40줄 제한 · 답변 800자 이내" },
				{ label: "패치", value: "쓰기 작업자는 격리 + 패치를 읽어야 적용 가능" },
				{ label: "예산", value: "5시간 한도가 모자라면 막고 허락을 받아요" },
				{ label: "비싼 모델", value: "Fable·최고 강도는 내가 요청했을 때만" },
				{ label: "외부 명령", value: "push·배포·ssh·외부 전송은 작업자가 못 하고 돌려줘요" },
				{ label: "컨텍스트", value: "작업자 압축 1번: 마무리 유도, 2번: 도구 차단" },
				{ label: "내 규칙의 차단 명령", value: `${denyLines(rules).length}개` },
			], settings: [],
		},
	];
	const edges: HarnessEdge[] = [
		{ from: "discord", to: "gateway", label: "메시지" },
		{ from: "web", to: "gateway", label: "채팅" },
		{ from: "terminal", to: "gateway", label: "터미널 입력" },
		{ from: "schedule", to: "gateway", label: "정해진 시각" },
		{ from: "watch", to: "gateway", label: "변화 감지" },
		{ from: "mail", to: "gateway", label: "새 메일·일정" },
		{ from: "gateway", to: "orchestrator", label: "묶어서 전달" },
		{ from: "orchestrator", to: "lanes", label: "작업 위임" },
		{ from: "lanes", to: "workers", label: "병렬 실행" },
		{ from: "mode", to: "orchestrator", label: "행동 규칙" },
		{ from: "identity", to: "orchestrator", label: "이름·말투" },
		{ from: "rules", to: "orchestrator", label: "내 규칙" },
		{ from: "rules", to: "lanes", label: "레인도 읽음" },
		{ from: "lessons", to: "orchestrator", label: "교훈" },
		{ from: "reflect", to: "lessons", label: "교훈 기록" },
		{ from: "reflect", to: "backup", label: "스냅샷" },
		{ from: "reflect", to: "orchestrator", label: "회고 요청" },
		{ from: "outlang", to: "gateway", label: "답장 언어 점검" },
		{ from: "update", to: "gateway", label: "새 버전 알림" },
		{ from: "audit", to: "gateway", label: "낭비 알림" },
		{ from: "providers", to: "orchestrator", label: "모델·한도" },
		{ from: "providers", to: "lanes", label: "예산 게이트" },
		{ from: "hygiene", to: "lanes", label: "야간 정리" },
		{ from: "memguard", to: "lanes", label: "메모리 감시" },
		{ from: "memguard", to: "orchestrator", label: "메모리 감시" },
		{ from: "guard", to: "workers", label: "규칙 강제" },
	];
	const originView = uiOriginView();
	if (originView) markOrigin(nodes);
	return { generated: new Date().toISOString(), name: NAME, nodes, edges, ...(originView ? { origin_view: true, data_dir: DATA_DIR.startsWith(`${homedir()}/`) ? `~${DATA_DIR.slice(homedir().length)}` : DATA_DIR } : {}) };
}
