import { renameSync, writeFileSync } from "node:fs";

// The same all-or-nothing write as hub/config.ts writeAtomic, kept here because hub/config.ts reads the data dir when it loads, and setup.ts
// runs this layer before any config.json exists.
export function writeAtomic(file: string, text: string, mode?: number): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
	renameSync(tmp, file);
}
