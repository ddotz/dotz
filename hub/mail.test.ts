// Mail as conversations (hub/mail.ts): key rules, postMail with and without Discord, idempotency, validation and the wake turn,
// with Discord and the event bus injected as fakes.
import { describe, expect, test } from "bun:test";
import "./conversations.ts"; // listens to the event bus: the first message of a mail conversation gives the mail its summary
import { emit, eventTarget, type HubEvent } from "./events.ts";
import { MailError, attachmentList, mailBriefOf, mailByKey, mailByThread, mailCard, mailKey, mailTarget, mailTargets, postMail, setMailSuggest, type MailDeps } from "./mail.ts";
import { outEvent } from "./projectchat.ts";

function fakes(discordOn: boolean, channel: string | undefined = "1561565203714408448", threadOn: MailDeps["threadOn"] = () => true) {
	const calls = { channels: 0, threads: [] as [string, string, string][], sends: [] as [string, string][], events: [] as Record<string, any>[], wakes: [] as [Record<string, any>, string][] };
	let n = 0;
	const deps: MailDeps = {
		createThread: async (parent, name, starter) => {
			calls.threads.push([parent, name, starter]);
			return { id: `14300000000000000${++n}` };
		},
		send: async (target, text) => void calls.sends.push([target, text]),
		mailChannel: async () => {
			calls.channels++;
			return channel;
		},
		discordOn,
		threadOn,
		emit: e => void calls.events.push(e),
		wake: (e, target) => void calls.wakes.push([e, target]),
	};
	return { deps, calls };
}
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;

describe("mail key", () => {
	test("lowercase source-id limited to [a-z0-9._-]", () => {
		expect(mailKey("Zele", "18F3a.B_c")).toBe("zele-18f3a.b_c");
		expect(mailKey("work mail", "<abc@host>")).toBe("work-mail-abc-host");
		expect(mailTarget("zele-1")).toBe("mail:zele-1");
	});
	test("a source or id with nothing usable is rejected", () => {
		expect(() => mailKey("", "1")).toThrow(MailError);
		expect(() => mailKey("zele", "한글만")).toThrow(MailError);
		expect(() => mailKey("...", "1")).toThrow(MailError);
	});
});

describe("postMail", () => {
	test("with a poster's thread: recorded, one mail event in mail:<key>, no thread opened", async () => {
		const { deps, calls } = fakes(true);
		const id = uid("t");
		const r = await postMail({ source: "kdb", id, subject: "견적 요청", from: "Kim <kim@example.com>", summary: "금요일까지 회신 요청", body: "본문입니다", thread: "1430000000000009999" }, deps);
		expect(r).toEqual({ ok: true, key: `kdb-${id}`, target: `mail:kdb-${id}`, thread: "1430000000000009999" });
		expect(calls.threads).toEqual([]);
		expect(calls.sends).toEqual([]);
		expect(calls.events).toHaveLength(1);
		const e = calls.events[0]!;
		expect(e).toMatchObject({ kind: "mail", source: "kdb", channel: r.target, conv: r.target, mail: r.key });
		expect(String(e.text).split("\n")[0]).toBe("Kim <kim@example.com> · 견적 요청");
		expect(e.text).toContain("금요일까지 회신 요청");
		expect(e.text).toContain("원문\n본문입니다");
		expect(eventTarget(e as HubEvent)).toBe(r.target);
		expect(mailByThread("1430000000000009999")?.key).toBe(r.key);
		expect(mailTargets()).toContain(r.target);
		expect(calls.wakes).toEqual([]);
	});

	// The mail view always names who sent it, who it is for and, when there is one, the 참조 list (web 30-mail-thread.js draws it);
	// the poster's strings are kept as sent (a header list of "Name <addr>", comma separated) and come back in the card the web reads.
	test("to and cc are stored as sent and come back in the mail card and its event", async () => {
		const { deps, calls } = fakes(false);
		const id = uid("cc");
		const to = "나 <me@example.com>";
		const cc = "Lee <lee@example.com>, Park <park@example.com>";
		const r = await postMail({ source: "plug", id, subject: "참조 확인", from: "Kim <kim@example.com>", to, cc }, deps);
		expect(mailByKey(r.key)).toMatchObject({ to, cc });
		expect(mailCard(mailByKey(r.key)!)).toMatchObject({ to, cc, subject: "참조 확인", from: "Kim <kim@example.com>" });
		expect(calls.events[0]).toMatchObject({ to, cc });
		// an outgoing mail keeps them too
		const out = await postMail({ source: "plug", id: uid("cc-out"), subject: "보낸 메일", from: "나 <me@example.com>", to: "Kim <kim@example.com>", cc, direction: "out" }, deps);
		expect(mailCard(mailByKey(out.key)!)).toMatchObject({ to: "Kim <kim@example.com>", cc, dir: "out" });
	});

	test("no thread, Discord on: the hub opens one thread in the mail channel and puts the body in it", async () => {
		const { deps, calls } = fakes(true);
		const id = uid("d");
		const r = await postMail({ source: "zele", id, subject: "회의 안내", from: "Lee", summary: "내일 10시", body: "자세한 내용" }, deps);
		expect(calls.threads).toEqual([["ch:1561565203714408448", "회의 안내", "Lee\n내일 10시"]]);
		expect(r.thread).toBe("143000000000000001");
		expect(calls.sends).toEqual([[`th:${r.thread}`, "원문\n자세한 내용"]]);
		expect(mailByKey(r.key)?.thread).toBe(r.thread);
	});

	test("Discord off: no thread, the mail lives in the web conversation only", async () => {
		const { deps, calls } = fakes(false);
		const r = await postMail({ source: "zele", id: uid("w"), subject: "web only" }, deps);
		expect(calls.threads).toEqual([]);
		expect(r.thread).toBeUndefined();
		expect(r.target).toBe(`mail:${r.key}`);
		expect(calls.events[0]).toMatchObject({ channel: r.target, conv: r.target });
	});

	test("Discord connected but 디스코드에도 올리기 not set (the default): web conversation only, no mail channel made, the wake goes to the web conversation", async () => {
		for (const threadOn of [undefined, () => false]) {
			const { deps, calls } = fakes(true, undefined, threadOn);
			if (!threadOn) delete deps.threadOn;
			const r = await postMail({ source: "zele", id: uid("off"), subject: "웹만", body: "본문", wake: true }, deps);
			expect(calls.channels).toBe(0);
			expect(calls.threads).toEqual([]);
			expect(calls.sends).toEqual([]);
			expect(r.thread).toBeUndefined();
			expect(calls.wakes.map(w => w[1])).toEqual([r.target]);
		}
	});

	test("디스코드에도 올리기 is per mail: it gets the source and key of each mail, so one instance can open threads while another stays on the web", async () => {
		const { deps, calls } = fakes(true, "1561565203714408448", source => source === "naver");
		const on = await postMail({ source: "naver", id: uid("i"), subject: "켜진 계정", wake: true }, deps);
		const off = await postMail({ source: "zele", id: uid("i"), subject: "꺼진 계정", wake: true }, deps);
		expect(on.thread).toBeDefined();
		expect(off.thread).toBeUndefined();
		expect(calls.threads.map(t => t[1])).toEqual(["켜진 계정"]);
		expect(calls.wakes.map(w => w[1])).toEqual([`th:${on.thread}`, off.target]);
	});

	test("the same mail posted again is a duplicate: nothing emitted, no second thread", async () => {
		const { deps, calls } = fakes(true);
		const input = { source: "zele", id: uid("dup"), subject: "다시" };
		const [a, b] = await Promise.all([postMail(input, deps), postMail(input, deps)]);
		const c = await postMail(input, deps);
		expect(a.duplicate).toBeUndefined();
		expect(b.duplicate).toBe(true);
		expect(c).toMatchObject({ key: a.key, thread: a.thread, duplicate: true });
		expect(calls.threads).toHaveLength(1);
		expect(calls.events).toHaveLength(1);
	});

	test("invalid input is refused before anything happens", async () => {
		const { deps, calls } = fakes(true);
		for (const bad of [null, "x", { id: "1", subject: "s" }, { source: "a", subject: "s" }, { source: "a", id: "1" }, { source: "a", id: "1", subject: " " }, { source: "a", id: "1", subject: "s", thread: "abc" }, { source: "a", id: "1", subject: "s", wake: "yes" }, { source: 3, id: "1", subject: "s" }])
			await expect(postMail(bad, deps)).rejects.toBeInstanceOf(MailError);
		expect(calls.events).toEqual([]);
		expect(calls.threads).toEqual([]);
	});

	test("body and summary are capped", async () => {
		const { deps, calls } = fakes(false);
		await postMail({ source: "zele", id: uid("cap"), subject: "긴 메일", summary: "s".repeat(5000), body: "b".repeat(30000) }, deps);
		const text = String(calls.events[0]!.text);
		expect(text).toContain("s".repeat(2000));
		expect(text).not.toContain("s".repeat(2001));
		expect(text).toContain("b".repeat(20000));
		expect(text).not.toContain("b".repeat(20001));
	});

	test("wake: one orchestrator turn, answered in the thread when there is one, else in the web conversation", async () => {
		const on = fakes(true);
		const r1 = await postMail({ source: "zele", id: uid("k"), subject: "깨우기", wake: true }, on.deps);
		expect(on.calls.wakes.map(([, t]) => t)).toEqual([`th:${r1.thread}`]);
		expect(on.calls.wakes[0]![0]).toBe(on.calls.events[0]);
		const off = fakes(false);
		const r2 = await postMail({ source: "zele", id: uid("k"), subject: "깨우기", wake: true }, off.deps);
		expect(off.calls.wakes.map(([, t]) => t)).toEqual([r2.target]);
		const quiet = fakes(false);
		await postMail({ source: "kdb", id: uid("k"), subject: "조용히" }, quiet.deps);
		expect(quiet.calls.wakes).toEqual([]);
	});

	test("offerDraft: called once for a new mail with its key, target, thread and body; never for the duplicate; a throw does not break postMail", async () => {
		const { deps, calls } = fakes(true);
		const offers: Record<string, any>[] = [];
		deps.offerDraft = m => void offers.push(m);
		const input = { source: "zele", id: uid("o"), subject: "회의 일정 문의", from: "kim@example.com", body: "목요일 가능할까요?" };
		const a = await postMail(input, deps);
		await postMail(input, deps);
		expect(offers).toHaveLength(1);
		expect(offers[0]).toMatchObject({ key: a.key, target: a.target, thread: a.thread, source: "zele", id: input.id, subject: "회의 일정 문의", from: "kim@example.com", body: "목요일 가능할까요?" });
		expect(calls.events).toHaveLength(1);
		deps.offerDraft = () => {
			throw new Error("boom");
		};
		const r = await postMail({ source: "zele", id: uid("o"), subject: "던짐" }, deps);
		expect(r.duplicate).toBeUndefined();
		expect(mailByKey(r.key)).toBeDefined();
		expect(calls.events).toHaveLength(2);
	});

	test("a suggested reply draft is kept on the mail record and can be cleared; an unknown mail takes none", async () => {
		const { deps } = fakes(false);
		const r = await postMail({ source: "zele", id: uid("sg"), subject: "회의 일정 문의", from: "kim@example.com" }, deps);
		expect(setMailSuggest(r.key, { kind: "reply-draft", label: "답장 초안", ref: "RABC234" })).toBe(true);
		expect(mailByKey(r.key)?.suggest).toEqual({ kind: "reply-draft", label: "답장 초안", ref: "RABC234" });
		expect(mailByKey(r.key)?.subject).toBe("회의 일정 문의");
		expect(setMailSuggest(r.key, undefined)).toBe(true);
		expect(mailByKey(r.key)?.suggest).toBeUndefined();
		expect(setMailSuggest("zele-nope-unknown", { kind: "reply-draft", label: "답장 초안", ref: "RX" })).toBe(false);
	});

	test("a thread that cannot be opened leaves the mail web-only", async () => {
		const { deps, calls } = fakes(true);
		deps.createThread = async () => {
			throw new Error("discord down");
		};
		const r = await postMail({ source: "zele", id: uid("f"), subject: "실패" }, deps);
		expect(r.thread).toBeUndefined();
		expect(calls.events).toHaveLength(1);
	});
});

describe("mail conversation identity", () => {
	test("a send to a mail's thread carries its conversation; other threads do not", () => {
		const mailOf = (t: string) => (t === "77" ? "mail:zele-x" : undefined);
		const e = outEvent({ ts: "x", kind: "out", source: "orchestrator", target: "th:77", text: "답" }, () => undefined, mailOf);
		expect(e.conv).toBe("mail:zele-x");
		expect(eventTarget(e as HubEvent)).toBe("mail:zele-x");
		expect(outEvent({ ts: "x", kind: "out", source: "orchestrator", target: "th:78", text: "답" }, () => undefined, mailOf)).not.toHaveProperty("conv");
	});
	test("a web-only answer, its delivery state and an inbound thread message all land in the mail conversation", () => {
		expect(eventTarget({ ts: "x", kind: "out", source: "orchestrator", target: "mail:zele-x", text: "답" })).toBe("mail:zele-x");
		expect(eventTarget({ ts: "x", kind: "delivery", source: "gateway", target: "mail:zele-x", text: "" })).toBe("mail:zele-x");
		expect(eventTarget({ ts: "x", kind: "message", source: "discord", channel: "th:77", conv: "mail:zele-x", parent: "ch:5", text: "ㅇㅇ" })).toBe("mail:zele-x");
	});
});

describe("a mail posted without a summary", () => {
	const from = "Alex Sender <sender@example.com>";
	test("mailBriefOf: the 요약 lines (max 3), else the original's first lines; never the sender or the subject", () => {
		const both = [`${from} · 월간 점검`, "", "요약", "- 점검이 끝났어요.", "- 결과 확인이 필요해요.", "- 금요일까지 회신해 주세요.", "- 네 번째는 버려요.", "", "할 일", "- 회신", "", "원문", "안녕하세요."].join("\n");
		expect(mailBriefOf(both, from, "월간 점검")).toBe("점검이 끝났어요.\n결과 확인이 필요해요.\n금요일까지 회신해 주세요.");
		const orig = [`${from} · 월간 점검`, "", "원문", "월간 점검", "Alex Sender", "첫 줄입니다.", "둘째 줄입니다."].join("\n");
		expect(mailBriefOf(orig, from, "월간 점검")).toBe("첫 줄입니다.\n둘째 줄입니다.");
		expect(mailBriefOf(`${from} · 월간 점검`, from, "월간 점검")).toBe("");
		expect(mailBriefOf("요약\n월간 점검\n\n원문\n본문입니다.", from, "월간 점검")).toBe("본문입니다.");
	});

	test("the first conversation message with text sets summary once; the owner's words and a header-only mail event do not", async () => {
		const { deps } = fakes(false);
		const id = uid("b");
		const r = await postMail({ source: "plug", id, subject: "월간 점검", from }, deps);
		expect(mailByKey(r.key)?.summary).toBeUndefined();
		const at = (n: number) => new Date(Date.UTC(2099, 0, 1, 0, 0, n)).toISOString();
		emit("outbox", { ts: at(1), kind: "mail", source: "plug", channel: r.target, conv: r.target, mail: r.key, subject: "월간 점검", from, text: `${from} · 월간 점검` });
		emit("inbox", { ts: at(2), kind: "message", source: "web", channel: r.target, text: "요약\n- 내가 쓴 말" });
		expect(mailByKey(r.key)?.summary).toBeUndefined();
		emit("outbox", { ts: at(3), kind: "out", source: "orchestrator", target: r.target, text: `${from} · 월간 점검\n\n요약\n- 점검이 끝났어요.\n- 확인이 필요해요.\n\n원문\n본문입니다.` });
		expect(mailByKey(r.key)?.summary).toBe("점검이 끝났어요.\n확인이 필요해요.");
		emit("outbox", { ts: at(4), kind: "out", source: "orchestrator", target: r.target, text: "요약\n- 나중 말" });
		expect(mailByKey(r.key)?.summary).toBe("점검이 끝났어요.\n확인이 필요해요.");
	});

	test("a conversation with neither a 요약 section nor an original leaves the mail without a summary", async () => {
		const { deps } = fakes(false);
		const r = await postMail({ source: "plug", id: uid("n"), subject: "본문 없는 메일", from }, deps);
		emit("outbox", { ts: "2099-01-01T01:00:00.000Z", kind: "out", source: "orchestrator", target: r.target, text: `${from} · 본문 없는 메일` });
		expect(mailByKey(r.key)?.summary).toBeUndefined();
	});
});

test("a source that reports the sender by a cut-off name only: the mail is recorded with the address its own text names", async () => {
	const { deps } = fakes(false);
	const id = uid("nm");
	const r = await postMail({ source: "plug", id, subject: "Re: 자료", from: "Myungwoo Lee (KR - A", to: "me@corp.example", body: "감사합니다.\nMyungwoo Lee (KR)\nEmail: myungwoo.lee@pwc.com" }, deps);
	expect(mailByKey(r.key)!.from).toBe("Myungwoo Lee <myungwoo.lee@pwc.com>");
	const html = await postMail({ source: "plug", id: uid("nh"), subject: "Re: 자료", from: "Myungwoo Lee (KR - A", html: "<p>보낸 사람: Myungwoo Lee (KR - Assurance) &lt;myungwoo.lee@pwc.com&gt;</p>" }, deps);
	expect(mailByKey(html.key)!.from).toBe("Myungwoo Lee <myungwoo.lee@pwc.com>");
	const none = await postMail({ source: "plug", id: uid("nn"), subject: "Re: 자료", from: "Myungwoo Lee (KR - A", body: "주소 없음" }, deps);
	expect(mailByKey(none.key)!.from).toBe("Myungwoo Lee (KR - A");
});

describe("a repeat post completes the record", () => {
	const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64");
	test("받는 사람 / 참조, an address-less sender and the body's pictures fill in; nothing else changes and nothing is posted again", async () => {
		const { deps, calls } = fakes(false);
		let offered: { attachments?: { name: string }[] } | undefined;
		deps.offerDraft = m => void (offered = m);
		const id = uid("rep");
		await postMail({ source: "zele", id, subject: "견적", from: "Lee (KR - A", html: "<p>본문</p><img src=\"cid:pic-1\">", body: "본문" }, deps);
		const key = mailKey("zele", id), before = mailByKey(key)!;
		expect([before.to, before.cc, before.attachments]).toEqual([undefined, undefined, undefined]);
		const events = calls.events.length;
		const html = "<p>본문</p><img src=\"cid:pic-1\">";
		const r = await postMail({ source: "zele", id, subject: "견적", from: "\"Lee (KR - ASR)\" <lee@example.com>", to: "kim@example.com", cc: "\"Park\" <park@example.com>", html, body: "본문",
			attachments: [{ name: "image.png", type: "image/png", data: PNG, cid: "pic-1" }, { name: "견적서.pdf", data: PNG }] }, deps);
		expect(r.duplicate).toBe(true);
		const after = mailByKey(key)!;
		expect([after.from, after.to, after.cc]).toEqual(["\"Lee (KR - ASR)\" <lee@example.com>", "kim@example.com", "\"Park\" <park@example.com>"]);
		// only the body's picture is added (a real file of a known mail is not this path's business); it is marked inline and drawn in place
		expect(attachmentList(after)).toEqual([{ name: "image.png", type: "image/png", size: Buffer.from(PNG, "base64").length, inline: true }]);
		expect(after.reply).toBe(before.reply);
		expect(calls.events.length).toBe(events);
		const body = await (await import("./mail.ts")).mailBodyRoute(key).text();
		expect(body).toContain(`src="/api/mail/${key}/files/0"`);
		// a second repeat changes nothing more
		await postMail({ source: "zele", id, subject: "견적", from: "x <x@example.com>", to: "y@example.com", html, attachments: [{ name: "image.png", data: PNG, cid: "pic-1" }] }, deps);
		expect(mailByKey(key)).toEqual(after);
		expect(offered).toBeDefined();
	});
	test("a new mail's body pictures are inline and are not offered to the reply draft as files", async () => {
		const { deps } = fakes(false);
		let offered: { attachments?: { name: string }[] } | undefined;
		deps.offerDraft = m => void (offered = m);
		const id = uid("pic");
		await postMail({ source: "zele", id, subject: "그림", from: "a@example.com", html: "<img src=\"cid:p2\">", attachments: [{ name: "logo.png", data: PNG, cid: "p2" }, { name: "자료.xlsx", data: PNG }, { name: "unused.png", data: PNG, cid: "not-in-body" }] }, deps);
		expect(attachmentList(mailByKey(mailKey("zele", id))!).map(a => [a.name, !!a.inline])).toEqual([["logo.png", true], ["자료.xlsx", false], ["unused.png", false]]);
		expect(offered?.attachments?.map(a => a.name)).toEqual(["자료.xlsx", "unused.png"]);
	});
});
