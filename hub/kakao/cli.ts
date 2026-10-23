// `bun hub/kakao/cli.ts <setup|status|login|read|draft|send|off>`: the one entry point of the KakaoTalk integration for the
// orchestrator and the owner. Off by default: until `setup` wrote an enabled config, every command except setup/status/off prints
// one line and does nothing else (no runner call, no gateway call). The db / creds / login / send modules are loaded on first use
// (variable specifier, like watch.ts does for creds.ts), so `status` and `off` stay cheap and never touch the app.
import { existsSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite, cardFile, featureFile, isOn, OFF_LINE, type Deps, pidAlive, type Ports, readJson, readState, RUNNING_LINE, runDry, runLoginOnly, runOnboarding, stepName, WATCH_NAME } from "./onboard.ts";
import { createHub } from "./hub.ts";
import { hasWords, readText } from "./db.ts";
import type { RoomFact } from "./room.ts";
import { listBlock } from "../listblock.ts";
import { defaultRunner, type HubFull, type KakaoConfig, type KakaoPaths, kakaoPaths, type Msg, type Room, type Runner } from "./types.ts";

export type Reader = {
	rooms: () => Promise<Room[]>;
	messages: (chatId: string, limit: number) => Promise<Msg[]>;
	draftable: (room: Room) => boolean;
	// Display label of a room without a name (group rooms named after their members).
	label?: (chatId: string) => Promise<string | undefined>;
};
export type DraftsApi = {
	create: (input: { chatId: string; roomName: string; text: string; basisLogId: string }) => Promise<{ code: string }>;
	block: (draft: any) => string;
	send: (code: string, deps: { latestIncoming: (chatId: string) => Promise<string | undefined>; roomNames: () => Promise<RoomFact[]> }) => Promise<{ ok: boolean; reason?: string }>;
};

export type Ctx = {
	paths: KakaoPaths;
	runner: Runner;
	hub: HubFull;
	ports: Ports;
	out: (line: string) => void;
	stdin: () => Promise<string>;
	repo: string;
	execPath: string;
	brew: string;
	spawnSetup: (args: string[]) => void;
	reader: (config: KakaoConfig) => Promise<Reader>;
	drafts: () => Promise<DraftsApi>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	pid: number;
	isAlive: (pid: number) => boolean;
	log?: (line: string) => void;
};

const VALUE_FLAGS = new Set(["to", "chat", "limit", "draft"]);
const GATED = new Set(["login", "rooms", "read", "draft", "send"]);
const MAX_READ = 50;
const USAGE = "사용법: cli.ts setup [--to <대상>] [--dry-run] | status [--json] | login | rooms [--all] [--limit 30] [--plain] | read --chat <id> [--limit 20] | draft --chat <id> | send --draft <코드> | off [--forget]";

function parseArgs(argv: string[]): Record<string, string | true> {
	const out: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (!a.startsWith("--")) continue;
		const name = a.slice(2);
		if (VALUE_FLAGS.has(name) && argv[i + 1] !== undefined) out[name] = argv[++i]!;
		else out[name] = true;
	}
	return out;
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const onboardDeps = (ctx: Ctx, target: string): Deps => ({ paths: ctx.paths, runner: ctx.runner, hub: ctx.hub, ports: ctx.ports, target, repo: ctx.repo, execPath: ctx.execPath, brew: ctx.brew, sleep: ctx.sleep, now: ctx.now, pid: ctx.pid, isAlive: ctx.isAlive, log: ctx.log });

async function setup(args: Record<string, string | true>, ctx: Ctx): Promise<number> {
	if (args["dry-run"]) {
		await runDry(line => ctx.out(line), ctx.repo, ctx.execPath);
		return 0;
	}
	const prev = readState(ctx.paths);
	if (prev?.status === "running" && prev.pid && prev.pid !== ctx.pid && ctx.isAlive(prev.pid)) {
		ctx.out(RUNNING_LINE);
		return 0;
	}
	const target = str(args.to) ?? prev?.target ?? "chat";
	if (!args.foreground) {
		ctx.spawnSetup(["setup", "--foreground", "--to", target]);
		ctx.out("[run] 카톡 연결을 시작했어요. 진행 상황은 알림 메시지 하나로 알려 드려요");
		return 0;
	}
	const r = await runOnboarding(onboardDeps(ctx, target));
	ctx.out(r.text.split("\n")[0]!);
	return 0;
}

async function status(args: Record<string, string | true>, ctx: Ctx): Promise<number> {
	const { paths } = ctx;
	if (!isOn(paths)) {
		ctx.out(args.json ? JSON.stringify({ 연결: "꺼짐" }) : OFF_LINE);
		return 0;
	}
	const st = readState(paths);
	const setupText = !st ? "시작 전" : st.status === "done" ? "끝" : st.status === "stopped" && st.stoppedAt ? `멈춤: ${stepName(st.stoppedAt.step)} (${st.stoppedAt.reason})` : st.current ? `진행 중: ${stepName(st.current)}` : "진행 중";
	const app = await ctx.runner(["pgrep", "-xq", "KakaoTalk"]).catch(() => ({ code: 1 }));
	let lastRun = "알 수 없어요";
	try {
		const r = await ctx.hub.get("/api/watches");
		const list: any[] = Array.isArray(r.json) ? r.json : (r.json?.watches ?? []);
		const w = list.find(x => x.name === WATCH_NAME);
		if (w) lastRun = w.paused ? "모니터링이 멈춰 있어요" : w.lastRun ? `${new Date(w.lastRun).toISOString()}${w.fails > 0 ? ` (실패 ${w.fails}번)` : ""}` : "아직 없어요";
		else lastRun = "모니터링이 등록돼 있지 않아요";
	} catch {}
	const drafts = readJson<{ status?: string }[]>(paths.drafts);
	const pending = Array.isArray(drafts) ? drafts.filter(d => d?.status === "pending").length : 0;
	const kv = { 연결: "켜짐", 설정: setupText, 로그인: app.code === 0 ? "카카오톡 앱이 켜져 있어요" : "카카오톡 앱이 꺼져 있어요", "마지막 확인": lastRun, "답장 대기": `${pending}개` };
	if (args.json) ctx.out(JSON.stringify(kv));
	else for (const [k, v] of Object.entries(kv)) ctx.out(`${k}: ${v}`);
	return 0;
}

const clock = (sentAt: number) => {
	const d = new Date(sentAt > 1e11 ? sentAt : sentAt * 1000);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function draftableRoom(ctx: Ctx, config: KakaoConfig, chat: string): Promise<{ reader: Reader; room: Room } | undefined> {
	const reader = await ctx.reader(config);
	const room = (await reader.rooms()).find(r => r.chatId === chat);
	return room && reader.draftable(room) ? { reader, room } : undefined;
}

const newestIncoming = (list: Msg[]) => list.findLast(m => hasWords(m) && !m.fromMe);

const KIND: Record<Room["kind"], string> = { direct: "1:1", group: "단체", self: "나와의 채팅", channel: "채널", open: "오픈채팅", other: "기타" };

// Newest first; without --all only the rooms drafts can be made for. Prints a 목록 block for the owner (post it unchanged);
// --plain prints one "chatId  name  (kind, time)" line per room for read / draft.
async function rooms(args: Record<string, string | true>, ctx: Ctx, config: KakaoConfig): Promise<number> {
	const limit = Math.min(Math.max(Math.trunc(Number(str(args.limit) ?? 30)) || 30, 1), 500);
	const reader = await ctx.reader(config);
	const all = (await reader.rooms()).filter(r => args.all || reader.draftable(r)).sort((a, b) => b.lastAt - a.lastAt);
	const today = new Date(ctx.now()).toDateString();
	const stamp = (at: number) => {
		const d = new Date(at > 1e11 ? at : at * 1000);
		return d.toDateString() === today ? clock(at) : `${d.getMonth() + 1}/${d.getDate()} ${clock(at)}`;
	};
	const shown = all.slice(0, limit);
	const names = new Map<string, string>();
	for (const r of shown) names.set(r.chatId, r.name === "(unknown)" ? ((await reader.label?.(r.chatId)) ?? "이름 없는 방") : r.name);
	if (args.plain) {
		for (const r of shown) ctx.out(`${r.chatId}  ${names.get(r.chatId)}${r.name === "(unknown)" ? " (이름 없음)" : ""}  (${KIND[r.kind]}${r.unread > 0 ? `, 안 읽음 ${r.unread}` : ""}, ${stamp(r.lastAt)})`);
		ctx.out(`대화방 ${shown.length}개 / 전체 ${all.length}개`);
		return 0;
	}
	const rows = shown.map(r => ({ title: names.get(r.chatId)!, sub: r.name === "(unknown)" ? `${KIND[r.kind]} · 이름 없는 방` : KIND[r.kind], meta: stamp(r.lastAt), badge: r.unread }));
	ctx.out(listBlock(`카톡 대화방 · 최근 ${shown.length}개 / 전체 ${all.length}개`, rows));
	return 0;
}

async function read(args: Record<string, string | true>, ctx: Ctx, config: KakaoConfig): Promise<number> {
	const chat = str(args.chat);
	if (!chat) return ctx.out(USAGE), 2;
	const limit = Math.min(Math.max(Math.trunc(Number(str(args.limit) ?? 20)) || 20, 1), MAX_READ);
	const hit = await draftableRoom(ctx, config, chat);
	if (!hit) return ctx.out("이 대화방은 읽을 수 없어요. 답장 초안 대상이 아니에요"), 1;
	const texts = (await hit.reader.messages(chat, MAX_READ)).filter(hasWords).slice(-limit);
	if (!texts.length) ctx.out("읽을 텍스트 메시지가 없어요");
	for (const m of texts) ctx.out(`[${clock(m.sentAt)}] ${m.fromMe ? "나" : m.sender || "상대"}: ${readText(m).replaceAll("\n", "\n  ")}`);
	return 0;
}

async function draft(args: Record<string, string | true>, ctx: Ctx, config: KakaoConfig): Promise<number> {
	const chat = str(args.chat);
	if (!chat) return ctx.out(USAGE), 2;
	const text = (await ctx.stdin()).trim();
	if (!text) return ctx.out("답장 글을 표준 입력으로 보내 주세요"), 2;
	const hit = await draftableRoom(ctx, config, chat);
	if (!hit) return ctx.out("이 대화방은 초안을 만들 수 없어요. 답장 초안 대상이 아니에요"), 1;
	const basis = newestIncoming(await hit.reader.messages(chat, MAX_READ));
	if (!basis) return ctx.out("답장할 받은 메시지가 없어요"), 1;
	try {
		const drafts = await ctx.drafts();
		ctx.out(drafts.block(await drafts.create({ chatId: chat, roomName: hit.room.name, text, basisLogId: basis.logId })));
		return 0;
	} catch (e) {
		return ctx.out((e as Error).message), 1;
	}
}

async function send(args: Record<string, string | true>, ctx: Ctx, config: KakaoConfig): Promise<number> {
	const code = str(args.draft);
	if (!code) return ctx.out(USAGE), 2;
	let reader: Reader | undefined;
	const open = async () => (reader ??= await ctx.reader(config));
	const r = await (await ctx.drafts()).send(code, {
		latestIncoming: async chatId => newestIncoming(await (await open()).messages(chatId, MAX_READ))?.logId,
		roomNames: async () => (await (await open()).rooms()).map(({ chatId, name, kind, members }) => ({ chatId, name, kind, members })),
	});
	ctx.out(r.ok ? "보냈어요" : `보내지 않았어요: ${r.reason ?? "이유를 알 수 없어요"}`);
	return r.ok ? 0 : 1;
}

async function off(args: Record<string, string | true>, ctx: Ctx): Promise<number> {
	const { paths } = ctx;
	const config = readJson<KakaoConfig>(paths.config);
	const state = readState(paths);
	if (!config && !state) return ctx.out("카톡 연동은 이미 꺼져 있어요"), 0;
	if (config) atomicWrite(paths.config, `${JSON.stringify({ ...config, enabled: false }, null, 1)}\n`);
	let watchStopped = true;
	try {
		const r = await ctx.hub.get("/api/watches");
		const list: any[] = Array.isArray(r.json) ? r.json : (r.json?.watches ?? []);
		const w = list.find(x => x.name === WATCH_NAME);
		// A watch tied to a work channel refuses DELETE (409); pausing always works.
		if (w && (await ctx.hub.del(`/api/watches/${w.id}`)).status >= 300) watchStopped = (await ctx.hub.patch(`/api/watches/${w.id}`, { paused: true })).status < 300;
	} catch {
		watchStopped = false;
	}
	rmSync(dirname(cardFile(paths)), { recursive: true, force: true });
	rmSync(featureFile(paths), { force: true });
	try {
		rmdirSync(dirname(featureFile(paths)));
	} catch {}
	rmSync(paths.onboard, { force: true });
	if (args.forget) await ctx.ports.clearCredentials();
	ctx.out("카톡 연동을 껐어요");
	if (!watchStopped) ctx.out("새 메시지 모니터링은 멈추지 못했어요. 게이트웨이가 켜져 있는지 확인하고 다시 꺼 주세요");
	return 0;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
	const [cmd = "", ...rest] = argv;
	const args = parseArgs(rest);
	if (cmd === "setup") return setup(args, ctx);
	if (cmd === "status") return status(args, ctx);
	if (cmd === "off") return off(args, ctx);
	if (!GATED.has(cmd)) return ctx.out(USAGE), 2;
	const config = readJson<KakaoConfig>(ctx.paths.config);
	if (config?.enabled !== true) return ctx.out(OFF_LINE), 1;
	if (cmd === "login") {
		const r = await runLoginOnly(onboardDeps(ctx, readState(ctx.paths)?.target ?? "chat"));
		ctx.out(r.text);
		return r.ok ? 0 : 1;
	}
	if (cmd === "rooms") return rooms(args, ctx, config);
	if (cmd === "read") return read(args, ctx, config);
	if (cmd === "draft") return draft(args, ctx, config);
	return send(args, ctx, config);
}

const load = <T>(name: string) => import(`./${name}.ts`) as Promise<T>;

export function realCtx(paths: KakaoPaths): Ctx {
	const runner = defaultRunner;
	const deps = { paths, runner };
	const creds = () => load<typeof import("./creds.ts")>("creds");
	const login = () => load<typeof import("./login.ts")>("login");
	const dbm = () => load<typeof import("./db.ts")>("db");
	const ports: Ports = {
		hasKmsg: () => Boolean(Bun.which("kmsg")) || existsSync("/opt/homebrew/bin/kmsg"),
		appInstalled: async () => (await login()).appInstalled(deps),
		accessibilityGranted: async () => (await login()).accessibilityGranted(deps),
		hasCredentials: async () => (await creds()).hasCredentials(deps),
		importAuthFile: async () => (await creds()).importAuthFile(deps),
		clearCredentials: async () => (await creds()).clearCredentials(deps),
		login: async () => (await login()).login(deps),
		resumeAfterConfirm: async () => (await login()).resumeAfterConfirm(deps),
		derive: async () => {
			const { dbPath, key, userId } = await (await dbm()).deriveDb(paths, runner);
			await (await creds()).setSecret("dbkey", key, deps);
			return { dbPath, userId };
		},
		readCounts: async config => {
			const db = await openDb(config);
			const m = await dbm();
			const all = await m.rooms(db);
			return { rooms: all.length, draftable: all.filter(r => r.kind === "direct" || r.kind === "group").length, maxLogId: await m.maxLogId(db) };
		},
	};
	const openDb = async (config: KakaoConfig) => {
		const key = await (await creds()).getSecret("dbkey", deps);
		if (!key || !config.dbPath) throw new Error("no database key or path");
		return (await dbm()).sqlcipherDb(config.dbPath, key, runner);
	};
	const cliPath = join(import.meta.dir, "cli.ts");
	return {
		paths,
		runner,
		hub: createHub(paths.dataDir),
		ports,
		out: line => console.log(line),
		stdin: () => Bun.stdin.text(),
		repo: join(import.meta.dir, "..", ".."),
		execPath: process.execPath,
		brew: Bun.which("brew") ?? "/opt/homebrew/bin/brew",
		spawnSetup: args => {
			const child = Bun.spawn([process.execPath, cliPath, ...args], { detached: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, DOTZ_DIR: paths.dataDir } });
			child.unref();
		},
		reader: async config => {
			const m = await dbm();
			const db = await openDb(config);
			return { rooms: () => m.rooms(db), messages: (chatId, limit) => m.messages(db, chatId, limit, config.userId ?? ""), draftable: room => m.isDraftCandidate(room, config), label: chatId => m.memberLabel(db, chatId, config.userId ?? "") };
		},
		drafts: async () => {
			const s = await load<typeof import("./send.ts")>("send");
			return { create: input => s.createDraft(input, deps), block: s.draftBlock, send: (code, extra) => s.sendDraft(code, { ...deps, ...extra }) };
		},
		sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
		now: Date.now,
		pid: process.pid,
		isAlive: pidAlive,
		log: line => console.error(line),
	};
}

if (import.meta.main) {
	const paths = kakaoPaths(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"));
	process.exit(await run(process.argv.slice(2), realCtx(paths)));
}
