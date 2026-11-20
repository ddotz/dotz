import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emit, type HubEvent } from "./events.ts";
import { NOTICE_CLASSES } from "./notice-class.ts";
import { NOTICE_KIND_NAMES, NOTICE_KINDS, type NoticeKindName, pushTitle } from "./notice-kinds.ts";
import { allNotices, type Notice, onDecision, onNoticeUnread, updateAvailable } from "./notices.ts";
import { postClass } from "./notify-route.ts";
import { classify, decisionPush, noticePush } from "./push.ts";
import { diskReader, HANGUL, resolveView, webText } from "./web-i18n.ts";
import { WORKLOG_KINDS } from "./worklog-kind.ts";

const u = Date.now().toString(36);
const ch = `ch:${Date.now()}`;
const at = (i: number) => new Date(Date.now() - 3_600_000 + i * 1000).toISOString();
const out = (i: number, e: Record<string, unknown>): HubEvent => ({ ts: at(i), kind: "out", source: "orchestrator", text: "", ...e });
const SAMPLES: Record<NoticeKindName, { event?: HubEvent; run?: () => void; find: (n: Notice) => boolean }> = {
	ask: { event: out(1, { target: `${ch}01`, text: `[ask] 어느 쪽으로 할까요 ${u}?` }), find: n => n.text.includes(`할까요 ${u}`) },
	"session-ask": { event: out(2, { source: `lane:ka${u}`, target: `lane:ka${u}`, text: `[ask] 머지할까요 ${u}?` }), find: n => n.text.includes(`머지할까요 ${u}`) },
	decision: { event: out(3, { target: `${ch}02`, text: `[ask] 정해 주세요.\n결정: 배포 ${u}\n**1) 지금**\n**2) 밤에**` }), find: n => n.title === `배포 ${u}` },
	alert: { event: out(4, { source: "gateway", target: "alert", text: `땃쥐: 모델 제공자 오류 ${u}` }), find: n => n.text.includes(`오류 ${u}`) },
	"session-fail": { event: { ts: at(5), kind: "lane_report", source: `lane:kf${u}`, lane: `kf${u}`, text: "[fail] 테스트가 깨졌어요" }, find: n => n.open === `lane:kf${u}` },
	"worklog-fail": { event: out(6, { source: "gateway", target: "worklog", text: `[fail] 야간 정리 실패 ${u}` }), find: n => n.text.includes(`정리 실패 ${u}`) },
	"answer-fail": { event: out(7, { target: `${ch}07`, text: `[fail] 못 했어요 ${u}` }), find: n => n.open === `${ch}07` },
	"session-done": { event: { ts: at(8), kind: "lane_report", source: `lane:kd${u}`, lane: `kd${u}`, text: "[done] 끝났어요" }, find: n => n.open === `lane:kd${u}` },
	"worklog-done": { event: out(9, { target: "worklog", text: `[done] 정리 끝 ${u}` }), find: n => n.text.includes(`정리 끝 ${u}`) },
	"answer-done": { event: out(10, { target: `${ch}10`, text: `[done] 다 했어요 ${u}` }), find: n => n.open === `${ch}10` },
	mail: { event: { ts: at(11), kind: "mail", source: "acme", incoming: true, mail: `km${u}`, from: "Kim <kim@example.com>", subject: `견적 ${u}`, text: "" }, find: n => n.open === `mail:km${u}` },
	watch: { event: out(12, { source: "gateway", target: `${ch}12`, text: `[감시${u}] 새 글이 올라왔어요` }), find: n => n.open === `${ch}12` },
	"self-update": { run: () => updateAvailable(`dotz ${u} 버전이 나왔어요`), find: n => n.key === "self-update" },
	answer: { event: out(13, { target: `${ch}13`, text: `보고서 정리했어요 ${u}` }), find: n => n.open === `${ch}13` },
	"send-fail": { event: out(30, { source: "gateway", nk: "send-fail", target: `${ch}30`, text: `[fail] 보내지 못했어요: 답장 (r1${u})` }), find: n => n.text.includes(`(r1${u})`) },
	"send-check": { event: out(31, { source: "gateway", nk: "send-check", target: `${ch}31`, text: `[wait] 보냈는지 확인되지 않았어요: 답장 (r2${u})` }), find: n => n.text.includes(`(r2${u})`) },
	undelivered: { event: out(32, { source: "gateway", nk: "undelivered", target: `${ch}32`, text: `세션 x${u}을(를) 이어갈 수 없어요` }), find: n => n.open === `${ch}32` },
	"usage-stop": { event: out(33, { source: "gateway", nk: "usage-stop", target: `${ch}33`, text: `지금 사용량 한도로 멈춰 있어요 ${u}` }), find: n => n.open === `${ch}33` },
	"orch-error": { event: out(34, { source: "gateway", nk: "orch-error", target: `${ch}34`, text: `연결이 돌아오면 다시 시도해요 ${u}` }), find: n => n.open === `${ch}34` },
	ledger: { event: out(35, { source: "gateway", nk: "ledger", target: `${ch}35`, text: `내일 마감인 일이 1건 있어요 ${u}` }), find: n => n.open === `${ch}35` },
	schedule: { event: out(37, { target: `${ch}37`, text: `어제는 재요청이 없었어요 ${u}. 표는 아래에 있어요.`, run: `sk${u}`, sk: "task" }), find: n => n.key === `schedule:sk${u}` },
	"gateway-note": { event: out(36, { source: "gateway", nk: "gateway-note", target: `${ch}36`, text: `모델을 바꿨어요 ${u}` }), find: n => n.open === `${ch}36` },
};

test("every notice kind has a title in each language (no Korean on an English install), a class, and a place a tap opens", () => {
	const en = resolveView("en", diskReader());
	for (const k of NOTICE_KIND_NAMES) {
		const row = NOTICE_KINDS[k];
		expect([k, NOTICE_CLASSES.includes(row.cls)]).toEqual([k, true]);
		expect(pushTitle(k, "dotz").trim()).not.toBe("");
		expect([k, HANGUL.test(pushTitle(k, "dotz", en))]).toEqual([k, false]);
		expect(row.open({ name: "dotz", conv: "lane:x", id: "n1" })).not.toBe("");
	}
});

test("a sample of every notice kind makes a bell item and a phone notification of that kind's class and title (none for a kind kept off the bell)", () => {
	const bell: Notice[] = [];
	onNoticeUnread(n => bell.push(n));
	onDecision(n => bell.push(n));
	for (const k of NOTICE_KIND_NAMES) {
		const s = SAMPLES[k];
		if (s.event) emit(s.event.kind === "out" ? "outbox" : "inbox", s.event);
		else s.run?.();
		const n = bell.findLast(s.find) ?? allNotices().find(s.find);
		if (!NOTICE_KINDS[k].channels.bell) {
			expect([k, n, s.event && classify(s.event)]).toEqual([k, undefined, undefined]);
			continue;
		}
		expect([k, n !== undefined]).toEqual([k, true]);
		const m = k === "decision" ? decisionPush(n!) : ((s.event && classify(s.event)) ?? noticePush(n!));
		const row = NOTICE_KINDS[k];
		expect([k, m?.kind, m?.title.endsWith(webText(row.title, { name: "" }).trim())]).toEqual([k, row.cls, true]);
	}
});

test("a writer that names its kind is classed by it, and a kind the registry does not know falls back to the guess", () => {
	expect(classify({ ts: at(20), kind: "out", source: "gateway", target: "alert", text: `땃쥐: 보내지 못했어요 ${u}`, nk: "session-fail" })).toMatchObject({ kind: "alert" });
	expect(postClass("main", "[fail] 보내지 못했어요", { source: "gateway", nk: "alert" })).toBe("alert");
	expect(postClass("main", "[fail] 보내지 못했어요", { source: "gateway", nk: "no-such-kind" })).toBeUndefined();
	expect(noticePush({ id: "nk1", ts: at(21), updated: at(21), kind: "message", tone: "", title: "x", text: "본문", open: "main", at: at(21), read: false, nk: "alert" })).toMatchObject({ kind: "alert" });
});

const HUB = import.meta.dir;
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const REGEX_BEFORE = /[(,=:[!&|?{};]\s*$/;
function skipQuoted(src: string, i: number): number {
	const q = src[i];
	for (let j = i + 1; j < src.length; j++) {
		if (src[j] === "\\") j++;
		else if (q === "`" && src.startsWith("${", j)) j = closeOf(src, j + 1);
		else if (src[j] === q) return j;
	}
	return src.length;
}
function skipRegex(src: string, i: number): number {
	let cls = false;
	for (let j = i + 1; j < src.length; j++) {
		if (src[j] === "\\") j++;
		else if (src[j] === "[") cls = true;
		else if (src[j] === "]") cls = false;
		else if (src[j] === "/" && !cls) return j;
	}
	return src.length;
}
function closeOf(src: string, open: number): number {
	const want: string[] = [OPENERS[src[open]!]!];
	for (let i = open + 1; i < src.length; i++) {
		const c = src[i]!;
		if (c === '"' || c === "'" || c === "`") i = skipQuoted(src, i);
		else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
		else if (c === "/" && REGEX_BEFORE.test(src.slice(Math.max(0, i - 40), i))) i = skipRegex(src, i);
		else if (OPENERS[c]) want.push(OPENERS[c]!);
		else if (c === want.at(-1)) {
			want.pop();
			if (!want.length) return i;
		}
	}
	return src.length;
}
const hubSources = (): { file: string; src: string }[] =>
	(readdirSync(HUB, { recursive: true }) as string[])
		.filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.split("/").some(p => p === "test" || p === "runtime"))
		.map(f => ({ file: `hub/${f}`, src: readFileSync(join(HUB, f), "utf8") }));
function callsOf(pattern: RegExp): { file: string; call: string }[] {
	return hubSources().flatMap(({ file, src }) => [...src.matchAll(pattern)].map(m => ({ file, call: src.slice(m.index, closeOf(src, m.index + m[0].indexOf("(")) + 1) })));
}
const GATEWAY = /\bsource: "gateway"/;
const namedKinds = (call: string): string[] => [...call.matchAll(/\bnk: ([^,}]+)/g)].flatMap(m => [...m[1]!.matchAll(/"([^"]+)"/g)].map(q => q[1]!));
const WORKLOG_KIND = new RegExp(`\\bwk: "(?:${WORKLOG_KINDS.join("|")})"`);
const UNNAMED: { file: string; has: string; why: string }[] = [
	{ file: "hub/lanewire.ts", has: `"worklog" : "web", text`, why: "a model fallback record for the work log (or the web chat without Discord), born read by the notice store's worklog rule" },
	{ file: "hub/lanewire.ts", has: "out(target, text, undefined", why: "a status line in the conversation whose session kept running; nothing for the owner to act on" },
	{ file: "hub/routes-lanes.ts", has: "이 채널 자동 관리", why: "echoes the purpose the owner just set on the project's own page" },
	{ file: "hub/routes.ts", has: `out("alert", text`, why: "posts only to the alert conversation, which the registry's alert guess classes as an alert" },
];

test("every line the gateway writes for the owner names a registered kind (or is a work-log record, or a listed exception with its reason)", () => {
	const writes = [...callsOf(/(?<![\w.$])out\(/g).filter(c => GATEWAY.test(c.call)), ...callsOf(/\bemit\("outbox", /g).filter(c => GATEWAY.test(c.call) && /\bkind: "out"/.test(c.call) && !/\bupdate_key: "progress"/.test(c.call))];
	expect(writes.length).toBeGreaterThan(30);
	const unknown = writes.filter(c => namedKinds(c.call).some(k => !(NOTICE_KIND_NAMES as string[]).includes(k)));
	expect(unknown.map(c => `${c.file}: ${c.call.slice(0, 160)}`)).toEqual([]);
	const unnamed = writes.filter(c => !/\bnk: /.test(c.call) && !WORKLOG_KIND.test(c.call));
	const listed = (c: { file: string; call: string }) => UNNAMED.some(x => x.file === c.file && c.call.includes(x.has));
	expect(unnamed.filter(c => !listed(c)).map(c => `${c.file}: ${c.call.slice(0, 160)}`)).toEqual([]);
	expect(UNNAMED.filter(x => unnamed.filter(c => c.file === x.file && c.call.includes(x.has)).length !== 1).map(x => `${x.file}: ${x.has}`)).toEqual([]);
});

test("each kind the gateway's own lines need has a writer that names it", () => {
	const named = new Set(callsOf(/(?<![\w.$])out\(/g).flatMap(c => namedKinds(c.call)));
	for (const k of ["send-fail", "send-check", "undelivered", "usage-stop", "orch-error", "ledger", "gateway-note"]) expect([k, named.has(k)]).toEqual([k, true]);
});
