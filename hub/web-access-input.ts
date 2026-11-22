import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../firstrun/atomic.ts";

export const webAccessInputPath = (dir: string): string => join(dir, "onboarding", "web-access-input.json");

/** Stores the hostname a setup or a POST /api/web-access/onboard body chose, for the web-access flow's hostname step. Never a secret. */
export function saveWebAccessInput(dir: string, input: { hostname?: string }): void {
	mkdirSync(join(dir, "onboarding"), { recursive: true, mode: 0o700 });
	writeAtomic(webAccessInputPath(dir), `${JSON.stringify(input)}\n`, 0o600);
	chmodSync(webAccessInputPath(dir), 0o600);
}
