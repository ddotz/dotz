import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, getDraft, setStatus, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { createEngine } from "./comments/engine.ts";
import { realMailLink } from "./comments/mail-link.ts";
import { commentAdapter } from "./comments/reply-adapter.ts";
import { commentsDir } from "./comments/store.ts";
import { approvalHash, createApprovalSender, type SendResult } from "./approval-send.ts";
import { createReplyActions, type ActCtx, type ActInput } from "./reply-actions.ts";
import { mailAdapter } from "./reply-mail.ts";

const dir = mkdtempSync(join(tmpdir(), "replypair-"));
const before = process.env.DOTZ_DIR;
process.env.DOTZ_DIR = dir;
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});
beforeEach(() => {
	rmSync(join(dir, "custom"), { recursive: true, force: true });
	mkdirSync(join(dir, "custom", "reply-drafts"), { recursive: true });
	writeFileSync(join(dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true }));
});

const mailRec = (id: string): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", account: "me@example.net", mailId: id, ref: "k", to: "kim@example.com", subject: "Re: x", body: "본문", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: "Kim <kim@example.com>", text: "hi", subject: "x" } }) as unknown as DraftRec;

async function postedWithFailedMail(mailId: string, sendMail: (id: string) => Promise<{ ok: boolean; text: string }>, postedAt: number) {
	const cdir = commentsDir(dir);
	mkdirSync(cdir, { recursive: true });
	const source = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
	writeFileSync(join(cdir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const raw = { native: "c1", thread: "p1", author: "팬", text: "자료 보내주세요", postTitle: "P", at: postedAt - 1000 };
	const mail = { compose: async () => ({ ok: false as const, reason: "x" }), send: sendMail, drop: () => undefined, revise: async () => ({ ok: false as const, reason: "x" }), view: (id: string) => (getDraft(id)?.status === "pending" ? { id, to: "kim@example.com", subject: "자료", body: "보내드려요", attachments: [] } : undefined), edit: () => ({ ok: true as const }) };
	const platform = { kind: "youtube", list: async () => ({ comments: [raw], cursor: "1" }), reply: async () => ({ ok: true as const, ref: "r1" }), posts: async () => [] };
	const engine = createEngine({ dir: cdir, now: () => postedAt, collector: "mac", adapters: { youtube: platform } as never, model: async () => ({ text: "" }), mail: mail as never, learn: () => undefined, style: () => ({ rules: [], corrections: [], forbidden: [], samples: [] }) } as never);
	await engine.collect();
	const c = engine.store.comments()[0]!;
	engine.store.putDraft({ code: "DPOST0001", commentId: c.id, source: "youtube", thread: "p1", text: "자료는 메일로 보내드렸어요", status: "pending", created: postedAt, changes: [], clean: true, notes: [], mail: mailId, mailAt: postedAt } as never);
	const sent = engine.send("DPOST0001", { by: "owner" });
	if (!sent.ok) throw new Error(JSON.stringify(sent));
	await sent.done;
	return engine;
}

test("a comment reply posted whose mail failed leaves the mail as a waiting row of its own, and the reply's row says the mail is still owed", async () => {
	for (const [postedAt, expected] of [[Date.now(), ["comment:DPOST0001:sent", "mail:RPAIRM1:pending"]], [Date.now() - 3 * 86_400_000, ["mail:RPAIRM1:pending"]]] as const) {
		rmSync(join(dir, "custom"), { recursive: true, force: true });
		mkdirSync(join(dir, "custom", "reply-drafts"), { recursive: true });
		writeFileSync(join(dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true }));
		addDraft(mailRec("RPAIRM1"));
		const engine = await postedWithFailedMail("RPAIRM1", async () => ({ ok: false, text: "smtp 거부" }), postedAt);
		const rows = [...(await commentAdapter(engine).list()), ...(await mailAdapter().list())].map(v => `${v.kind}:${v.ref}:${v.draft.state}`);
		expect(rows).toEqual(expected);
		expect((await commentAdapter(engine).get("DPOST0001"))?.mailLeft).toBe(true);
	}
});

test("a comment reply posted together with its mail is one row, the reply's; the mail is not a row of its own", async () => {
	addDraft(mailRec("RPAIRM2"));
	const engine = await postedWithFailedMail("RPAIRM2", async () => {
		setStatus("RPAIRM2", "sent");
		return { ok: true, text: "" };
	}, Date.now());
	const rows = [...(await commentAdapter(engine).list()), ...(await mailAdapter().list())].map(v => `${v.kind}:${v.ref}:${v.draft.state}`);
	expect(rows).toEqual(["comment:DPOST0001:sent"]);
	expect((await commentAdapter(engine).get("DPOST0001"))?.mailLeft).toBeUndefined();
});

const owner: ActCtx = { surface: "web", login: "me" };
const MAIL = "RMAILC1";
const REPLY = "DPOST0001";
type MailOut = { ok: boolean; message: string; sent: "yes" | "no" | "maybe"; code?: string };
const line = (sent: string, part: string, code?: string) => `DOTZ_SEND ${JSON.stringify({ sent, ...(code ? { code } : {}), part })}`;

async function world(mailOut: MailOut, kept?: { store: { load: () => unknown[]; save: (body: string) => void }; reports: SendResult[] }) {
	const cdir = commentsDir(dir);
	mkdirSync(cdir, { recursive: true });
	const source = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
	writeFileSync(join(cdir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const at = Date.now();
	const raw = { native: "c1", thread: "p1", author: "팬", text: "자료 보내주세요", postTitle: "P", at: at - 1000 };
	let posts = 0;
	const platform = { kind: "youtube", list: async () => ({ comments: [raw], cursor: "1" }), reply: async () => (posts++, { ok: true as const, ref: "r1" }), posts: async () => [] };
	const mail = realMailLink({ run: async () => ({ code: 1, stdout: "", stderr: "" }), send: async () => mailOut as never } as never);
	const engine = createEngine({ dir: cdir, now: () => at, collector: "mac", adapters: { youtube: platform } as never, model: async () => ({ text: "" }), mail: mail as never, learn: () => undefined, style: () => ({ rules: [], corrections: [], forbidden: [], samples: [] }) } as never);
	await engine.collect();
	const c = engine.store.comments()[0]!;
	addDraft(mailRec(MAIL));
	engine.store.putDraft({ code: REPLY, commentId: c.id, source: "youtube", thread: "p1", text: "자료는 메일로 보내드렸어요", status: "pending", created: at, changes: [], clean: true, notes: [], mail: MAIL, mailAt: at } as never);
	const commentAd = commentAdapter(engine), mailAd = mailAdapter();
	const adapters = [mailAd, commentAd];
	const argvs: string[][] = [];
	const sender = createApprovalSender({
		kind: ref => adapters.map(a => a.target(ref)).find(Boolean),
		fingerprint: async ref => {
			for (const a of adapters) {
				const v = await a.get(ref);
				if (v) return approvalHash(v);
			}
			return undefined;
		},
		prove: async j => (await commentAd.prove?.(j.ref)) ?? "unknown",
		run: async argv => {
			argvs.push(argv);
			const ref = argv[3]!;
			if (getDraft(ref)?.kind === "mail") {
				setStatus(ref, "sent");
				return { code: 0, out: line("yes", "mail") };
			}
			const r = engine.send(ref, { by: "owner" });
			if (!r.ok) return { code: 1, out: line("no", "reply", r.code) };
			const done = await r.done;
			if (done.state !== "sent") return { code: 1, out: line("no", "reply", "unknown") };
			if (done.mail?.state === "failed") return { code: 1, out: `${line("yes", "reply")}\n${line(mailOut.sent, "mail", mailOut.code)}` };
			return { code: 0, out: line("yes", "reply") };
		},
		report: r => void kept?.reports.push(r),
		log: () => undefined,
		undoMs: () => 0,
		after: () => undefined,
		...(kept ? { store: kept.store } : {}),
	});
	const acts = createReplyActions({
		adapters,
		sender,
		recordPick: () => undefined,
		recordText: () => undefined,
		learning: { record: async () => ({ kind: "correction" as const, stored: true, replaced: [] }), refine: async () => undefined, forbid: async () => undefined },
		cards: { open: () => [], convOf: () => undefined, replace: () => undefined, rewrite: () => undefined, repost: async () => undefined, close: () => undefined },
		toBot: async () => undefined,
		emit: () => undefined,
		log: () => undefined,
	});
	const act = (ref: string, action: string, extra: Partial<ActInput> = {}) => acts.act({ ref, action, ...extra } as ActInput, owner);
	const hash = async (ref: string) => (await acts.list()).find(i => i.ref === ref)!.draft.hash;
	const rows = async () => (await acts.list()).map(i => `${i.kind}:${i.ref}:${i.draft.state}:${i.send?.state ?? "-"}`);
	const post = async (ref: string) => {
		await act(ref, "send", { hash: await hash(ref) });
		await sender.idle();
	};
	return { engine, acts, act, sender, argvs, rows, hash, post, posts: () => posts };
}

const FAILED: MailOut = { ok: false, message: "첨부 확인", sent: "no", code: "attach_mismatch" };
const UNSURE: MailOut = { ok: false, message: "timeout", sent: "maybe", code: "unknown" };

test("a reply posted whose mail came back unsure: the read-back that marks the reply's send sent leaves the mail a waiting row that 보내기 sends alone", async () => {
	const w = await world(UNSURE);
	await w.post(REPLY);
	expect(await w.rows()).toEqual([`mail:${MAIL}:pending:-`, `comment:${REPLY}:sent:unsure`]);
	w.sender.recheck();
	for (let i = 0; i < 50 && w.sender.results().findLast(r => r.ref === REPLY)?.state !== "sent"; i++) await Promise.resolve();
	expect(w.sender.results().findLast(r => r.ref === REPLY)?.state).toBe("sent");
	const rows = await w.acts.list();
	expect(rows.map(i => `${i.kind}:${i.ref}:${i.draft.state}:${i.send?.state ?? "-"}`)).toEqual([`mail:${MAIL}:pending:-`, `comment:${REPLY}:sent:sent`]);
	expect(rows.find(i => i.ref === MAIL)?.can.send).toBe(true);
	w.argvs.length = 0;
	expect((await w.act(MAIL, "send", { hash: await w.hash(MAIL) })).status).toBe(200);
	await w.sender.idle();
	expect(w.argvs.map(a => a[3])).toEqual([MAIL]);
	expect(getDraft(MAIL)?.status).toBe("sent");
	expect(w.posts()).toBe(1);
	expect((await w.rows()).filter(r => r.includes("pending"))).toEqual([]);
});

test("a reply posted whose mail failed: its row shows the failure with no buttons, the mail row sends the mail alone, and the failed record leaves with it", async () => {
	const w = await world(FAILED);
	await w.post(REPLY);
	expect(await w.rows()).toEqual([`mail:${MAIL}:pending:-`, `comment:${REPLY}:sent:failed`]);
	const reply = (await w.acts.list()).find(i => i.ref === REPLY)!;
	expect(reply.send).toMatchObject({ state: "failed", actions: [] });
	expect(reply.can).toMatchObject({ send: false, edit: false, revise: false, drop: false });
	for (const action of ["send", "retry", "edit", "drop"]) expect((await w.act(REPLY, action, { text: "고침", hash: reply.draft.hash })).status).toBe(409);
	expect(w.argvs).toHaveLength(1);
	expect(w.posts()).toBe(1);
	expect((await w.act(MAIL, "send", { hash: await w.hash(MAIL) })).status).toBe(200);
	await w.sender.idle();
	expect(w.argvs.map(a => a[3])).toEqual([REPLY, MAIL]);
	expect(w.posts()).toBe(1);
	expect(getDraft(MAIL)?.status).toBe("sent");
	expect(await w.acts.settleOwed()).toBe(1);
	expect((await w.rows()).filter(r => r.includes("failed"))).toEqual([]);
	const after = await w.acts.list();
	expect(after.find(i => i.ref === REPLY)!.draft.mail).toBeUndefined();
	expect(after.find(i => i.ref === MAIL)?.send?.state).toBe("sent");
});

test("보내지 않기 on the waiting mail of a posted reply drops the mail draft: it is no row, cannot be sent by its ref, and the reply's owed record goes", async () => {
	const w = await world(UNSURE);
	await w.post(REPLY);
	expect((await w.act(MAIL, "drop", { hash: await w.hash(MAIL) })).status).toBe(200);
	expect(getDraft(MAIL)?.status).toBe("dropped");
	expect((await w.rows()).filter(r => r.startsWith("mail:") && r.includes("pending"))).toEqual([]);
	w.argvs.length = 0;
	expect((await w.act(MAIL, "send", { hash: "0" })).status).toBe(409);
	expect(w.argvs).toEqual([]);
	await w.acts.list();
	expect(await w.acts.settleOwed()).toBe(1);
	expect(w.sender.results().filter(r => r.ref === REPLY)).toEqual([]);
});

test("나갔어요 on the unsure row of a posted reply clears that record and nothing else: the mail draft is not marked sent and still waits", async () => {
	const w = await world(UNSURE);
	await w.post(REPLY);
	expect((await w.act(REPLY, "resolve", { as: "sent" })).status).toBe(200);
	expect(w.sender.results().filter(r => r.ref === REPLY)).toEqual([]);
	expect(getDraft(MAIL)?.status).toBe("pending");
	expect(await w.rows()).toContain(`mail:${MAIL}:pending:-`);
});

test("나갔어요 on an unsure mail whose draft was closed elsewhere (dropped, stale, answered) clears the record and does not turn the draft into a sent one", async () => {
	for (const closed of ["dropped", "stale", "answered"] as const) {
		rmSync(commentsDir(dir), { recursive: true, force: true });
		const id = `RX${closed.slice(0, 3).toUpperCase()}`;
		addDraft(mailRec(id));
		const sender = createApprovalSender({
			kind: ref => (getDraft(ref) ? { kind: "mail", lane: "m" } : undefined),
			fingerprint: async ref => {
				const v = await mailAdapter().get(ref);
				return v && approvalHash(v);
			},
			run: async () => ({ code: 1, out: line("maybe", "mail", "unknown") }),
			report: () => undefined,
			log: () => undefined,
			undoMs: () => 0,
			after: () => undefined,
		});
		const acts = createReplyActions({
			adapters: [mailAdapter()],
			sender,
			recordPick: () => undefined,
			recordText: () => undefined,
			learning: { record: async () => ({ kind: "correction" as const, stored: true, replaced: [] }), refine: async () => undefined, forbid: async () => undefined },
			cards: { open: () => [], convOf: () => undefined, replace: () => undefined, rewrite: () => undefined, repost: async () => undefined, close: () => undefined },
			toBot: async () => undefined,
			emit: () => undefined,
			log: () => undefined,
		});
		const view = (await mailAdapter().get(id))!;
		await acts.act({ ref: id, action: "send", hash: approvalHash(view) }, owner);
		await sender.idle();
		setStatus(id, closed);
		expect((await acts.act({ ref: id, action: "resolve", as: "sent" }, owner)).status).toBe(200);
		expect(getDraft(id)?.status).toBe(closed);
		expect(sender.results().filter(r => r.ref === id)).toEqual([]);
		const retry = await acts.act({ ref: id, action: "resolve", as: "retry", hash: approvalHash((await mailAdapter().get(id))!) }, owner);
		expect(retry.status).toBe(409);
	}
});

test("LV-2 a comment draft dropped through the comment engine's own path leaves a failed job: a restart tells nothing, one settle pass removes the job and no note goes out", async () => {
	const body = { box: JSON.stringify([{ ref: REPLY, conv: "youtube", action: "send", title: `이 답글 올릴까요? (${REPLY})`, state: "failed", reason: { code: "rejected", text: "앱에서 이 글을 받지 않았어요" }, safeToAuto: false, attempts: 3 }]) };
	const reports: SendResult[] = [];
	const store = { load: () => JSON.parse(body.box) as unknown[], save: (b: string) => void (body.box = b) };
	const w = await world(FAILED, { store, reports });
	w.sender.recover();
	expect(await w.rows()).toEqual([`comment:${REPLY}:pending:failed`]);
	expect(w.engine.drop(REPLY).ok).toBe(true);
	expect(await w.acts.settleOwed()).toBe(1);
	expect(w.sender.results().filter(r => r.ref === REPLY)).toEqual([]);
	expect(JSON.parse(body.box)).toEqual([]);
	expect(reports).toEqual([]);
});
