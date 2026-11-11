// What the gateway adds to a prompt for the model (the work-channel list first of all) reaches no screen: every payload that carries
// prompt-derived text is checked against the fixture channel's id and name. The model still gets the full prompt. All names below are made up.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptPage } from "./activity.ts";
import * as discord from "./discord.ts";
import { isGatewayNote, ownerView } from "./gateway-added.ts";
import { CATALOGS } from "./i18n.ts";
import { inboxText } from "./intake.ts";
import { extractPairs, type RawLine } from "./recall-extract.ts";
import { eventsFromFrame } from "./runtime/omp.ts";

const ID = "1500000000000000077";
const NAME = "fixture-room";
const OWNER = "배포는 내일로 미뤄 주세요";
discord.channels.work[ID] = NAME;

const prompt = () => inboxText({ kind: "message", source: "web", channel: "web", mid: "m-1", author: "owner", text: OWNER });
const leaks = (s: string) => s.includes(`ch:${ID}`) || s.includes(NAME);

test("the model's prompt holds the channel list and the owner's words", () => {
	const p = prompt();
	expect(p).toContain(`ch:${ID}`);
	expect(p).toContain(NAME);
	expect(p).toContain(OWNER);
});

test("ownerView keeps the owner's words and drops the channel list, in every catalog", () => {
	expect(ownerView(prompt())).toBe(OWNER);
	for (const [code, c] of Object.entries(CATALOGS)) {
		const text = `[dotz inbox] web msg=m-1 from owner\n${OWNER}\n${c.workChannels([`#${NAME} ch:${ID}`])}\n${c.replyIn("X", false)}`;
		expect(ownerView(text), code).toBe(OWNER);
	}
});

test("a prompt that is only a gateway message shows nothing", () => {
	expect(ownerView(`${CATALOGS.en.youAre} the orchestrator.\n${CATALOGS.en.workChannels([`#${NAME} ch:${ID}`])}`)).toBe("");
});

test("the live activity row of a user turn has no channel list", () => {
	const events = eventsFromFrame({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt() }] } }, new Map());
	const rows = events.flatMap(e => (e.type === "activity" ? [e.row.text] : []));
	expect(rows).toEqual([`> ${OWNER}`]);
});

test("the saved-transcript activity page has no channel list", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "dotz-gw-")), "s.jsonl");
	writeFileSync(file, JSON.stringify({ type: "message", timestamp: "2026-11-10T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: prompt() }] } }));
	const page = await transcriptPage(file, 10);
	expect(page.items.map(i => i.text)).toEqual([`> ${OWNER}`]);
	expect(page.items.some(i => leaks(i.text))).toBe(false);
});

test("recall keeps the owner's words and not the channel list", () => {
	const text = JSON.stringify({ type: "message", id: "e1", timestamp: "2026-11-10T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: prompt() }] } });
	const raw: RawLine[] = [{ text, line: 2, offset: 0 }];
	const pairs = [...extractPairs(raw, { file: "/data/s.jsonl", cwd: "/home/x/.dotz", session: "s", title: "", convKey: "alert", afterBrief: false, ownerCap: 2000, answerCap: 3000 })];
	expect(pairs.map(p => p.owner)).toEqual([OWNER]);
});

// A whole orchestrator prompt the way the gateway and the extension build it: parts 1-8 around the owner's own message.
const OWN = ["첫 줄이에요", "둘째 줄이에요", "셋째 줄이에요"];
const ATTACH = "[attachment] fixture.png";
const GUARD = "[orchestrator-guard] fixture-guard-marker";
const CONTRACT = "[dotz] fixture-contract-marker\n\nfixture contract line one\nfixture contract line two";
const owned = [...OWN, ATTACH].join("\n");
const full = (code: keyof typeof CATALOGS, opts: { notes?: boolean; guard?: boolean; contract?: boolean; purpose?: string } = {}): string => {
	const c = CATALOGS[code];
	const { notes = true, guard = true, contract = true, purpose = "fixture purpose" } = opts;
	return [
		`${c.nowRunning} fixture-lane`,
		`${c.replayLead}. fixture preface\n`,
		"[dotz inbox] web msg=m-1 from owner",
		owned,
		...(notes ? [c.workChannels([`#${NAME} ch:${ID} (${purpose})`]), c.replyIn("X", false), "", c.retainNudge] : []),
		...(guard ? ["", GUARD, "", "[orchestrator-guard] fixture second guard marker"] : []),
		...(contract ? ["", CONTRACT] : []),
	].join("\n");
};
const hidden = (s: string) => !leaks(s) && !s.includes("fixture-guard-marker") && !s.includes("fixture-contract-marker") && !s.includes("fixture preface") && !s.includes("fixture-lane");

for (const code of Object.keys(CATALOGS) as (keyof typeof CATALOGS)[])
	test(`ownerView of a full prompt keeps only the owner's lines (${code})`, () => {
		expect(ownerView(full(code))).toBe(owned);
	});

test("a prompt whose only trailing part is a guard paragraph is cut there", () => {
	expect(ownerView(full("en", { notes: false, contract: false }))).toBe(owned);
});

test("a work-channel note that spans two lines leaves nothing of itself", () => {
	for (const code of Object.keys(CATALOGS) as (keyof typeof CATALOGS)[]) {
		const text = full(code, { guard: false, contract: false, purpose: "fixture first\nfixture second" });
		expect(text).toContain("fixture second");
		expect(ownerView(text), code).toBe(owned);
	}
});

test("a parenthesised sentence and a bracket line that is no gateway tag stay in the owner's message", () => {
	const mine = "(이건 제 생각이에요.)\n[1] first point\n[2] second point";
	const text = `[dotz inbox] web msg=m-1 from owner\n${mine}\n${CATALOGS.en.workChannels([`#${NAME} ch:${ID}`])}\n\n${GUARD}`;
	expect(ownerView(text)).toBe(mine);
});

test("the memory nudge line counts as a gateway note", () => {
	for (const c of Object.values(CATALOGS)) expect(isGatewayNote(c.retainNudge)).toBe(true);
});

test("activity rows made from a full prompt hold no gateway-added part", async () => {
	const p = full("ko");
	const events = eventsFromFrame({ type: "message_end", message: { role: "user", content: [{ type: "text", text: p }] } }, new Map());
	const rows = events.flatMap(e => (e.type === "activity" ? [e.row.text] : []));
	expect(rows).toEqual([`> ${owned}`]);
	const file = join(mkdtempSync(join(tmpdir(), "dotz-gw-")), "s.jsonl");
	writeFileSync(file, JSON.stringify({ type: "message", timestamp: "2026-11-10T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: p }] } }));
	const page = await transcriptPage(file, 10);
	expect(page.items.map(i => i.text)).toEqual([`> ${owned}`]);
	expect(rows.concat(page.items.map(i => i.text)).every(hidden)).toBe(true);
});
