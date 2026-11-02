import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import { createSelfChat, normalizeSelfChat, type SelfChat, type SelfChatConfig } from "./jandi-selfchat.ts";
import { type Adapter, type AdapterStatus, type DeliverResult, type DesiredRoom, type MessengerCtx, type OutMsg, type Settings, type SettingsPut, SettingsError, type TestResult } from "./messenger.ts";
import { sameRoom } from "./messenger-rooms.ts";

// JANDI (on-prem, LAN) as a built-in messenger. Inbound: a JANDI Team Outgoing Webhook POSTs to /jandi/<room id> on our own listener
// (no Tailscale needed). Outbound: each room has a JANDI Incoming Webhook URL. JANDI cannot edit a posted message, so progress edits are skipped.

export type RoomKind = "main" | "project" | "alert" | "worklog";
export type JandiRoom = { id: string; name: string; kind: RoomKind; project?: string; outgoing_token: string; incoming_url: string };
/** `incoming_url` is the one webhook every room without its own posts to (JANDI cannot make webhooks by API, so one pasted URL is the fallback). */
export type JandiConfig = { enabled: boolean; listen: { host: string; port: number }; allow_emails: string[]; allow_names?: string[]; incoming_url?: string; rooms: JandiRoom[]; self_chat?: SelfChatConfig };
export type RoomStatus = { last_in?: number; last_out?: number; last_error?: string };

const KINDS: readonly string[] = ["main", "project", "alert", "worklog"];
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PART = 4000;
const RECEIPT = { body: "받았어요", connectColor: "#FAC11B" };
const ASK_HINT = "번호로 답해 주세요";

export const jandiConfigPath = (dataDir: string = DATA_DIR) => join(dataDir, "messengers", "jandi.json");

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map(x => x.trim()) : []);

function normalize(raw: unknown): JandiConfig {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
	const port = Number(o.listen?.port);
	const rooms: JandiRoom[] = [];
	const seen = new Set<string>();
	for (const r of Array.isArray(o.rooms) ? o.rooms : []) {
		if (!r || typeof r.id !== "string" || !ROOM_ID.test(r.id) || seen.has(r.id) || !KINDS.includes(r.kind)) continue;
		seen.add(r.id);
		rooms.push({
			id: r.id,
			name: typeof r.name === "string" ? r.name : r.id,
			kind: r.kind,
			...(typeof r.project === "string" && r.project ? { project: r.project } : {}),
			outgoing_token: typeof r.outgoing_token === "string" ? r.outgoing_token : "",
			incoming_url: typeof r.incoming_url === "string" ? r.incoming_url : "",
		});
	}
	const names = strings(o.allow_names);
	const selfChat = normalizeSelfChat(o.self_chat);
	return {
		enabled: o.enabled === true,
		listen: { host: typeof o.listen?.host === "string" && o.listen.host ? o.listen.host : "0.0.0.0", port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 0 },
		allow_emails: strings(o.allow_emails).map(s => s.toLowerCase()),
		...(names.length ? { allow_names: names } : {}),
		...(typeof o.incoming_url === "string" && o.incoming_url.trim() ? { incoming_url: o.incoming_url.trim() } : {}),
		rooms,
		...(selfChat ? { self_chat: selfChat } : {}),
	};
}

const cache = new Map<string, { stamp: string; v: JandiConfig }>();
/** The config, re-read only when the file's mtime/size changes; a missing or broken file is a disabled config. */
export function loadJandiConfig(dataDir: string = DATA_DIR): JandiConfig {
	const file = jandiConfigPath(dataDir);
	let stamp: string;
	try {
		const st = statSync(file);
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		return normalize(undefined);
	}
	const hit = cache.get(file);
	if (hit?.stamp === stamp) return hit.v;
	let v: JandiConfig;
	try {
		v = normalize(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		v = normalize(undefined);
	}
	cache.set(file, { stamp, v });
	return v;
}

/** Writes the config (tokens and webhook URLs are secrets) with mode 0600. */
export function saveJandiConfig(cfg: JandiConfig, dataDir: string = DATA_DIR): JandiConfig {
	const next = normalize(cfg);
	mkdirSync(join(dataDir, "messengers"), { recursive: true });
	writeAtomic(jandiConfigPath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 0o600);
	return next;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameToken = (given: unknown, want: string) => typeof given === "string" && want !== "" && timingSafeEqual(digest(given), digest(want));

const roomStatus_ = new Map<string, RoomStatus>();
/** Per-room last_in / last_out / last_error (epoch ms, in memory) for the settings screen. */
export const roomStatus = (): Record<string, RoomStatus> => Object.fromEntries([...roomStatus_].map(([k, v]) => [k, { ...v }]));
const mark = (id: string, patch: RoomStatus) => void roomStatus_.set(id, { ...roomStatus_.get(id), ...patch });

const targetOf = (r: JandiRoom): string | undefined => (r.kind === "main" ? "main" : r.kind === "project" ? r.project : r.kind);

// Progress edits (update_key) cannot be edited in place on JANDI; only a lane's final [ask]/[done]/[fail] line or a decision with options goes through.
const isFinal = (m: OutMsg) => !!m.options?.length || /^\s*\[(ask|done|fail)\]/m.test(m.text);

export function splitText(text: string, max = MAX_PART): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = max;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	parts.push(rest);
	return parts;
}

const errText = (e: unknown) => String((e as { code?: unknown })?.code ?? (e as Error)?.name ?? "error");

/** This computer's first non-internal IPv4 address: what JANDI's server must call. */
export function lanIp(): string {
	for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
	return "127.0.0.1";
}

const HELP = [
	"방은 dotz가 웹 앱의 대화(메인, 프로젝트, 알림, 작업내역)대로 알아서 만들고 맞춰 둬요",
	"JANDI 커넥트에서 '수신 웹훅(Incoming Webhook)'을 만들어 그 URL을 '기본 수신 웹훅 URL'에 붙여 넣으면 모든 방의 메시지가 그 방으로 가요",
	"허용 목록에 말을 걸 수 있는 사람의 이메일이나 이름을 넣어요. 목록에 없는 사람의 말은 무시해요",
];
const WEBHOOK_HINT = "남은 일: JANDI는 웹훅을 API로 만들 수 없어서, 수신 웹훅 URL 하나를 '기본 수신 웹훅 URL'에 한 번 붙여 넣어요";
const LISTEN_HINT = "바꾸면 JANDI 연결이 다시 시작돼요. 0.0.0.0은 같은 네트워크의 다른 기기도 접근할 수 있어요";
const roomErr = (id: string, msg: string) => new SettingsError(`${id}: ${msg}`);
const newRoomId = (taken: Set<string>): string => {
	for (;;) {
		const id = `r${randomBytes(4).toString("hex")}`;
		if (!taken.has(id)) return id;
	}
};
const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

export type JandiAdapter = Adapter & { port(): number | undefined };

export function createJandiAdapter(dataDir: string = DATA_DIR): JandiAdapter {
	let server: ReturnType<typeof Bun.serve> | undefined;
	let selfChat: SelfChat | undefined;
	let ctx: MessengerCtx | undefined;
	const a: JandiAdapter = {
		id: "jandi",
		label: "JANDI",
		canEdit: false,
		canButtons: false,
		status: { state: "off" } as AdapterStatus,
		enabled: () => {
			const c = loadJandiConfig(dataDir);
			return c.enabled && c.rooms.length > 0;
		},
		port: () => server?.port,
		start(c) {
			ctx = c;
			const cfg = loadJandiConfig(dataDir);
			if (!a.enabled()) {
				a.status = { state: "off" };
				return;
			}
			try {
				server = Bun.serve({ hostname: cfg.listen.host, port: cfg.listen.port, maxRequestBodySize: 256 * 1024, fetch: req => handle(req) });
				a.status = { state: "ok" };
				c.log(`jandi listening on ${cfg.listen.host}:${server.port}`);
			} catch (e) {
				a.status = { state: "error", error: `${cfg.listen.host}:${cfg.listen.port} ${(e as Error).message}` };
			}
			const sc = cfg.self_chat;
			if (sc?.enabled && sc.team_id && sc.room_id && sc.member_id && sc.bot_id) {
				selfChat = createSelfChat(sc, {
					dataDir,
					receive: text => {
						mark("self_chat", { last_in: Date.now() });
						ctx?.receive({ adapter: "jandi", target: "main", text, author: `jandi:${sc.member_id}` });
					},
					log: c.log,
					onError: err => mark("self_chat", { last_error: err }),
				});
				void selfChat.run();
			}
		},
		stop() {
			selfChat?.stop();
			selfChat = undefined;
			server?.stop(true);
			server = undefined;
			a.status = { state: "off" };
		},
		deliver: msg => deliver(msg),
		settings: () => settings(),
		saveSettings: body => {
			apply(body);
			return settings();
		},
		test: () => test(),
		syncRooms: d => syncRooms(d),
	};

	/** Makes a room for each desired one that has none (a fresh inbound token, no webhook yet) and drops project rooms whose project is gone and that hold nothing the owner entered. */
	async function syncRooms(desired: DesiredRoom[]): Promise<void> {
		const cfg = loadJandiConfig(dataDir);
		if (!cfg.enabled) return;
		const live = new Set(desired.filter(d => d.project).map(d => d.project));
		const rooms = cfg.rooms.filter(r => !(r.kind === "project" && r.project && !live.has(r.project) && !r.incoming_url));
		const taken = new Set(rooms.map(r => r.id));
		for (const d of desired) {
			if (rooms.some(r => sameRoom(r, d))) continue;
			const id = newRoomId(taken);
			taken.add(id);
			rooms.push({ id, name: d.name, kind: d.kind, ...(d.project ? { project: d.project } : {}), outgoing_token: randomBytes(16).toString("hex"), incoming_url: "" });
		}
		if (rooms.length !== cfg.rooms.length || rooms.some((r, i) => r !== cfg.rooms[i])) saveJandiConfig({ ...cfg, rooms }, dataDir);
	}

	/** The screen's view of the config: secrets only as set/unset, each room with the webhook URL JANDI's server must call. */
	function settings(): Settings {
		const cfg = loadJandiConfig(dataDir);
		const base = `http://${lanIp()}:${server?.port ?? cfg.listen.port}`;
		const status = roomStatus();
		return {
			enabled: cfg.enabled,
			help: HELP,
			fields: [
				{ key: "host", label: "받는 주소", type: "text", value: cfg.listen.host, hint: LISTEN_HINT },
				{ key: "port", label: "받는 포트", type: "number", value: cfg.listen.port, hint: "0이면 빈 포트를 골라요" },
				{ key: "incoming_url", label: "기본 수신 웹훅 URL", type: "secret", set: !!cfg.incoming_url, hint: "방마다 따로 정하지 않은 방의 메시지가 모두 이 JANDI 방으로 가요" },
			],
			allow: { label: "말을 걸 수 있는 사람", hint: "이메일이나 JANDI 이름", items: [...cfg.allow_emails, ...(cfg.allow_names ?? [])] },
			rooms: {
				label: "방",
				editable: true,
				...(cfg.rooms.length && !cfg.incoming_url && cfg.rooms.some(r => !r.incoming_url) ? { hint: WEBHOOK_HINT } : {}),
				fields: [
					{ key: "webhook", label: "발신 웹훅 URL", type: "copy", hint: "JANDI 발신 웹훅의 URL에 넣어요" },
					{ key: "outgoing_token", label: "발신 토큰", type: "secret", hint: "JANDI 발신 웹훅의 토큰과 같게" },
					{ key: "incoming_url", label: "수신 웹훅 URL", type: "secret", hint: "JANDI 수신 웹훅의 URL" },
				],
				items: cfg.rooms.map(r => ({
					id: r.id,
					name: r.name,
					kind: r.kind,
					...(r.project ? { project: { target: r.project, name: r.project } } : {}),
					values: { webhook: `${base}/jandi/${r.id}` },
					set: { outgoing_token: r.outgoing_token !== "", incoming_url: r.incoming_url !== "" },
					...status[r.id],
				})),
			},
			projects: [],
		};
	}

	/** Validates the whole body first, then writes once: a refused body changes nothing. */
	function apply(body: SettingsPut): void {
		const cfg = loadJandiConfig(dataDir);
		const next: JandiConfig = { ...cfg, listen: { ...cfg.listen }, rooms: cfg.rooms.map(r => ({ ...r })) };
		if (body.enabled !== undefined) {
			if (typeof body.enabled !== "boolean") throw new SettingsError("enabled must be true or false");
			next.enabled = body.enabled;
		}
		const v = body.values;
		if (v?.host !== undefined) {
			if (typeof v.host !== "string" || !v.host.trim()) throw new SettingsError("host must be a non-empty string");
			next.listen.host = v.host.trim();
		}
		if (v?.port !== undefined) {
			const port = typeof v.port === "string" && v.port.trim() !== "" ? Number(v.port) : v.port;
			if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) throw new SettingsError("port must be a whole number from 0 to 65535");
			next.listen.port = port;
		}
		if (v?.incoming_url !== undefined) {
			if (typeof v.incoming_url !== "string") throw new SettingsError("incoming_url must be a string");
			const url = v.incoming_url.trim();
			if (url && !isHttpUrl(url)) throw new SettingsError("incoming_url must be an http(s) URL");
			if (url) next.incoming_url = url;
			else delete next.incoming_url;
		}
		if (body.allow !== undefined) {
			if (!Array.isArray(body.allow) || body.allow.some(x => typeof x !== "string")) throw new SettingsError("allow must be a list of strings");
			const items = strings(body.allow);
			next.allow_emails = items.filter(s => s.includes("@")).map(s => s.toLowerCase());
			const names = items.filter(s => !s.includes("@"));
			if (names.length) next.allow_names = names;
			else delete next.allow_names;
		}
		if (body.rooms !== undefined) {
			if (!Array.isArray(body.rooms)) throw new SettingsError("rooms must be a list");
			const old = new Map(cfg.rooms.map(r => [r.id, r]));
			const taken = new Set<string>([...old.keys(), ...body.rooms.map(r => r?.id).filter((x): x is string => typeof x === "string")]);
			const seen = new Set<string>();
			const rooms: JandiRoom[] = [];
			for (const r of body.rooms) {
				if (!r || typeof r !== "object") throw new SettingsError("each room must be an object");
				if (r.id !== undefined && (typeof r.id !== "string" || !ROOM_ID.test(r.id))) throw new SettingsError("room id must be letters, digits, _ or -");
				const id = r.id ?? newRoomId(taken);
				taken.add(id);
				if (seen.has(id)) throw roomErr(id, "duplicate room id");
				seen.add(id);
				const was = old.get(id);
				const kind = r.kind ?? was?.kind;
				if (typeof kind !== "string" || !KINDS.includes(kind)) throw roomErr(id, "kind must be main, project, alert or worklog");
				if (r.name !== undefined && typeof r.name !== "string") throw roomErr(id, "name must be a string");
				const project = kind === "project" ? (r.project !== undefined ? r.project : was?.project) : undefined;
				if (kind === "project" && (typeof project !== "string" || !project.trim())) throw roomErr(id, "a project room needs a project");
				const secret = (key: "outgoing_token" | "incoming_url"): string => {
					const given = r.values?.[key];
					if (given === undefined) return was?.[key] ?? "";
					if (typeof given !== "string") throw roomErr(id, `${key} must be a string`);
					return given.trim();
				};
				const incoming_url = secret("incoming_url");
				if (incoming_url && !isHttpUrl(incoming_url)) throw roomErr(id, "incoming_url must be an http(s) URL");
				rooms.push({
					id,
					name: (r.name ?? was?.name ?? "").trim() || id,
					kind: kind as RoomKind,
					...(typeof project === "string" && project.trim() ? { project: project.trim() } : {}),
					outgoing_token: secret("outgoing_token"),
					incoming_url,
				});
			}
			next.rooms = rooms;
		}
		saveJandiConfig(next, dataDir);
	}

	/** One short post to every room's incoming URL; the result never carries the URL itself. */
	async function test(): Promise<TestResult> {
		const rooms = loadJandiConfig(dataDir).rooms;
		const results = await Promise.all(
			rooms.map(async room => {
				const head = { id: room.id, name: room.name };
				const url = room.incoming_url || loadJandiConfig(dataDir).incoming_url;
				if (!url) return { ...head, ok: false, error: "no incoming url" };
				try {
					const res = await fetch(url, {
						method: "POST",
						headers: { Accept: "application/vnd.tosslab.jandi-v2+json", "Content-Type": "application/json" },
						body: JSON.stringify({ body: "dotz 연결 테스트예요" }),
						signal: AbortSignal.timeout(10_000),
					});
					void res.body?.cancel();
					if (!res.ok) {
						mark(room.id, { last_error: `HTTP ${res.status}` });
						return { ...head, ok: false, status: res.status, error: `HTTP ${res.status}` };
					}
					mark(room.id, { last_out: Date.now() });
					return { ...head, ok: true, status: res.status };
				} catch (e) {
					mark(room.id, { last_error: errText(e) });
					return { ...head, ok: false, error: errText(e) };
				}
			}),
		);
		return { results };
	}

	async function handle(req: Request): Promise<Response> {
		const m = /^\/jandi\/([^/]+)$/.exec(new URL(req.url).pathname);
		if (!m) return new Response(null, { status: 404 });
		if (req.method !== "POST") return new Response(null, { status: 405 });
		const cfg = loadJandiConfig(dataDir);
		const room = cfg.rooms.find(r => r.id === m[1]);
		if (!room) return new Response(null, { status: 404 });
		let p: Record<string, any>;
		try {
			const j = await req.json();
			if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
			p = j;
		} catch {
			return new Response(null, { status: 400 });
		}
		if (!sameToken(p.token, room.outgoing_token)) {
			mark(room.id, { last_error: "401 token" });
			return new Response(null, { status: 401 });
		}
		const email = String(p.writerEmail ?? p.writer?.email ?? "").trim().toLowerCase();
		const name = String(p.writerName ?? p.writer?.name ?? "").trim();
		const allowed = email ? cfg.allow_emails.includes(email) : !!name && !!cfg.allow_names?.includes(name);
		if (!allowed) {
			mark(room.id, { last_error: "403 sender" });
			return new Response(null, { status: 403 });
		}
		const text = String(p.data ?? p.text ?? "").trim();
		const target = targetOf(room);
		mark(room.id, { last_in: Date.now() });
		if (text && target) ctx?.receive({ adapter: "jandi", target, text, author: email || name });
		return Response.json(RECEIPT);
	}

	async function post(room: JandiRoom, url: string, payload: unknown): Promise<void> {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { Accept: "application/vnd.tosslab.jandi-v2+json", "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			void res.body?.cancel();
			mark(room.id, { last_out: Date.now() });
		} catch (e) {
			// Never the message itself: a fetch error can carry the incoming URL.
			const err = (e as Error).message?.startsWith("HTTP ") ? (e as Error).message : errText(e);
			mark(room.id, { last_error: err });
			throw new Error(`${room.id}: ${err}`);
		}
	}

	async function deliver(msg: OutMsg): Promise<DeliverResult> {
		if (msg.updateKey && !isFinal(msg)) return { delivered: false, reason: "edit" };
		const cfg = loadJandiConfig(dataDir);
		const ready = cfg.rooms.map(room => ({ room, url: room.incoming_url || cfg.incoming_url || "" })).filter(r => r.url);
		let dests = ready.filter(r => r.room.kind === msg.kind && (msg.kind !== "project" || r.room.project === msg.target));
		// A project with no room of its own talks in the main room.
		if (!dests.length && msg.kind === "project") dests = ready.filter(r => r.room.kind === "main");
		dests = dests.filter((d, i) => dests.findIndex(x => x.url === d.url) === i);
		if (!dests.length) return { delivered: false, reason: "no room" };
		const parts = splitText(msg.text);
		const ask = msg.options?.length ? { title: "선택지", description: msg.options.map(o => `${o.n}) ${o.label}`).join("\n") } : undefined;
		const color = ask ? "#FAC11B" : msg.kind === "alert" ? "#E5484D" : undefined;
		let failed: unknown;
		let ok = 0;
		for (const { room, url } of dests) {
			try {
				for (const [i, part] of parts.entries()) {
					const last = i === parts.length - 1;
					await post(room, url, { body: last && ask ? `${part}\n\n${ASK_HINT}` : part, ...(color ? { connectColor: color } : {}), ...(last && (ask || msg.link) ? { connectInfo: [...(ask ? [ask] : []), ...(msg.link ? [{ title: "웹에서 보기", description: msg.link }] : [])] } : {}) });
				}
				ok++;
			} catch (e) {
				failed = e;
			}
		}
		if (!ok) throw failed;
		return { delivered: true };
	}

	return a;
}

export const jandiAdapter = createJandiAdapter();
