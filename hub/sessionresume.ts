// The orchestrator and conversation sessions get what lanes get (hub/laneresume.ts): a restart, a crash or a kill that cut a background
// worker or a running turn brings the session back with a note, whichever conversation it serves and with nobody watching the web app.
// bgwork.ts's handover only runs while /api/state is read, and a parked session has no process to read anything; the wait check needs
// an open owner request. The evidence is the lanes' (interruptedWork) and so are the bounds (3 wakes, 5/10/20 minutes, then one owner
// message), kept in one small file because main has no lane.json and a crash loop must not reset them. Compared with OmO's records
// (2026-11-06): its interrupted_run, stalled and no_wake mean the run ended unanswered, `question` an open ask, cause "aborted" the owner's stop.
// No model call unless a session is really woken. Reads stop at the file's age for sessions that sat down days ago.
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeAtomic } from "./config.ts";
import { msg } from "./i18n.ts";
import { interruptedWork, RESTART_WAKE_MAX, saysClosed, takeWake, type Unfinished, wakeStepOf, type Wakes, withWorkers } from "./laneunfinished.ts";
import { lastAnswerText, ownerAsked } from "./todo.ts";

export type DeadWorker = { id: string; description: string; target?: string; reply_to?: string };
export type ResumeSession = {
	key: string;
	target: string;
	file: () => string | undefined;
	live: () => boolean;
	/** Nothing runs, is held or is paused, and the owner did not stop it. */
	resting: () => boolean;
	dead: () => DeadWorker[];
	/** A decision card waits on the owner in this conversation. */
	asked: () => boolean;
	/** The failed-worker handover already brought this worker up. */
	taken: (id: string) => boolean;
	/** Why it cannot start now; undefined when it may (a live one needs no room). */
	full: () => string | undefined;
	wake: (note: string, to: { target: string; replyTo?: string }, ids: string[]) => void;
	tell: (text: string) => void;
};
type Memo = Wakes & { told?: string[]; at?: number };
type Deps = { sessions: () => ResumeSession[]; file: string; log: (line: string) => void };

// One count per session, whatever the wake was for: a crash loop changes its workers on every round and must still reach the bound.
const PLAN = "session";
const QUESTION_END = /[?？]\s*$/u;

export function createSessionResume(d: Deps) {
	const load = (): Record<string, Memo> => {
		if (!existsSync(d.file)) return {};
		try {
			return JSON.parse(readFileSync(d.file, "utf8"));
		} catch (e) {
			d.log(`session resume: ${d.file} unreadable, bounds start over: ${(e as Error).message}`);
			return {};
		}
	};
	const memo = load();
	const waiting = new Set<string>();
	const save = () => writeAtomic(d.file, `${JSON.stringify(memo)}\n`);
	// The episode is over; which workers were named is kept until their records age out with the session.
	const settle = (key: string) => {
		const m = memo[key];
		if (!m?.count) return;
		memo[key] = { plan: PLAN, count: 0, ...(m.told ? { told: m.told, at: m.at } : {}) };
		save();
	};
	const onOwner = (s: ResumeSession, file: string): boolean => {
		if (s.asked() || ownerAsked(file)) return true;
		const said = lastAnswerText(file);
		return saysClosed(said) || QUESTION_END.test(said);
	};
	function bring(s: ResumeSession, work: Unfinished, dead: DeadWorker[], now: number): boolean {
		const { wakes, count } = takeWake(memo[s.key], PLAN, now);
		memo[s.key] = { ...wakes, told: [...new Set([...(memo[s.key]?.told ?? []), ...dead.map(w => w.id)])], at: now };
		save();
		if (count === RESTART_WAKE_MAX) {
			d.log(`session ${s.key} left alone: ${count} automatic resumes did not close what was cut`);
			s.tell(msg().sessionRestartStuck(count));
			return false;
		}
		const w = dead.find(x => x.target);
		s.wake(withWorkers(msg().laneResumeContinue(work.open, work.current ?? ""), work.workers), { target: w?.target ?? s.target, ...(w?.reply_to ? { replyTo: w.reply_to } : {}) }, dead.map(x => x.id));
		d.log(`session ${s.key} resumed by the sweep (${wakes.count} of this episode)`);
		return true;
	}
	// A dead record can stay open under a session that took it up: a worker is named until a turn ran after the wake that named it, then never
	// again. One the handover brought up counts the same.
	function owed(s: ResumeSession, file: string): DeadWorker[] {
		const m = memo[s.key];
		const ran = m?.at !== undefined && statSync(file).mtimeMs > m.at;
		return s.dead().filter(w => (m?.told?.includes(w.id) ? !ran : !s.taken(w.id)));
	}

	/** One pass; the keys of the sessions it woke. `gate` holds a wake for the budget (or a gateway going down). */
	async function tick(gate: (name: string) => Promise<boolean> = async () => false, now = Date.now()): Promise<string[]> {
		const woken: string[] = [];
		for (const s of d.sessions()) {
			const file = s.file();
			if (!file || !s.resting()) continue;
			let dead: DeadWorker[] = [];
			const work = interruptedWork(file, s.live(), () => (dead = owed(s, file)).map(w => w.description), now);
			if (!work) {
				settle(s.key);
				continue;
			}
			if (wakeStepOf(memo[s.key], PLAN, now) !== "wake") continue;
			if (onOwner(s, file)) {
				settle(s.key);
				continue;
			}
			const full = s.full();
			if (full) {
				if (!waiting.has(s.key)) d.log(`session ${s.key} resume waits: ${full}`);
				waiting.add(s.key);
				continue;
			}
			waiting.delete(s.key);
			if ((await gate(s.key)) || !s.resting()) continue;
			try {
				if (bring(s, work, dead, now)) woken.push(s.key);
			} catch (e) {
				d.log(`session ${s.key} resume failed: ${(e as Error).message}`);
			}
		}
		return woken;
	}
	return { tick };
}
