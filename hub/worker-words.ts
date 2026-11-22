/** The words a gateway note uses for a background worker: its name and the tool call that steers it, reads its result, or cancels it, which differ by runtime. */
export type WorkerWords = { name: (id: string) => string; steer: (id: string) => string; read: (id: string) => string; cancel: (id: string) => string };

/** OmO's worker tools take the task id the hub keeps. */
export const OMO_WORDS: WorkerWords = { name: id => id, steer: () => "task_send", read: () => "task_output", cancel: () => "task_cancel" };

/** omp has no such tools: a worker is `agent://<name>` (write revives or steers it, read shows its result) and `proc://<name>/kill` cancels it. */
export const ompWords = (nameOf: (id: string) => string): WorkerWords => ({
	name: nameOf,
	steer: id => `write agent://${nameOf(id)}`,
	read: id => `read agent://${nameOf(id)}`,
	cancel: id => `write proc://${nameOf(id)}/kill`,
});

/** The name omp knows a run by, from the `<name>~<process>.<run>` id the hub keeps (runtime/omp-runs.ts RunKeys). */
export const runName = (id: string): string => id.replace(/~[0-9a-z]+\.\d+$/, "");
