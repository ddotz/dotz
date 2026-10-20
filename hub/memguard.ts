// Memory guard: omp runs its bash tool's coreutils (grep, cat, find, ...) inside its own process, and task workers share
// that process too, so one careless command (a `grep -r` over ~/Library, a grep through a multi-GB file without newlines)
// can grow an orchestrator or lane process to tens of GB. Every CHECK_MS the RSS of each agent process is read; one
// past lanes.max_rss_gb is restarted on the same session (the kill frees the memory at once; a turn that was running is
// told why and continues). More than MAX_RESTARTS restarts of the same agent within WINDOW_MS stop the guard for it
// and alert the owner instead, so a lane that keeps re-running the same scan does not loop.
import { statusActivity } from "./activity.ts";
import { lanesMaxRssGb, log } from "./config.ts";
import { msg } from "./i18n.ts";
import { lanes, restartLane } from "./lanes.ts";
import { orch, orchestratorPid, restart as restartOrchestrator } from "./orchestrator.ts";
import { trackTimer } from "./shutdown.ts";

export const CHECK_MS = 30_000;
export const WINDOW_MS = 60 * 60_000;
export const MAX_RESTARTS = 3;

export type GuardVerdict = "ok" | "restart" | "give-up" | "gave-up";

// Pure decision for one agent: `restarts` are the times this agent was restarted by the guard, `gaveUp` whether the
// owner was already told the guard stopped for it.
export function guardVerdict(rssKb: number, limitKb: number, restarts: number[], gaveUp: boolean, now: number): GuardVerdict {
	if (rssKb <= limitKb) return "ok";
	if (gaveUp) return "gave-up";
	return restarts.filter(t => now - t < WINDOW_MS).length >= MAX_RESTARTS ? "give-up" : "restart";
}

// RSS in KB of each pid that is still alive, from one `ps` call.
async function rssOf(pids: number[]): Promise<Map<number, number>> {
	const out = new Map<number, number>();
	if (!pids.length) return out;
	const proc = Bun.spawn(["ps", "-o", "pid=,rss=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	for (const line of text.trim().split("\n")) {
		const [pid, rss] = line.trim().split(/\s+/).map(Number);
		if (pid && Number.isFinite(rss)) out.set(pid, rss!);
	}
	return out;
}

type Agent = { key: string; pid: number; busy: boolean; restart: (note: string) => Promise<void> | void };

function agents(): Agent[] {
	const list: Agent[] = [];
	const op = orchestratorPid();
	if (op && orch.status !== "rate-limited") list.push({ key: "orchestrator", pid: op, busy: orch.status === "working", restart: () => restartOrchestrator() });
	for (const lane of lanes.values()) {
		if (!lane.proc || lane.status === "rate-limited") continue;
		list.push({ key: `lane:${lane.name}`, pid: lane.proc.pid, busy: lane.status === "working" || lane.status === "starting", restart: note => restartLane(lane.name, note) });
	}
	return list;
}

const restarts = new Map<string, number[]>();
const gaveUp = new Set<string>();
let running = false;

const gb = (kb: number) => (kb / 1024 / 1024).toFixed(1);

async function check(notify: (key: string, text: string) => void): Promise<void> {
	if (running) return;
	running = true;
	try {
		const list = agents();
		const rss = await rssOf(list.map(a => a.pid));
		const limitKb = lanesMaxRssGb() * 1024 * 1024;
		for (const a of list) {
			const kb = rss.get(a.pid);
			if (kb === undefined) continue;
			const times = (restarts.get(a.key) ?? []).filter(t => Date.now() - t < WINDOW_MS);
			const verdict = guardVerdict(kb, limitKb, times, gaveUp.has(a.key), Date.now());
			if (verdict === "ok") {
				gaveUp.delete(a.key);
				continue;
			}
			if (verdict === "gave-up") continue;
			const what = `${a.key} uses ${gb(kb)} GB (limit ${lanesMaxRssGb()} GB)`;
			if (verdict === "give-up") {
				gaveUp.add(a.key);
				log(`memory guard: ${what}; restarted ${MAX_RESTARTS} times within an hour, leaving it running`);
				notify(a.key, `메모리를 ${gb(kb)}GB 쓰고 있어요(한도 ${lanesMaxRssGb()}GB). 한 시간 안에 이미 ${MAX_RESTARTS}번 재시작해서 더는 자동으로 재시작하지 않아요. 확인이 필요해요.`);
				continue;
			}
			times.push(Date.now());
			restarts.set(a.key, times);
			log(`memory guard: ${what}; restarting it on the same session${a.busy ? " (a turn was running)" : ""}`);
			statusActivity(a.key, `memory guard: ${gb(kb)} GB > ${lanesMaxRssGb()} GB, restarted`);
			notify(a.key, `메모리를 ${gb(kb)}GB 써서(한도 ${lanesMaxRssGb()}GB) 프로세스를 같은 세션으로 다시 시작했어요.${a.busy ? (a.key === "orchestrator" ? " 처리 중이던 요청은 끊겼을 수 있어요." : " 하던 작업은 이어서 해요.") : ""}`);
			await Promise.resolve(a.restart(msg().laneMemory(gb(kb), String(lanesMaxRssGb())))).catch(e => log(`memory guard: restarting ${a.key} failed: ${e}`));
		}
	} catch (e) {
		log(`memory guard check failed: ${e}`);
	} finally {
		running = false;
	}
}

export function startMemoryGuard(notify: (key: string, text: string) => void): void {
	if (lanesMaxRssGb() <= 0) return;
	const timer = setInterval(() => void check(notify), CHECK_MS);
	timer.unref();
	trackTimer("memory guard", timer);
}
