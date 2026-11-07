// Recipes: work that ended well, kept for next time (docs/customization.md "Recipes"). The gateway picks at most one candidate a night from the
// sessions it already recorded and adds it to the existing reflection turn; that turn drafts the steps and posts the card. The owner's answer is
// settled here, with no model turn: only a save writes to <data>/custom/recipes, a skip is remembered, and nothing is ever run or watched.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { issueBlock } from "./choices.ts";
import { DATA_DIR, log, paths, writeAtomic } from "./config.ts";
import { recipesDir } from "./featuredirs.ts";
import { msg } from "./i18n.ts";
import { meaningWords, repeatCluster, sameComplaint } from "./reflect.ts";

const DAY = 24 * 3600_000;
const WINDOW = 7 * DAY;
// The nightly run comes back after 24h, so this only stops a second candidate within one night.
const ONE_NIGHT = 20 * 3600_000;
const CARD_OPEN = 7 * DAY;
// A candidate the turn passed over, or a card never answered, may come back after this. A skip and a save never do.
const HOLD = 30 * DAY;
// The session file is the cheap stand-in for what a session cost: a stat, no read. The heaviest tenth of finished sessions on a busy install.
export const COSTLY_SESSION_BYTES = 20_000_000;

type Draft = { slug: string; name: string; when: string; body: string; script?: { file: string; text: string } };
type Choice = { id: string; status: "offered" | "proposed" | "saved" | "skipped"; at: number; titles: string[]; lanes: string[]; draft?: Draft };
type Run = { name: string; text: string; bytes: number };

const readChoices = (): Choice[] => (existsSync(paths.recipeChoices) ? JSON.parse(readFileSync(paths.recipeChoices, "utf8")) : []);
const writeChoices = (choices: Choice[]): void => writeAtomic(paths.recipeChoices, `${JSON.stringify(choices)}\n`);

// The sessions of the last week that the gateway's own check verified. A session that only reported, failed or still runs is no proof of anything.
function verifiedRuns(now: number): Run[] {
	if (!existsSync(paths.lanes)) return [];
	return readdirSync(paths.lanes).flatMap(name => {
		const file = join(paths.lanes, name, "lane.json");
		if (!existsSync(file)) return [];
		const l = JSON.parse(readFileSync(file, "utf8"));
		const at = Date.parse(l.endedAt ?? l.lastReportAt ?? l.startedAt ?? "");
		if (l.claim?.state !== "verified" || !["exited", "idle"].includes(l.status) || !(now - at < WINDOW) || !l.title) return [];
		return [{ name, text: String(l.title), bytes: l.sessionFile && existsSync(l.sessionFile) ? statSync(l.sessionFile).size : 0 }];
	});
}

const sameShape = (a: string, b: string): boolean => a === b || sameComplaint(meaningWords(a), meaningWords(b));
const holds = (c: Choice, now: number): boolean => c.status === "saved" || c.status === "skipped" || now - c.at < HOLD;

function candidate(choices: readonly Choice[], now: number): Run[] {
	const held = choices.filter(c => holds(c, now));
	const free = verifiedRuns(now).filter(r => !held.some(c => c.lanes.includes(r.name) || c.titles.some(t => sameShape(r.text, t))));
	const repeat = repeatCluster(free);
	if (repeat.length >= 2) return repeat;
	const costly = free.filter(r => r.bytes >= COSTLY_SESSION_BYTES).toSorted((a, b) => b.bytes - a.bytes)[0];
	return costly ? [costly] : [];
}

const SCRIPT = `bun ${join(import.meta.dir, "recipes.ts")}`;
/** The part of tonight's reflection prompt about a recipe: "" when there is no candidate, or one was handed over tonight, or a card is still open. */
export function recipeBlock(now = Date.now()): string {
	try {
		const choices = readChoices();
		const busy = choices.some(c => (c.status === "offered" && now - c.at < ONE_NIGHT) || (c.status === "proposed" && now - c.at < CARD_OPEN));
		const runs = busy ? [] : candidate(choices, now);
		if (!runs.length) return "";
		const id = Bun.hash(runs.map(r => r.name).join("|")).toString(36).slice(0, 8);
		writeChoices([...choices, { id, status: "offered", at: now, titles: runs.map(r => r.text), lanes: runs.map(r => r.name) }]);
		return msg().recipeCandidate(id, runs.map(r => r.text), runs.slice(-3).map(r => join(paths.lanes, r.name, "brief.md")), SCRIPT);
	} catch (e) {
		log(`recipes: no candidate tonight: ${e}`);
		return "";
	}
}

const FILE_NAME = /^[A-Za-z0-9][\w.-]{0,59}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LINE = (max: number) => new RegExp(`^[^\\n]{1,${max}}$`);
function checkDraft(d: Draft): void {
	if (!SLUG.test(d.slug)) throw new Error(`slug must be lowercase letters, digits and dashes: ${d.slug}`);
	if (existsSync(join(recipesDir(DATA_DIR), d.slug))) throw new Error(`a recipe named ${d.slug} already exists`);
	if (!LINE(40).test(d.name) || !LINE(120).test(d.when)) throw new Error("name (40 chars) and when (120 chars) are one line each");
	if (!d.body.trim() || d.body.length > 2000) throw new Error("body is 1 to 2000 characters");
	if (d.script && (!FILE_NAME.test(d.script.file) || d.script.file.toLowerCase() === "recipe.md" || d.script.text.length > 8000)) throw new Error("script needs a plain file name and at most 8000 characters");
}

// A fence cut open by the preview would swallow the decision block after it, and with it the card's buttons.
const cardPreview = (body: string): string => body.trim().slice(0, 400).replace(/`{3,}|~{3,}/g, "");

/** The reflection turn's one proposal: keeps the draft out of the install layer until the owner answers and returns the card to post. */
export function proposeRecipe(id: string, draft: Draft, now = Date.now()): string {
	const choices = readChoices();
	const c = choices.find(x => x.id === id && x.status === "offered" && now - x.at < DAY);
	if (!c) throw new Error(`recipe candidate ${id} was not handed to tonight's reflection`);
	checkDraft(draft);
	// One open card at a time: the owner's answer names no card, so an older one closed unanswered must not take it.
	for (const old of choices) if (old.status === "proposed") Object.assign(old, { status: "offered", draft: undefined });
	Object.assign(c, { status: "proposed", at: now, draft });
	writeChoices(choices);
	const m = msg();
	return `${m.recipeCard(draft, cardPreview(draft.body), c.titles)}\n\n${issueBlock(m.recipeQuestion, m.recipeOptions)}`;
}

function store(d: Draft): string {
	const dir = join(recipesDir(DATA_DIR), d.slug);
	if (existsSync(dir)) throw new Error(`a recipe named ${d.slug} already exists`);
	mkdirSync(dir, { recursive: true });
	writeAtomic(join(dir, "recipe.md"), `---\nname: ${d.name}\nwhen: ${d.when}\n---\n${d.body.trim()}\n`);
	if (d.script) writeAtomic(join(dir, d.script.file), d.script.text, 0o755);
	return dir;
}

/** The owner's click or typed option on the open card: what the gateway answers, or undefined for any other message. */
export function recipeAnswer(text: string, now = Date.now()): string | undefined {
	const m = msg();
	const said = text.trim().replace(/^\d{1,2}\)\s*/, "");
	const [save, skip] = m.recipeOptions.map(o => o.name);
	if (said !== save && said !== skip) return undefined;
	try {
		const choices = readChoices();
		const c = choices.findLast(x => x.status === "proposed");
		if (!c?.draft) return undefined;
		const reply = said === save ? m.recipeSaved(c.draft.name, store(c.draft)) : m.recipeSkipped(c.draft.name);
		Object.assign(c, { status: said === save ? "saved" : "skipped", at: now, draft: undefined });
		writeChoices(choices);
		return reply;
	} catch (e) {
		log(`recipes: answer failed: ${e}`);
		return m.recipeFailed(String(e));
	}
}

if (import.meta.main && process.argv[2] === "propose" && process.argv[3]) {
	const { values: v } = parseArgs({ args: process.argv.slice(4), options: { slug: { type: "string" }, name: { type: "string" }, when: { type: "string" }, "body-file": { type: "string" }, "script-file": { type: "string" } } });
	if (!v.slug || !v.name || !v.when || !v["body-file"]) throw new Error("propose <id> --slug s --name n --when w --body-file f [--script-file f]");
	const script = v["script-file"];
	console.log(proposeRecipe(process.argv[3], { slug: v.slug, name: v.name, when: v.when, body: readFileSync(v["body-file"], "utf8"), ...(script ? { script: { file: script.split("/").at(-1)!, text: readFileSync(script, "utf8") } } : {}) }));
	// events.ts keeps a timer alive for the gateway, which would hold this one-shot open.
	process.exit(0);
}
