// The model catalog is a child process (`omo --list-models`: ~0.5 s CPU, ~280 MB peak RSS, measured 2026-10-26). Every open page asks
// /api/models each minute and 구성 asks /api/harness every 15 s, so a 20 s cache started that process on nearly every poll. The list now
// stays until a login changes (auth.json), the runtime binary changes (an update) or 10 minutes pass, and concurrent asks share one process.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { availableModels } from "./providers.ts";
import { clock } from "./runtime/test-clock.ts";

const TABLE = "provider  model  context  max-out  thinking  images\nanthropic-subscription  claude-opus-5-5  1M  128K  yes  yes\n";
const OMP_JSON = JSON.stringify({ models: [{ kind: "chat", selector: "anthropic/claude-opus-5-5", provider: "anthropic", reasoning: true }] });
let spawns = 0;
const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
	spawns++;
	const text = argv.includes("--list-models") ? TABLE : OMP_JSON;
	return { stdout: new Response(text).body, exited: Promise.resolve(0), kill() {} };
}) as unknown as typeof Bun.spawn);
afterAll(() => spy.mockRestore());

const auth = authFile();
mkdirSync(dirname(auth), { recursive: true });
writeFileSync(auth, JSON.stringify({ "anthropic-subscription": { type: "oauth" } }));
let stamp = 1_700_000_000;
const login = () => utimesSync(auth, ++stamp, ++stamp);

test("a page asking every minute starts the model list process once", async () => {
	login();
	await availableModels();
	spawns = 0;
	clock.now += 60_000;
	await availableModels();
	clock.now += 60_000;
	await availableModels();
	expect(spawns).toBe(0);
});

test("pages asking at the same moment share one process", async () => {
	clock.now += 11 * 60_000;
	spawns = 0;
	const lists = await Promise.all([availableModels(), availableModels(), availableModels()]);
	expect(lists[0]).toEqual(lists[2]);
	expect(spawns).toBeLessThanOrEqual(2); // one per runtime in use (OmO and/or omp), not one per page
	const once = spawns;
	spawns = 0;
	await Promise.all([availableModels(), availableModels()]);
	expect(spawns).toBe(0);
	expect(once).toBeGreaterThan(0);
});

test("a changed login (auth.json) is listed at the next ask, not 10 minutes later", async () => {
	await availableModels();
	spawns = 0;
	clock.now += 1000;
	login();
	await availableModels();
	expect(spawns).toBeGreaterThan(0);
});
