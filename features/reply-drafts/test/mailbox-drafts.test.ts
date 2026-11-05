import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettings } from "../../../hub/app-settings.ts";
import { mailByKey, recordMail } from "../../../hub/mail.ts";
import { reviseDraft } from "../lib/flow.ts";
import { offerMailDraft, requestMailDraft, type OfferMail } from "../lib/offer.ts";
import { correctionsOf, paths, writeIdentity } from "../lib/settings.ts";
import { listDrafts } from "../lib/store.ts";
import { enable, fakeModel, j, mailFixture, setupEnv } from "./helpers.ts";

// Reply drafts follow the mailbox a mail is in (docs/mailbox.md "Handling"): mode, the judge on the rule match, the box's reply settings and tone.
const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-box-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), paths.toneDir(), join(env.dir, "draft-files"), join(env.dir, "custom", "mailboxes.json")]) rmSync(p, { force: true, recursive: true });
});

const reply = { action: "draft", reason: "asks a question", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요.", questions: [] };
const RULE = { name: "자료 요청", when: "신청서를 보내 달라는 메일", how: "신청서를 첨부해요" };
const BASE = { id: "base", name: "일반", base: true };
let rev = 0, seq = 0;
const boxes = (...list: object[]) => {
	mkdirSync(join(env.dir, "custom"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "mailboxes.json"), JSON.stringify({ rev: ++rev, accounts: { mail: { boxes: list } }, pins: {} }));
};
const box = (id: string, extra: object = {}) => ({ id, name: id, ...extra });
const appSwitch = (auto: boolean) => enable(env, { apps: { mail: { auto } } });
const mail = (extra: Partial<OfferMail> = {}): OfferMail => ({ ...mailFixture, key: `bx-${++seq}`, ...extra });
// What the hub keeps of the mail: the box it is in (hub/mail.ts record), through the injected lookup and the recorded moves.
function world(inBox?: string) {
	const out = { sent: [] as string[], moves: [] as { key: string; box: string }[] };
	const deps = { send: (_t: string, text: string) => void out.sent.push(text), log: () => {}, mailOf: (key: string) => ({ key, source: "zele", id: "msg-1", subject: "s", from: "Kim <kim@example.com>", at: "2031-01-01T00:00:00Z", ...(inBox ? { mbox: inBox } : {}) }), place: (key: string, to: string) => void out.moves.push({ key, box: to }) };
	return { ...out, out, deps };
}
const isMatch = (c: { system: string }) => /sort one received mail/.test(c.system);
const nothingSent = () => expect(listDrafts().some(d => d.status === "sent")).toBe(false);

describe("a mail in no box (or a base box that sets nothing)", () => {
	test("is drafted exactly as before: same prompt, same call count, with or without a stored base box", async () => {
		appSwitch(true);
		const m = mail();
		const before = fakeModel([j(reply)]);
		expect(await offerMailDraft(m, { send: () => {}, log: () => {}, call: before.call })).toBe("offered");
		rmSync(paths.drafts(), { force: true });
		boxes(BASE, box("b-x", { mode: "ask" }));
		const after = fakeModel([j(reply)]);
		expect(await offerMailDraft(m, { ...world().deps, call: after.call })).toBe("offered");
		expect(after.calls).toEqual(before.calls);
		expect(before.calls).toHaveLength(1);
		nothingSent();
	});
	test("with the app switch off and no rule is not drafted and costs no call", async () => {
		appSwitch(false);
		boxes(BASE);
		const model = fakeModel([j(reply)]);
		expect(await offerMailDraft(mail(), { ...world().deps, call: model.call })).toBe("off");
		expect(model.calls).toHaveLength(0);
	});
});

describe("mode of the box", () => {
	test.each(["ask", "notify"])("%s: no automatic draft and no model call, but 초안 작성 drafts", async mode => {
		appSwitch(true);
		boxes(BASE, box("b-m", { mode }));
		const model = fakeModel([j(reply)]), w = world("b-m"), m = mail();
		expect(await offerMailDraft(m, { ...w.deps, call: model.call })).toBe("off");
		expect(model.calls).toHaveLength(0);
		expect(w.out.sent).toHaveLength(0);
		expect(await requestMailDraft(m, { ...w.deps, call: model.call })).toBe("offered");
		expect(model.calls).toHaveLength(1);
		expect(listDrafts()[0]).toMatchObject({ box: "b-m", instance: "mail" });
		nothingSent();
	});
	test("auto drafts with the app switch off; the owner's own mail still gets none", async () => {
		appSwitch(false);
		boxes(BASE, box("b-a", { mode: "auto" }));
		const model = fakeModel([j(reply)]), w = world("b-a");
		expect(await offerMailDraft(mail(), { ...w.deps, call: model.call })).toBe("offered");
		expect(await offerMailDraft(mail({ from: "Me <me@example.net>" }), { ...w.deps, call: model.call })).toBe("skipped");
		expect(model.calls).toHaveLength(1);
		nothingSent();
	});
});

describe("the judge rides on the rule match", () => {
	const judged = () => boxes(BASE, box("b-j1", { mode: "auto", judge: { on: true, text: "문서를 요청하는 메일" } }), box("b-j2", { mode: "ask", judge: { on: true, text: "행사 안내 메일" } }), box("b-off", { judge: { on: false, text: "꺼진 판단" } }));
	test("a mail a literal rule placed makes no judge call", async () => {
		appSwitch(false);
		judged();
		const model = fakeModel([j(reply)]), w = world("b-j1");
		expect(await offerMailDraft(mail(), { ...w.deps, call: model.call })).toBe("offered");
		expect(model.calls.filter(isMatch)).toHaveLength(0);
		expect(w.out.moves).toEqual([]);
	});
	test("rules and judges are numbered together in one call, and the number maps back", async () => {
		appSwitch(false);
		judged();
		writeSettings(env.dir, "mail", { draft_rules: [RULE, { name: "견학", when: "견학 날짜를 묻는 메일", how: "날짜를 물어요" }] });
		const hit = async (n: string) => {
			const model = fakeModel([n, j(reply)]), w = world(), m = mail();
			rmSync(paths.drafts(), { force: true });
			const result = await offerMailDraft(m, { ...w.deps, call: model.call });
			return { result, model, w, m };
		};
		const first = await hit("3");
		expect(first.model.calls.filter(isMatch)).toHaveLength(1);
		const prompt = first.model.calls[0]!.user;
		expect(prompt).toContain(`1. ${RULE.when}`);
		expect(prompt).toContain("2. 견학 날짜를 묻는 메일");
		expect(prompt).toContain("3. 문서를 요청하는 메일");
		expect(prompt).toContain("4. 행사 안내 메일");
		expect(prompt).not.toContain("꺼진 판단");
		expect(first.model.calls).toHaveLength(2);
		expect(first.result).toBe("offered");
		expect(first.w.out.moves).toEqual([{ key: first.m.key, box: "b-j1" }]);
		expect(listDrafts()[0]).toMatchObject({ box: "b-j1" });
		const ask = await hit("4");
		expect([ask.result, ask.model.calls.length, ask.w.out.moves]).toEqual(["off", 1, [{ key: ask.m.key, box: "b-j2" }]]);
		const ruled = await hit("2");
		expect(ruled.result).toBe("offered");
		expect(ruled.w.out.moves).toEqual([]);
		expect(listDrafts()[0]?.rule?.name).toBe("견학");
		const none = await hit("0");
		expect([none.result, none.w.out.moves]).toEqual(["skipped", []]);
		nothingSent();
	});
	test("no judge for a mail that needs no reply, or a requested draft", async () => {
		appSwitch(true);
		judged();
		const model = fakeModel(["1", j(reply)]), w = world();
		expect(await offerMailDraft(mail({ needs: false }), { ...w.deps, call: model.call })).toBe("off");
		expect(await requestMailDraft(mail(), { ...w.deps, call: model.call })).toBe("offered");
		expect(model.calls.filter(isMatch)).toHaveLength(0);
		expect(w.out.moves).toEqual([]);
	});
	test("a hit records the box and why on the stored mail", async () => {
		appSwitch(false);
		judged();
		const m = mail();
		recordMail({ key: m.key, source: "zele", id: m.id, subject: m.subject, from: m.from!, at: "2031-01-01T00:00:00Z" });
		expect(await offerMailDraft(m, { send: () => {}, log: () => {}, call: fakeModel(["1", j(reply)]).call })).toBe("offered");
		expect(mailByKey(m.key)).toMatchObject({ mbox: "b-j1", mwhy: { kind: "judge" } });
	});
});

describe("reply settings of the box", () => {
	const draftIn = async (settings: object, m = mail()) => {
		appSwitch(false);
		boxes(BASE, box("b-r", { mode: "auto", ...settings }));
		const model = fakeModel([j(reply)]), w = world("b-r");
		expect(await offerMailDraft(m, { ...w.deps, call: model.call })).toBe("offered");
		return { model, w, last: model.calls.at(-1)!.user };
	};
	test("how, the greeting for this sender and the bans reach the prompt", async () => {
		const set = { how: "항상 존댓말로", greets: [{ who: "김 선생님", addr: "@example.com", hello: "선생님 안녕하세요" }, { who: "", addr: "other@else.org", hello: "다른 인사" }], bans: ["죄송"] };
		const { last } = await draftIn(set);
		for (const s of ["항상 존댓말로", "선생님 안녕하세요", "죄송"]) expect(last).toContain(s);
		expect(last).not.toContain("다른 인사");
	});
	test("a banned phrase in the draft is a warning on the card, not a block", async () => {
		const { w } = await draftIn({ bans: ["말씀드릴게요"] });
		expect(w.out.sent[0]).toContain("쓰지 않기로 한 표현 '말씀드릴게요'");
		expect(listDrafts()[0]?.status).toBe("pending");
		rmSync(paths.drafts(), { force: true });
		expect((await draftIn({ bans: ["없는표현"] })).w.out.sent[0]).not.toContain("쓰지 않기로 한 표현");
	});
	test("the box's rules replace the instance's", async () => {
		writeSettings(env.dir, "mail", { draft_rules: [RULE] });
		appSwitch(false);
		const { model } = await draftIn({ rules: [{ name: "박스 규칙", when: "문서 문의", how: "문서를 보내요", files: [], on: true }] });
		expect(model.calls[0]!.user).toContain("1. 문서 문의");
		expect(model.calls[0]!.user).not.toContain(RULE.when);
	});
	test("an alone box follows none of the instance's rules or 기본 규칙", async () => {
		writeSettings(env.dir, "mail", { draft_rules: [RULE], draft_default: "모든 메일에 넣는 지시" });
		appSwitch(true);
		const { model } = await draftIn({ alone: true, mode: "auto" });
		expect(model.calls.some(isMatch)).toBe(false);
		expect(JSON.stringify(model.calls)).not.toContain("모든 메일에 넣는 지시");
	});
	test("the box's folders join the 첨부 파일 폴더 for candidates; none keeps the single folder", async () => {
		const own = join(lib, "box"), app = join(lib, "app");
		for (const [dir, name] of [[own, "봄노래 문서 박스.pdf"], [app, "봄노래 문서 앱.pdf"]] as const) mkdirSync(dir, { recursive: true }), writeFileSync(join(dir, name), "x");
		enable(env, { apps: { mail: { auto: false } }, attachFolders: { mail: app } });
		const ask = () => mail({ subject: "봄노래 문서 요청드립니다", body: "봄노래 문서 보내 주실 수 있을까요?" });
		boxes(BASE, box("b-f", { mode: "auto", folders: [own] }));
		const withBox = fakeModel([j(reply)]);
		await offerMailDraft(ask(), { ...world("b-f").deps, call: withBox.call });
		expect(withBox.calls[0]!.user).toContain("봄노래 문서 박스.pdf");
		expect(withBox.calls[0]!.user).toContain("봄노래 문서 앱.pdf");
		boxes(BASE, box("b-f", { mode: "auto" }));
		const plain = fakeModel([j(reply)]);
		await offerMailDraft(ask(), { ...world("b-f").deps, call: plain.call });
		expect(plain.calls[0]!.user).not.toContain("봄노래 문서 박스.pdf");
		expect(plain.calls[0]!.user).toContain("봄노래 문서 앱.pdf");
	});
});

describe("tone of the box", () => {
	const toneBox = { key: { app: "mail", room: "b-t" } };
	test("tone/<instance>/<box>.md is used for the draft and takes the corrections; without it today's profile does", async () => {
		appSwitch(false);
		boxes(BASE, box("b-t", { mode: "auto" }));
		const w = world("b-t");
		const plain = fakeModel([j(reply)]);
		await offerMailDraft(mail(), { ...w.deps, call: plain.call });
		expect(plain.calls[0]!.user).not.toContain("상자 말투 신원");
		const first = listDrafts()[0]!;
		await reviseDraft(first.id, "더 짧게", { call: fakeModel([j(reply)]).call });
		expect(correctionsOf({ app: "mail" }).some(c => c.includes("더 짧게"))).toBe(true);
		writeIdentity(toneBox.key, ["상자 말투 신원"]);
		const styled = fakeModel([j(reply)]);
		await offerMailDraft(mail(), { ...w.deps, call: styled.call });
		expect(styled.calls[0]!.user).toContain("상자 말투 신원");
		const second = listDrafts().find(d => d.status === "pending")!;
		expect(second.box).toBe("b-t");
		await reviseDraft(second.id, "인사를 줄여서", { call: fakeModel([j(reply)]).call });
		expect(correctionsOf(toneBox.key).some(c => c.includes("인사를 줄여서"))).toBe(true);
		expect(correctionsOf({ app: "mail" }).some(c => c.includes("인사를 줄여서"))).toBe(false);
		nothingSent();
	});
});
