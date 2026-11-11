// The top update bar's tap (web/js/24-settings-update.js; owner 2026-11-01: "상단 알림바 누르고 나서 설정가서 다시 업뎃하는게 번거롭네"):
// one tap runs the whole update. The existing gate downloads and tests the new version (selfupdate.ts apply), then the idle restart
// gate (restart.ts) applies it as soon as the running work is done. Nothing new starts before it ("새로운 작업이 추가되면 그 이후로"):
// from the tap until the gateway is back, every new orchestrator or conversation-session turn (owner messages, watches, schedules,
// lane reports: outbound.ts deliver) is held here, acknowledged and kept on disk, and delivered in arrival order right after the restart.
//
// Lanes keep the restart rule: a busy lane is never killed and the restart waits for it. Messages to a lane are not held (the lane is
// the owner's own session and is resumed after the restart). A lane can run for hours, so once the restart has waited
// lanesOnlyMs (the restart notice's 20 minutes) and only lanes are still busy, the held messages go in at once and holding ends; the update still applies when the
// lanes are done (restart.ts as before). A failed or refused download, or an already current checkout, releases the held messages too.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import { RESTART_NOTICE_MS } from "./restart.ts";

export type FlowPhase = "download" | "waiting" | "restarting" | "done" | "failed";
/** What the bar shows: the phase, one plain line, and when it started (`id`, so the page shows each result once). */
export type Flow = { id: string; phase: FlowPhase; text: string; at: string; from?: string; released?: boolean };
export type Reply = { target: string; replyTo?: string; owner?: boolean };
export type Held = { text: string; reply?: Reply; refs: string[]; at: string };

export type UpdateNowDeps = {
	dataDir: string;
	/** selfupdate.ts apply: download, test, move the checkout (or the folder); never restarts. */
	apply: () => Promise<{ status: string; message: string; from?: string }>;
	/** The idle restart gate (main.ts restartGateway): exits once nothing is busy. */
	restartIdle: () => string;
	/** What still holds the restart (main.ts busyNow). */
	busy: () => string[];
	/** The unheld delivery (outbound.ts deliverNow); true when the text was steered into a running turn. */
	deliver: (text: string, reply?: Reply) => boolean;
	/** A held owner message went in after all: its delivery state (hub/events.ts emitDelivery). */
	delivered?: (target: string, ref: string, steered: boolean) => void;
	/** The commit this process runs, for telling an applied update from a rolled-back one at boot. */
	current?: () => Promise<string | undefined>;
	log: (line: string) => void;
	lanesOnlyMs?: number;
	tickMs?: number;
};

const ACTIVE: FlowPhase[] = ["download", "waiting", "restarting"];
const TEXT = {
	download: "새 버전을 받고 있어요",
	waiting: "진행 중인 작업이 끝나면 바로 적용해요",
	restarting: "다시 켜는 중이에요",
	done: "업데이트를 마쳤어요",
	current: "이미 최신 버전이에요",
	interrupted: "받는 도중 게이트웨이가 다시 시작돼서 업데이트하지 못했어요. 다시 눌러 주세요.",
	rolledBack: "새 버전이 제대로 켜지지 않아 이전 버전으로 되돌렸어요",
};

export function createUpdateNow(deps: UpdateNowDeps) {
	const dir = join(deps.dataDir, "self-update");
	const flowFile = join(dir, "flow.json");
	const heldFile = join(dir, "held.json");
	const read = <T>(file: string, fallback: T): T => {
		try {
			return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
		} catch {
			return fallback;
		}
	};
	let flow: Flow | undefined = read<Flow | undefined>(flowFile, undefined);
	let held: Held[] = read<Held[]>(heldFile, []);
	let holding = false;
	let waitSince = 0;
	const write = (file: string, v: unknown) => (mkdirSync(dir, { recursive: true }), writeAtomic(file, `${JSON.stringify(v)}\n`));
	const saveFlow = () => write(flowFile, flow);
	const saveHeld = () => (held.length ? write(heldFile, held) : rmSync(heldFile, { force: true }));
	const set = (phase: FlowPhase, text: string, extra: Partial<Flow> = {}) => {
		flow = { ...(flow as Flow), ...extra, phase, text, at: phase === "download" ? new Date().toISOString() : (flow?.at ?? new Date().toISOString()) };
		saveFlow();
		deps.log(`update now: ${phase}: ${text}`);
	};

	/** Delivers every held item, oldest first, and stops holding. */
	function release(why: string): number {
		holding = false;
		const list = held;
		held = [];
		saveHeld();
		for (const h of list) {
			const steered = deps.deliver(h.text, h.reply);
			if (h.reply) for (const ref of h.refs) deps.delivered?.(h.reply.target, ref, steered);
		}
		if (list.length) deps.log(`update now: ${list.length} held message(s) delivered (${why})`);
		return list.length;
	}

	// While the restart waits: once only lanes keep it waiting past lanesOnlyMs, the held messages go in (see the header).
	const tick = () => {
		if (flow?.phase !== "waiting" || !holding) return;
		const busy = deps.busy();
		if (busy.length && busy.every(b => b.startsWith("lane ")) && Date.now() - waitSince >= (deps.lanesOnlyMs ?? RESTART_NOTICE_MS)) {
			flow.released = true;
			saveFlow();
			release(`only lanes still busy: ${busy.join(", ")}`);
			return;
		}
		setTimeout(tick, deps.tickMs ?? 5000);
	};

	/** The tap: starts the update, or returns the one already under way. */
	function start(): Flow {
		if (flow && ACTIVE.includes(flow.phase)) return flow;
		flow = { id: Date.now().toString(36), phase: "download", text: TEXT.download, at: new Date().toISOString() };
		holding = true;
		saveFlow();
		deps.log("update now: started (new turns are held until the restart)");
		void deps.apply().then(
			j => {
				if (j.status === "updated") {
					set("waiting", TEXT.waiting, j.from ? { from: j.from } : {});
					waitSince = Date.now();
					deps.log(`update now: ${deps.restartIdle()}`);
					setTimeout(tick, deps.tickMs ?? 5000);
					return;
				}
				set(j.status === "current" ? "done" : "failed", j.status === "current" ? TEXT.current : j.message);
				release(`update ${j.status}`);
			},
			e => {
				set("failed", String((e as Error)?.message ?? e));
				release("update error");
			},
		);
		return flow;
	}

	return {
		start,
		flow: () => flow,
		holding: () => holding,
		/** outbound.ts deliver: true when this delivery was held (it goes in after the restart). */
		hold(text: string, reply?: Reply, refs: string[] = []): boolean {
			if (!holding) return false;
			held.push({ text, ...(reply ? { reply } : {}), refs, at: new Date().toISOString() });
			saveHeld();
			deps.log(`update now: held a turn for ${reply?.target ?? "main"} (${held.length} held)`);
			return true;
		},
		heldCount: () => held.length,
		/** The restart gate exits now (main.ts). */
		restarting(): void {
			if (flow?.phase === "waiting") set("restarting", TEXT.restarting);
		},
		/** The next start, right after the open prompts are replayed: the held messages go in, in order, and the flow ends. */
		async boot(): Promise<number> {
			const n = release("gateway is back");
			if (flow && ACTIVE.includes(flow.phase)) {
				if (flow.phase === "download") set("failed", TEXT.interrupted);
				else {
					const sha = await deps.current?.().catch(() => undefined);
					if (sha && flow.from && sha === flow.from) set("failed", TEXT.rolledBack);
					else set("done", TEXT.done);
				}
			}
			return n;
		},
	};
}

export type UpdateNow = ReturnType<typeof createUpdateNow>;
// The instance main.ts makes; outbound.ts and intake.ts reach it here (no import of main.ts).
let active: UpdateNow | undefined;
export const setUpdateNow = (u: UpdateNow | undefined) => void (active = u);
export const updateNow = () => active;
