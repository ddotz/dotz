import type { AgentEvent, SubagentUpdate } from "./types.ts";

type Run = { n: number; live: boolean; spawned: boolean };

let processes = 0;

/**
 * Gives each run of an omp worker an id of its own: `<name>~<process>.<run>`. omp calls a worker by the name the model picked and
 * uses that name again for a worker revived with `write agent://<name>` and for the same name in another session, while the hub keeps
 * state per id (the owner's 중단, the request a worker serves, its row), so one run's state must not land on the next.
 * A run starts at the spawn result or at the first running frame after the previous run ended, and a wake names the newest run.
 */
export class RunKeys {
	private readonly runs = new Map<string, Run>();
	private readonly names = new Map<string, string>();
	private readonly nonce = `${Math.floor(Date.now() / 1000).toString(36)}${(++processes).toString(36)}`;

	private run(name: string): Run {
		let run = this.runs.get(name);
		if (!run) this.runs.set(name, (run = { n: 0, live: false, spawned: false }));
		return run;
	}

	private key(name: string, run: Run): string {
		run.n ||= 1;
		const key = `${name}~${this.nonce}.${run.n}`;
		this.names.set(key, name);
		return key;
	}

	spawned(name: string): string {
		const run = this.run(name);
		if (!run.spawned) {
			if (!run.live) run.n++;
			run.spawned = true;
		}
		return this.key(name, run);
	}

	updated(name: string, status: SubagentUpdate["status"]): string {
		const run = this.run(name);
		if (status === "running") {
			if (!run.live && !run.spawned) run.n++;
			run.live = true;
		} else run.live = false;
		run.spawned = false;
		return this.key(name, run);
	}

	finished(name: string): string {
		return this.key(name, this.run(name));
	}

	/** The name omp knows a run by: what `cancel_subagent` takes. A name no run of this process has is its own name. */
	nameOf(key: string): string {
		return this.names.get(key) ?? key;
	}

	rekey(events: AgentEvent[]): AgentEvent[] {
		return events.map(ev => {
			if (ev.type === "subagent") return { ...ev, update: { ...ev.update, id: this.updated(ev.update.id, ev.update.status), name: ev.update.id } };
			if (ev.type === "workers_spawned") return { ...ev, workers: ev.workers.map(w => ({ ...w, id: this.spawned(w.id) })) };
			if (ev.type === "workers_done" || ev.type === "workers_steered") return { ...ev, ids: ev.ids.map(id => this.finished(id)) };
			return ev;
		});
	}
}
