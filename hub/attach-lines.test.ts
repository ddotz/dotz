// A send approval a session wrote itself (its own tool sends the mail): each `> 첨부:` file needs a `[file] /absolute/path` line, or the owner's
// send sheet cannot show it. The post goes back to its author once, naming the files with no line; the same ref posted again goes out as written.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerReview } from "./answer-words.ts";
import { HUB_TOKEN, paths } from "./config.ts";
import { askedFile, askedFiles } from "./draft-attach.ts";
import { emit } from "./events.ts";
import { report } from "./lanereport.ts";
import { hooks, lanes, type Lane } from "./lanestate.ts";
import { createPrompts, type Pending, type PromptDeps, type Reply } from "./prompts.ts";
import { makeRoute } from "./routes.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-attach-lines-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const zip = join(dir, "build.zip");
const txt = join(dir, "checklist.txt");
writeFileSync(zip, "zip");
writeFileSync(txt, "list");

let seq = 0;
const nextRef = () => `8801${String(++seq).padStart(4, "0")}`;
// The card as a session writes it: two files named, `lines` below it.
const card = (ref: string, lines: string[] = [`[file] ${txt}`]) =>
	`[ask] 답장을 채워 뒀어요.\n\n> 받는이: 김 (kim@example.com)\n> 제목: RE: 파일\n> 첨부: build.zip (1KB)\n> 첨부: checklist.txt (1KB)\n> 안녕하세요.\n\n결정: 이 답장을 보낼까요? (${ref})\n**1) 보내기**\n보내요\n**2) 고치기 …**\n고쳐요\n**3) 보내지 않기**\n안 보내요\n\n${lines.join("\n")}`;
const review = answerReview(() => true);

test("a card whose [file] lines cover every named file is not returned, and the sheet's file lookup finds both", () => {
	const ref = nextRef();
	const text = card(ref, [`[file] ${zip}`, `[file] ${txt}`]);
	expect(review(text)).toBeUndefined();
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "th:1", text });
	expect(askedFiles(ref)?.map(f => f.name)).toEqual(["build.zip", "checklist.txt"]);
	expect(askedFile(ref, 1)).toBeDefined();
});

test("a card with a file named and no [file] line for it is returned once naming that file; the same ref again passes", () => {
	const ref = nextRef();
	const note = review(card(ref));
	expect(note).toContain("build.zip");
	expect(note).not.toContain("checklist.txt");
	expect(review(card(ref))).toBeUndefined();
	// Another ref is its own first time.
	expect(review(card(nextRef()))).toContain("build.zip");
});

test("a session that cannot take the note now is not asked, and is not counted as asked", () => {
	const ref = nextRef();
	expect(answerReview(() => false)(card(ref))).toBeUndefined();
	expect(review(card(ref))).toContain("build.zip");
});

function prompts() {
	const state = { working: false, delivered: [] as { text: string; owner?: boolean }[], posts: [] as string[] };
	const deps = {
		deliver: (text: string, owner?: boolean) => void state.delivered.push({ text, owner }),
		steer: () => true,
		working: () => state.working,
		keepalive: () => false,
		note: (_t: string, _r: string | undefined, text: string) => `[note] ${text}`,
		isNote: (text: string) => text.startsWith("[note]"),
		post: async (_target: string, text: string) => (state.posts.push(text), { delivered: true }),
		review,
		clearProgress: () => {},
		persist: (_open: Pending[]) => {},
		log: () => {},
	} as PromptDeps;
	const q = createPrompts(deps);
	const reply: Reply = { target: "web", replyTo: "m1", owner: true };
	q.deliver("question", reply);
	state.working = true;
	q.onPrompt("question");
	return { q, state };
}

test("a session's final answer with the card is held and the session gets the note; its answer sent again goes out as written", async () => {
	const ref = nextRef();
	const t = prompts();
	t.q.onAnswer(card(ref));
	await Promise.resolve();
	expect(t.state.posts).toEqual([]);
	const note = t.state.delivered.find(d => d.text.includes("build.zip"))?.text;
	expect(note).toBeDefined();

	t.q.onPrompt(note!);
	t.q.onAnswer(card(ref));
	await Promise.resolve();
	expect(t.state.posts).toEqual([card(ref)]);
});

test("a lane's report with the card goes back to the lane once, then is reported as written", () => {
	const ref = nextRef();
	const sent: string[] = [];
	const reports: string[] = [];
	const saved = hooks.report;
	hooks.report = (_lane, text) => void reports.push(text);
	const name = `attach-${ref}`;
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const lane = { name, cwd: "/tmp", model: "m", status: "idle", startedAt: "", reports: 0, lastText: "", ctx: { compaction: { state: "idle" } }, proc: { send: (t: string) => sent.push(t) } } as unknown as Lane;
	lanes.set(name, lane);
	try {
		report(lane, `[ask] ${card(ref).slice(6)}`);
		expect(reports).toEqual([]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("build.zip");

		lane.reportedThisTurn = undefined;
		report(lane, `[ask] ${card(ref).slice(6)}`);
		expect(sent).toHaveLength(1);
		expect(reports).toHaveLength(1);
	} finally {
		hooks.report = saved;
		lanes.delete(name);
	}
});

test("/api/send returns the card to its author once, then lets the same ref through", async () => {
	const ref = nextRef();
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const send = async (text: string) => {
		const r = await route(new Request("http://127.0.0.1/api/send", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, body: JSON.stringify({ target: "chat", text, session: "main" }) }));
		return (await r!.json()) as { delivered?: boolean; reason?: string };
	};
	const first = await send(card(ref));
	expect(first.delivered).toBe(false);
	expect(first.reason).toContain("build.zip");
	expect((await send(card(ref))).delivered).toBe(true);
});
