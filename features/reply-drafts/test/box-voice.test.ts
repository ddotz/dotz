// One learned voice per mailbox (docs/mailbox.md "Voice"): only the owner's own replies of a mailbox reach its voice and its draft examples, too few fall back to the account's voice and say so,
// moves and undo need no rewrite, and learning runs once, not per mail. Scratch data dir, fake model calls, no mail read.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordMail, type MailRecord } from "../../../hub/mail.ts";
import type { ReplyItem } from "../../../hub/reply-draft.ts";
import { boxPass, mailboxRoute } from "../../../hub/routes-mailbox.ts";
import { runOnboard } from "../bin/onboard.ts";
import { learnBox, ownPairs, refreshVoices, relearnBox, VOICE_MAX, VOICE_MIN, voiceLines, voiceOf } from "../lib/box-voice.ts";
import { boxCtx } from "../lib/box-place.ts";
import { boxLines } from "../lib/box.ts";
import { buildDraft, toneKey } from "../lib/flow.ts";
import { correctionsOf, identityOf, loadPairs, loadStyle, paths, type Pair, recordCorrection, readLearned, savePairs, templatesOf, toneFile, writeIdentity } from "../lib/settings.ts";
import { addDraft, setStatus, type DraftRec } from "../lib/store.ts";
import { refreshPairs, type PluginSent } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
const file = join(env.dir, "custom", "mailboxes.json");
let seq = 0, rev = 0;
const BASE = { id: "base", name: "일반", base: true };
const WORK = { id: "b-work", name: "업무", conds: { from: ["@work.example.com"] } };
const PALS = { id: "b-pals", name: "친구", conds: { from: ["@pals.example.com"] } };
const boxes = (...list: object[]) => writeFileSync(file, JSON.stringify({ rev: ++rev, accounts: { mail: { boxes: list } }, pins: {} }));
beforeEach(() => {
	for (const p of [paths.toneDir(), paths.learned(), paths.corpusDir(), paths.voices(), paths.drafts(), join(paths.pairs("mail"), ".."), join(env.dir, "custom", "apps.json")]) rmSync(p, { force: true, recursive: true });
	mkdirSync(join(env.dir, "custom"), { recursive: true });
	enable(env);
	boxes(BASE, WORK, PALS);
});

const FORMAL = "삼가 회신드립니다", CASUAL = "응응 보내줄게";
const pair = (domain: string, text: string, extra: Partial<Pair> = {}): Pair => {
	const n = ++seq;
	return { received: `${n}번 자료 부탁해요`, reply: `${text} ${n}번입니다.`, at: 1_900_000_000_000 + n * 60_000, from: `Kim <kim${n}@${domain}>`, source: "zele", conv: `conv${n}`, subj: `자료 ${n}`, ...extra };
};
const many = (n: number, domain: string, text: string): Pair[] => Array.from({ length: n }, () => pair(domain, text));
const fill = (work = 25, pals = 25) => savePairs("mail", [...many(work, "work.example.com", FORMAL), ...many(pals, "pals.example.com", CASUAL)]);
// A fake analysis that reads what it was given: two different corpora give two different voices.
const analyst = () => {
	const calls: string[] = [];
	return { calls, call: async (_s: string, user: string) => (calls.push(user), j({ identity: [user.includes(FORMAL) && !user.includes(CASUAL) ? "격식을 갖춰 써요" : user.includes(CASUAL) && !user.includes(FORMAL) ? "친구처럼 편하게 써요" : "섞여 있어요"], templates: [] })) };
};
const item = (text = "자료 부탁해요"): ReplyItem => ({ kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "자료", text });
const draftPrompt = async (box: string): Promise<string> => {
	const model = fakeModel([j(goodReply)]);
	await buildDraft(item(), { box, instance: "mail", source: "zele", mailId: "x", ref: "r" }, { call: model.call });
	return model.calls.map(c => c.system + c.user).join("\n");
};
const stored = (p: Pair, extra: Partial<MailRecord> = {}): MailRecord => ({ key: `vc-${p.conv}`, source: "zele", id: p.conv!, subject: p.subj!, from: p.from!, to: "me@example.net", at: new Date(p.at).toISOString(), ...extra } as MailRecord);
const move = (keys: string[], box: string) => mailboxRoute(new Request("http://x/api/mailbox/move", { method: "POST", body: JSON.stringify({ keys, box }) }), new URL("http://x/api/mailbox/move"), env.dir);
const get = (path: string) => mailboxRoute(new Request(`http://x${path}`), new URL(`http://x${path}`), env.dir);

describe("each mailbox has its own voice", () => {
	test("a draft's examples come only from its own mailbox, even when another mailbox's mail reads closer", async () => {
		savePairs("mail", [...many(25, "work.example.com", FORMAL).map(p => ({ ...p, received: `자료 검토 ${p.at}` })), ...many(25, "pals.example.com", CASUAL).map(p => ({ ...p, received: `자료 부탁해요 ${p.at}` }))]);
		const prompt = await draftPrompt("b-work");
		expect(prompt).toContain(FORMAL);
		expect(prompt).not.toContain(CASUAL);
	});

	test("two mailboxes give two voices, and a draft in each uses its own", async () => {
		fill();
		const a = analyst();
		await refreshVoices("mail", a.call);
		expect(a.calls.length).toBe(2);
		expect(identityOf({ app: "mail", room: "b-work" })).toEqual(["격식을 갖춰 써요"]);
		expect(identityOf({ app: "mail", room: "b-pals" })).toEqual(["친구처럼 편하게 써요"]);
		const work = await draftPrompt("b-work"), pals = await draftPrompt("b-pals");
		expect(work).toContain("격식을 갖춰 써요");
		expect(work).not.toContain("친구처럼 편하게 써요");
		expect(pals).toContain("친구처럼 편하게 써요");
		expect(pals).not.toContain("격식을 갖춰 써요");
		expect(voiceOf("mail", "b-work")).toMatchObject({ state: "own", texts: 25 });
	});

	test("learning does not rerun per mail, and a day's few new replies change nothing", async () => {
		fill();
		const a = analyst(), now = new Date();
		await refreshVoices("mail", a.call, () => {}, now);
		await refreshVoices("mail", a.call, () => {}, now);
		savePairs("mail", [...loadPairs("mail"), ...many(VOICE_MIN - 1, "work.example.com", FORMAL)]);
		await refreshVoices("mail", a.call, () => {}, new Date(now.getTime() + 25 * 3_600_000));
		expect(a.calls.length).toBe(2);
		savePairs("mail", [...loadPairs("mail"), ...many(1, "work.example.com", FORMAL)]);
		await refreshVoices("mail", a.call, () => {}, new Date(now.getTime() + 49 * 3_600_000));
		expect(a.calls.length).toBe(3);
	});

	test("a failed learning waits a day instead of running again on the next mail", async () => {
		fill(25, 0);
		const now = new Date();
		let calls = 0;
		const failing = async () => { calls++; throw new Error("no model"); };
		const lines: string[] = [];
		await refreshVoices("mail", failing, l => lines.push(l), now);
		await refreshVoices("mail", failing, l => lines.push(l), now);
		expect(calls).toBe(1);
		expect(lines.length).toBe(1);
	});

	test("the newest VOICE_MAX of a mailbox are read, not all and not a sample", async () => {
		savePairs("mail", many(VOICE_MAX + 30, "work.example.com", FORMAL));
		const a = analyst();
		await learnBox("mail", { ...BASE, ...WORK, base: false } as never, a.call);
		const seen = JSON.parse(readFileSync(paths.voices(), "utf8"))["mail/b-work"];
		expect(seen.texts).toBe(VOICE_MAX);
		const newest = ownPairs("mail").get("b-work")!.slice(0, VOICE_MAX).map(p => p.reply);
		expect(a.calls[0]).toContain(newest[0]);
		expect(a.calls[0]).not.toContain(ownPairs("mail").get("b-work")!.at(-1)!.reply);
	});

	test("only what he wrote himself counts: an edited draft and a sent draft of ours stay out", () => {
		const mine = pair("work.example.com", FORMAL), edited = pair("work.example.com", "고친 초안", { edited: true }), bot = pair("work.example.com", "우리가 쓴 초안");
		savePairs("mail", [mine, edited, bot]);
		addDraft({ id: "d-1", status: "pending", body: bot.reply } as DraftRec);
		setStatus("d-1", "sent");
		expect(ownPairs("mail").get("b-work")?.map(p => p.reply)).toEqual([mine.reply]);
	});

	test("a learned base box reaches its drafts; a base box with no voice stays as it was", () => {
		const m = { key: "vc-base", source: "zele", id: "m1", subject: "s", from: "x@example.com" } as never, deps = { mailOf: () => ({ mbox: "base" }) } as never;
		expect(boxCtx("mail", m, deps).box).toBeUndefined();
		writeIdentity({ app: "mail", room: "base" }, ["일반 메일의 말투"]);
		expect(boxCtx("mail", m, deps).box?.id).toBe("base");
	});
});

describe("too few of his own replies", () => {
	test("the mailbox stays on the account's voice and says so", async () => {
		writeIdentity({ app: "mail" }, ["계정 말투"]);
		fill(VOICE_MIN - 1, VOICE_MIN);
		const a = analyst();
		await refreshVoices("mail", a.call);
		expect(a.calls.length).toBe(1);
		expect(existsSync(toneFile({ app: "mail", room: "b-work" }))).toBe(false);
		expect(voiceOf("mail", "b-work")).toEqual({ state: "few", count: VOICE_MIN - 1, need: VOICE_MIN });
		expect((await get("/api/mailbox/tone?app=mail&box=b-work").then(r => r.json()) as { voice: unknown }).voice).toEqual({ state: "few", count: VOICE_MIN - 1, need: VOICE_MIN });
		expect(await draftPrompt("b-work")).toContain("계정 말투");
		expect(voiceLines().filter(l => l.includes("계정 말투")).length).toBeGreaterThan(0);
	});

	test("a mailbox that falls under the minimum goes back to the account's voice; his corrections stay", async () => {
		writeIdentity({ app: "mail" }, ["계정 말투"]);
		fill();
		const a = analyst(), now = new Date(), key = { app: "mail", room: "b-work" };
		await refreshVoices("mail", a.call, () => {}, now);
		recordCorrection(key, "더 짧게", now);
		savePairs("mail", []);
		rmSync(paths.pairs("mail"), { force: true });
		savePairs("mail", many(3, "work.example.com", FORMAL));
		await refreshVoices("mail", a.call, () => {}, now);
		expect(identityOf(key)).toEqual([]);
		expect(correctionsOf(key).length).toBe(1);
		expect(loadStyle(toneKey({ box: "b-work", instance: "mail" })).identity).toEqual(["계정 말투"]);
		expect(voiceOf("mail", "b-work").state).toBe("few");
		expect(readdirSync(join(paths.toneDir(), "mail")).some(f => f.startsWith("b-work.md.bak-"))).toBe(true);
	});
});

describe("moves and undo", () => {
	test("a moved conversation counts in its new mailbox at once, and undoing brings it back with no model call", async () => {
		const work = many(25, "work.example.com", FORMAL), pals = many(25, "pals.example.com", CASUAL);
		savePairs("mail", [...work, ...pals]);
		const a = analyst(), now = new Date();
		await refreshVoices("mail", a.call, () => {}, now);
		const moved = work.slice(0, 2);
		for (const p of moved) recordMail(stored(p));
		const keys = moved.map(p => `vc-${p.conv}`);
		expect((await move(keys, "b-pals")).status).toBe(200);
		expect(ownPairs("mail").get("b-work")?.length).toBe(23);
		expect(ownPairs("mail").get("b-pals")?.length).toBe(27);
		expect((await move(keys, "b-work")).status).toBe(200);
		expect(ownPairs("mail").get("b-work")?.length).toBe(25);
		await refreshVoices("mail", a.call, () => {}, new Date(now.getTime() + 25 * 3_600_000));
		expect(a.calls.length).toBe(2);
	});

	test("a reply with no conversation id follows its mail by sender and subject", async () => {
		const p = pair("example.com", FORMAL, { conv: undefined, subj: "Re: 견적 문의" });
		savePairs("mail", [p]);
		expect(ownPairs("mail").get("base")?.length).toBe(1);
		recordMail({ ...stored({ ...p, conv: "held-1" }), subject: "견적 문의", mbox: "b-work" });
		expect(ownPairs("mail").get("b-work")?.length).toBe(1);
	});

	test("a learned reply stays in its mailbox after its mail left the store", async () => {
		boxes(BASE, { id: "b-judged", name: "판단" });
		const list = many(VOICE_MIN, "example.com", FORMAL);
		savePairs("mail", list);
		for (const p of list) recordMail(stored(p, { mbox: "b-judged" }));
		expect(ownPairs("mail").get("b-judged")?.length).toBe(VOICE_MIN);
		await learnBox("mail", { id: "b-judged", name: "판단" } as never, analyst().call);
		boxes(BASE, { id: "b-judged", name: "판단" }, { id: "b-other", name: "다른" });
		for (const p of list) recordMail(stored(p, { mbox: "gone" }));
		expect(ownPairs("mail").get("b-judged")?.length).toBe(VOICE_MIN);
	});

	test("a deleted mailbox's replies fall to the rules, and its tone file stays", async () => {
		fill();
		await refreshVoices("mail", analyst().call);
		boxes(BASE, PALS);
		expect(ownPairs("mail").get("b-work")).toBeUndefined();
		expect(ownPairs("mail").get("base")?.length).toBe(25);
		expect(existsSync(toneFile({ app: "mail", room: "b-work" }))).toBe(true);
	});

	test("two accounts: a named account's pairs never reach the other account's mailboxes", () => {
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ "mail-2": { app: "mail", label: "회사", filter: { account: "me@work.example.com" } } }));
		writeFileSync(file, JSON.stringify({ rev: ++rev, accounts: { mail: { boxes: [BASE, WORK] }, "mail-2": { boxes: [BASE, WORK] } }, pins: {} }));
		savePairs("mail", [pair("work.example.com", "첫 계정", { account: "me@example.net" }), pair("work.example.com", "둘째 계정", { account: "me@work.example.com" })]);
		expect(ownPairs("mail").get("b-work")?.map(p => p.reply.split(" ")[0])).toEqual(["첫"]);
		expect(ownPairs("mail-2").get("b-work")?.map(p => p.reply.split(" ")[0])).toEqual(["둘째"]);
	});
});

describe("existing files and installs", () => {
	test("his corrections, sections and templates stay, the file is copied first, and a hand-tuned voice is not relearned by itself", async () => {
		const key = { app: "mail", room: "b-work" }, f = toneFile(key);
		mkdirSync(join(paths.toneDir(), "mail"), { recursive: true });
		writeFileSync(f, "## 고친 점\n\n- 2031-01-01: 더 짧게\n\n## 답장 틀\n\n- 직접 만든 틀\n\n## 보낸 사람 신분별\n\n- 교수님께는 존칭\n");
		fill();
		const a = analyst(), now = new Date();
		await refreshVoices("mail", a.call, () => {}, now);
		const text = readFileSync(f, "utf8");
		expect(identityOf(key)).toEqual(["격식을 갖춰 써요"]);
		expect(text).toContain("더 짧게");
		expect(text).toContain("교수님께는 존칭");
		expect(templatesOf(key)).toEqual(["직접 만든 틀"]);
		expect(readdirSync(join(paths.toneDir(), "mail")).some(x => x.startsWith("b-work.md.bak-"))).toBe(true);
		savePairs("mail", [...loadPairs("mail"), ...many(VOICE_MIN + 5, "work.example.com", FORMAL)]);
		await refreshVoices("mail", a.call, () => {}, new Date(now.getTime() + 25 * 3_600_000));
		expect(a.calls.filter(c => c.includes("업무")).length).toBe(1);
	});

	test("a voice the file already had is kept; only the owner's 다시 배우기 replaces it", async () => {
		const key = { app: "mail", room: "b-work" };
		writeIdentity(key, ["직접 적은 말투"]);
		fill();
		const a = analyst();
		await refreshVoices("mail", a.call);
		expect(identityOf(key)).toEqual(["직접 적은 말투"]);
		expect(voiceOf("mail", "b-work").state).toBe("kept");
		const box = { id: "b-work", name: "업무" } as never;
		expect((await relearnBox("mail", box, a.call, async () => {})).result).toBe("learned");
		expect(identityOf(key)).toEqual(["격식을 갖춰 써요"]);
	});

	test("다시 배우기 with too few reads the sent folder in the background and learns from it", async () => {
		fill(3, 0);
		const a = analyst(), read = Promise.withResolvers<void>();
		const out = await relearnBox("mail", { id: "b-work", name: "업무" } as never, a.call, async () => { savePairs("mail", many(25, "work.example.com", FORMAL)); read.resolve(); });
		expect(out.result).toBe("few");
		await read.promise;
		await Promise.resolve();
		await refreshVoices("mail", a.call);
		expect(identityOf({ app: "mail", room: "b-work" })).toEqual(["격식을 갖춰 써요"]);
	});

	const plugins = (limits: number[]): PluginSent => async want => {
		const limit = want("intra");
		limits.push(limit);
		return limit ? [{ plugin: "intra", source: "intra", items: [{ to: "Kim <kim@example.com>", subject: "견적", at: 1_900_000_000_000, body: "네 확인했습니다", received: "견적 부탁드려요", id: "t-9" }] }] : [];
	};

	test("mailboxes make each source read once more for the mailbox facts, after a copy of the pairs file", async () => {
		savePairs("mail", [{ received: "견적 부탁드려요", reply: "네 확인했습니다", at: 1_900_000_000_000, source: "intra" }]);
		const before = readFileSync(paths.pairs("mail"), "utf8"), limits: number[] = [], day = 25 * 3_600_000, now = Date.now();
		writeFileSync(paths.learned(), JSON.stringify({ "pairs-plugin-intra@1": "2031-01-01" }));
		await refreshPairs(async () => ({ code: 1, stdout: "", stderr: "" }), new Date(now), plugins(limits));
		await refreshPairs(async () => ({ code: 1, stdout: "", stderr: "" }), new Date(now + day), plugins(limits));
		expect(limits).toEqual([3000, 40]);
		expect(readFileSync(`${paths.pairs("mail")}.bak-boxes`, "utf8")).toBe(before);
		expect(loadPairs("mail")).toMatchObject([{ reply: "네 확인했습니다", conv: "t-9", subj: "견적" }]);
	});

	test("one mailbox: no extra read, no copy, no model call, no line, as before", async () => {
		boxes(BASE);
		savePairs("mail", many(VOICE_MIN + 5, "work.example.com", FORMAL));
		const limits: number[] = [], a = analyst();
		writeFileSync(paths.learned(), JSON.stringify({ "pairs-plugin-intra@1": "2031-01-01" }));
		await refreshPairs(async () => ({ code: 1, stdout: "", stderr: "" }), new Date(), plugins(limits));
		await refreshVoices("mail", a.call);
		expect(limits).toEqual([40]);
		expect(existsSync(`${paths.pairs("mail")}.bak-boxes`)).toBe(false);
		expect(a.calls).toEqual([]);
		expect(voiceOf("mail", "base").state).toBe("single");
		expect(voiceLines()).toEqual([]);
		expect(Object.keys(readLearned()).some(k => k.includes("@box"))).toBe(false);
	});

	test("setup and status show each mailbox, and learn --room learns that mailbox from its own replies", async () => {
		fill();
		const a = analyst();
		const status = await runOnboard(["learn", "--room", "b-work"], async () => ({ code: 1, stdout: "", stderr: "" }), false, undefined, a.call);
		expect(status.code).toBe(0);
		expect(a.calls.length).toBe(1);
		expect(a.calls[0]).toContain(FORMAL);
		expect((await runOnboard(["status"])).lines.length).toBe(4);
	});
});

test("a mailbox's hand-written instruction outranks the learned voice in the box lines", () => {
	expect(boxLines({ how: "짧게 답해요", greets: [], bans: [] } as never, "")[0]).toBe("짧게 답해요");
	expect(boxLines({ how: "", greets: [], bans: [] } as never, "")).toEqual([]);
});

test("예시 보기 shows his own newest replies, and a box of another account is refused", async () => {
	fill();
	const body = await (await get("/api/mailbox/examples?app=mail&box=b-work")).json() as { examples: { reply: string }[] };
	expect(body.examples.length).toBe(5);
	expect(body.examples.every(x => x.reply.includes(FORMAL))).toBe(true);
	expect((await get("/api/mailbox/examples?app=mail&box=b-none")).status).toBe(404);
	expect(boxPass(env.dir)).toBeFunction();
});
