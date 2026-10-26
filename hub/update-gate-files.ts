// For the update gate runner (hub/update-gate-run.ts), kept apart so a test can import it without running the gate.
// The files whose tests failed or that errored while loading, from bun's output (a "path.test.ts:" header starts each file's block).
export function failedFiles(out: string): string[] {
	const bad = new Set<string>();
	let file = "";
	for (const line of out.split("\n")) {
		const h = /^([\w./-]+\.test\.ts):$/.exec(line.trim());
		if (h) file = h[1]!;
		else if (file && (/^\(fail\)/.test(line) || /^(\w*)?error:/i.test(line.trim()) || /^# Unhandled error/.test(line))) bad.add(file);
	}
	return [...bad];
}

