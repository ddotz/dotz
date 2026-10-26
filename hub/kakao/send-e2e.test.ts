// End to end with fakes: a new KakaoTalk message -> `cli.ts draft --chat <id>` (the approval block) -> the owner's pick 1) 보내기 ->
// `cli.ts send --draft <code>` -> the one Accessibility send of the fake KakaoTalk screen (ui.fixture.ts). The CLI runs with the real
// send.ts; only the screen, the database reader and the gateway are fakes. Nothing reaches KakaoTalk.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDraftApproval } from "../draft-approval.ts";
import { type Ctx, type DraftsApi, type Reader, run } from "./cli.ts";
import { atomicWrite } from "./onboard.ts";
import { createDraft, draftBlock, forgetWarm, listDrafts, sendDraft } from "./send.ts";
import { kakaoPaths, type Msg, type Room, type Runner } from "./types.ts";
import { type FakeRow, fakeScreen } from "./ui.fixture.ts";

const ROOM: Room = { chatId: "101", name: "스터디방", type: 0, kind: "direct", unread: 1, lastAt: 0 };
const IN: Msg = { logId: "9007199254740901", chatId: "101", authorId: "2001", sender: "Alex", text: "내일 7시 괜찮아?", type: 1, sentAt: 1_700_000_060, fromMe: false };
const rows: FakeRow[] = [{ id: "chat_스터디방", title: "스터디방", window: { title: "스터디방" } }];

let root: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kk-e2e-"));
	paths = kakaoPaths(join(root, "data"), join(root, "home"));
	mkdirSync(join(root, "data", "kakao"), { recursive: true });
	atomicWrite(paths.config, JSON.stringify({ enabled: true, userId: 1000 }));
	forgetWarm();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cli(screen: ReturnType<typeof fakeScreen>, stdin = "") {
	const out: string[] = [];
	const hub: { path: string; body?: unknown }[] = [];
	const reader: Reader = { rooms: async () => [ROOM], messages: async () => [IN], draftable: () => true };
	const deps = { paths, runner: screen.runner };
	const drafts: DraftsApi = { create: input => createDraft(input, deps), block: draftBlock, send: (code, extra) => sendDraft(code, { ...deps, ...extra }) };
	const unused = async () => {
		throw new Error("unexpected call");
	};
	const ctx = {
		paths,
		runner: screen.runner,
		hub: { post: async (path: string, body?: unknown) => (hub.push({ path, body }), { status: 200, json: {} }), get: unused, patch: unused, del: unused },
		ports: {} as Ctx["ports"],
		out: (l: string) => void out.push(l),
		stdin: async () => stdin,
		repo: "",
		execPath: "",
		brew: "",
		spawnSetup: () => {},
		reader: async () => reader,
		drafts: async () => drafts,
		sleep: async () => {},
		now: () => 0,
		pid: 1,
		isAlive: () => false,
	} as Ctx;
	return { ctx, out, hub };
}

const pick = (code: string, label = "보내기") =>
	appendFileSync(paths.inbox, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: `1) ${label}`, picks: [{ q: `카톡 답장 보낼까요? (${code})`, n: 1, label }] })}\n`);

async function drafted(): Promise<string> {
	const c = cli(fakeScreen(rows), "응 7시에 봐");
	expect(await run(["draft", "--chat", "101"], c.ctx)).toBe(0);
	const card = parseDraftApproval(c.out[0]!);
	expect(card).toMatchObject({ toLabel: "대화방", to: "스터디방", body: "응 7시에 봐" });
	return card!.ref!;
}

describe("kakao: new message -> draft -> 1) 보내기 -> sent by the app screen", () => {
	test("the pick sends once into the checked room, the owner is told and the follow-up is woken; a replayed answer sends nothing", async () => {
		const code = await drafted();
		const screen = fakeScreen(rows);
		const first = cli(screen);
		expect(await run(["send", "--draft", code], first.ctx)).toBe(1);
		expect(first.out).toEqual(["보내지 않았어요: 아직 보내도 된다는 답을 받지 못했어요"]);
		expect(screen.sends).toEqual([]);
		pick(code);
		const ok = cli(screen);
		expect(await run(["send", "--draft", code], ok.ctx)).toBe(0);
		expect(ok.out).toEqual(["보냈어요"]);
		expect(screen.sends).toEqual([["ax-send", "스터디방", "응 7시에 봐"]]);
		expect(ok.hub.map(h => h.path)).toEqual(["/api/followup"]);
		expect((await listDrafts({ paths, runner: screen.runner }))[0]!.status).toBe("sent");
		pick(code);
		const again = cli(screen);
		expect(await run(["send", "--draft", code], again.ctx)).toBe(1);
		expect(again.out[0]).toContain("이미 보낸 초안이에요");
		expect(screen.sends).toHaveLength(1);
	});

	test("a room that cannot be opened is a failed send with its reason; the draft stays and the same approval sends later", async () => {
		const code = await drafted();
		pick(code);
		const broken = fakeScreen(rows, { openFail: { step: "row", why: "not_found" } });
		const failed = cli(broken);
		expect(await run(["send", "--draft", code], failed.ctx)).toBe(1);
		expect(failed.out[0]!.startsWith("보내지 않았어요: ")).toBe(true);
		expect(broken.sends).toEqual([]);
		expect((await listDrafts({ paths, runner: broken.runner }))[0]!.status).toBe("pending");
		const fixed = fakeScreen(rows);
		expect(await run(["send", "--draft", code], cli(fixed).ctx)).toBe(0);
		expect(fixed.sends).toHaveLength(1);
	});

	test("a press whose send is not confirmed is never sent again, even with the approval still standing", async () => {
		const code = await drafted();
		pick(code);
		const unclear = fakeScreen(rows, { axSend: () => ({ ok: false, why: "unclear", pressed: true }) });
		const first = cli(unclear);
		expect(await run(["send", "--draft", code], first.ctx)).toBe(1);
		expect(first.out[0]).toContain("확인하지 못했어요");
		const retry = fakeScreen(rows);
		const second = cli(retry);
		expect(await run(["send", "--draft", code], second.ctx)).toBe(1);
		expect(second.out[0]).toContain("카카오톡에서 확인해 주세요");
		expect(retry.sends).toEqual([]);
	});

	test("a second process sending the same approved draft while the first is still sending sends nothing", async () => {
		const code = await drafted();
		pick(code);
		const script = `
			import { sendDraft } from ${JSON.stringify(join(import.meta.dir, "send.ts"))};
			import { kakaoPaths } from ${JSON.stringify(join(import.meta.dir, "types.ts"))};
			import { fakeScreen } from ${JSON.stringify(join(import.meta.dir, "ui.fixture.ts"))};
			const s = fakeScreen(${JSON.stringify(rows)});
			const runner = async (argv, o) => {
				const before = s.sends.length;
				const r = await s.runner(argv, o);
				if (s.sends.length > before) {
					console.log("READY");
					for await (const _ of console) break;
				}
				return r;
			};
			const r = await sendDraft(${JSON.stringify(code)}, { paths: kakaoPaths(${JSON.stringify(join(root, "data"))}, ${JSON.stringify(join(root, "home"))}), runner, latestIncoming: async () => ${JSON.stringify(IN.logId)} });
			console.log(JSON.stringify({ r, sends: s.sends.length }));
		`;
		const a = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
		const reader = a.stdout.getReader();
		let seen = "";
		while (!seen.includes("READY\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`the first sender ended early: ${seen}`);
			seen += new TextDecoder().decode(chunk.value);
		}
		const other = fakeScreen(rows);
		const b = await sendDraft(code, { paths, runner: other.runner as Runner, latestIncoming: async () => IN.logId });
		a.stdin.write("go\n");
		a.stdin.end();
		let rest = "";
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			rest += new TextDecoder().decode(chunk.value);
		}
		await a.exited;
		expect(JSON.parse(rest.trim().split("\n").at(-1)!)).toEqual({ r: expect.objectContaining({ ok: true }), sends: 1 });
		expect(b.ok).toBe(false);
		expect(other.sends).toEqual([]);
		expect((await listDrafts({ paths, runner: other.runner }))[0]!.status).toBe("sent");
	});
});
