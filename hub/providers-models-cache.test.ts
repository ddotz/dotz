// The model catalog is a child process (`omo --list-models`: ~0.5 s CPU, ~280 MB peak RSS, measured 2026-10-26). Every open page asks
// /api/models each minute and 구성 asks /api/harness every 15 s, so a 20 s cache started that process on nearly every poll. The list now
// stays until a login changes (auth.json), the runtime binary changes (an update) or 10 minutes pass, and concurrent asks share one process.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { availableModels } from "./providers.ts";
import { clock } from "./runtime/test-clock.ts";

const BARE = "provider  model  context  max-out  thinking  images\nanthropic-subscription  claude-opus-5-5  1M  128K  yes  yes\n";
const row = (id: string) => `anthropic-subscription  ${id}  1M  128K  yes  yes\n`;
// OmO lists the Mythos models here, so dotz has none to add to models.json (the last test lists without them).
let TABLE = BARE + ["claude-mythos-5", "claude-mythos-5-1", "claude-mythos-5-2"].map(row).join("");
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

test("a model added to the agent's models.json is listed at the next ask, not 10 minutes later", async () => {
	const models = join(dirname(auth), "models.json");
	writeFileSync(models, JSON.stringify({ providers: {} }));
	utimesSync(models, ++stamp, ++stamp);
	await availableModels();
	spawns = 0;
	clock.now += 1000;
	await availableModels();
	expect(spawns).toBe(0);
	utimesSync(models, ++stamp, ++stamp);
	await availableModels();
	expect(spawns).toBeGreaterThan(0);
});

test("the Mythos models OmO's Claude login lacks are written to models.json and the next ask reads the list again", async () => {
	const models = join(dirname(auth), "models.json");
	rmSync(models, { force: true });
	TABLE = BARE;
	login();
	await availableModels();
	const ids = JSON.parse(readFileSync(models, "utf8")).providers["anthropic-subscription"].models.map((m: { id: string }) => m.id);
	expect(ids).toEqual(["claude-mythos-5", "claude-mythos-5-1", "claude-mythos-5-2"]);
	TABLE = BARE + ids.map(row).join("");
	spawns = 0;
	clock.now += 1000;
	const listed = await availableModels();
	expect(spawns).toBeGreaterThan(0);
	expect(listed.map(m => m.selector)).toContain("anthropic/claude-mythos-5-2");
	spawns = 0;
	clock.now += 1000;
	await availableModels();
	expect(spawns).toBe(0);
});
