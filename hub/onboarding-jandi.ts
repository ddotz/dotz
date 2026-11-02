import { type JandiConfig, loadJandiConfig, saveJandiConfig } from "./messenger-jandi.ts";
import type { OnboardFlow, OnboardFlowContext, OnboardOwnerStep } from "./onboarding.ts";

export type JandiStore = { load(): JandiConfig; save(cfg: JandiConfig): JandiConfig };

export function createJandiStore(dir: string): JandiStore {
	return {
		load: () => loadJandiConfig(dir),
		save: cfg => saveJandiConfig(cfg, dir),
	};
}

const KINDS = new Set(["main", "project", "alert", "worklog"]);
const LOGIN_OWNER: OnboardOwnerStep = {
	label: "JANDI 관리자 로그인",
	hint: "Aside 창에서 JANDI 관리자 계정으로 로그인하고 2단계 인증을 마친 뒤, 웹훅 화면을 열어 두고 계속을 누르세요.",
};
const WEBHOOK_OWNER: OnboardOwnerStep = {
	label: "JANDI 웹훅 확인",
	hint: "JANDI 관리자 화면에서 방의 수신 웹훅 URL과 발신 토큰을 확인한 뒤 계속을 누르세요.",
};

const ready = (cfg: JandiConfig): boolean => cfg.rooms.length > 0 && cfg.rooms.every(room => !!room.outgoing_token && !!(room.incoming_url || cfg.incoming_url));

function remember(ctx: OnboardFlowContext, cfg: JandiConfig): void {
	if (cfg.incoming_url) ctx.seen(cfg.incoming_url);
	for (const room of cfg.rooms) {
		if (room.outgoing_token) ctx.seen(room.outgoing_token);
		if (room.incoming_url) ctx.seen(room.incoming_url);
	}
}

function roomsFrom(value: string): JandiConfig["rooms"] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("JANDI 웹훅 응답을 읽지 못했어요");
	}
	const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { rooms?: unknown }).rooms) ? ((parsed as { rooms: unknown[] }).rooms) : [];
	const rooms: JandiConfig["rooms"] = [];
	for (const [i, raw] of list.entries()) {
		const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const kind = typeof r.kind === "string" && KINDS.has(r.kind) ? (r.kind as JandiConfig["rooms"][number]["kind"]) : "main";
		rooms.push({
			id: typeof r.id === "string" && r.id ? r.id : `room${i + 1}`,
			name: typeof r.name === "string" && r.name ? r.name : "JANDI 방",
			kind,
			...(typeof r.project === "string" && r.project ? { project: r.project } : {}),
			outgoing_token: typeof r.outgoing_token === "string" ? r.outgoing_token : "",
			incoming_url: typeof r.incoming_url === "string" ? r.incoming_url : "",
		});
	}
	return rooms;
}

export const jandiFlow: OnboardFlow = {
	key: "jandi",
	steps: [
		{
			id: "reuse",
			title: "저장된 JANDI 방 확인",
			detail: "messengers/jandi.json의 방과 웹훅을 먼저 씁니다.",
			owner: { label: "저장된 설정 확인", hint: "설정 → JANDI의 직접 입력에서 웹훅 값을 확인한 뒤 계속을 누르세요." },
			run: async ctx => {
				const cfg = ctx.jandi.load();
				remember(ctx, cfg);
				return { done: true };
			},
		},
		{
			id: "webhooks",
			title: "방 웹훅 맞추기",
			detail: "방에 수신 웹훅과 발신 토큰이 없으면 JANDI 관리자 화면에서 읽어 와요.",
			owner: WEBHOOK_OWNER,
			run: async ctx => {
				const cfg = ctx.jandi.load();
				remember(ctx, cfg);
				if (ready(cfg)) return { done: true };
				const got = await ctx.deps.browser.run("jandi-webhooks", { rooms: ["main", "alert", "worklog"] });
				if (got.waiting) return { waiting: LOGIN_OWNER };
				if (!got.ok) throw new Error("JANDI 관리자 화면을 열지 못했어요");
				const rooms = roomsFrom(String(got.value ?? ""));
				if (!rooms.length) throw new Error("JANDI 웹훅을 찾지 못했어요");
				for (const room of rooms) {
					ctx.seen(room.outgoing_token);
					ctx.seen(room.incoming_url);
				}
				const saved = ctx.jandi.save({ ...cfg, enabled: true, rooms });
				remember(ctx, saved);
				if (!ready(saved)) throw new Error("JANDI 웹훅이 아직 준비되지 않았어요");
				ctx.changed();
				return { done: true };
			},
		},
		{
			id: "verify",
			title: "연결 켜기",
			detail: "방마다 웹훅이 있고 JANDI 메신저가 켜져 있는지 확인해요.",
			owner: { label: "JANDI 연결 확인", hint: "JANDI 관리자 화면에서 웹훅을 확인하고 계속을 누르세요." },
			run: async ctx => {
				const cfg = ctx.jandi.load();
				remember(ctx, cfg);
				if (!ready(cfg)) throw new Error("JANDI 방의 웹훅이 아직 준비되지 않았어요");
				if (!cfg.enabled) {
					const saved = ctx.jandi.save({ ...cfg, enabled: true });
					remember(ctx, saved);
					ctx.changed();
				}
				return { done: true };
			},
		},
		{
			id: "done",
			title: "연결 완료",
			detail: "JANDI 방과 웹훅을 확인했어요.",
			owner: { label: "다시 확인", hint: "연결을 다시 시작하면 지금 상태를 다시 확인해요." },
			run: async () => ({ done: true }),
		},
	],
};
