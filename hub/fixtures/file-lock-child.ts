import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lock } from "../file-lock.ts";

const [dir = "", rounds = "0"] = process.argv.slice(2);
const counter = join(dir, "counter");
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let r = 0; r < Number(rounds); r++) {
	const go = join(dir, `go-${r}`);
	while (!existsSync(go)) pause(0.05);
	let took = 0;
	try {
		const release = lock(counter, { budgetMs: 0, what: "test" });
		try {
			const n = Number(readFileSync(counter, "utf8"));
			pause(5);
			writeFileSync(counter, String(n + 1));
			took = 1;
		} finally {
			release();
		}
	} catch (e) {
		if (!String((e as Error).message).includes("잠겨 있어요")) throw e;
	}
	console.log(took);
}
