import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { claimSend } from "./draft-claim.ts";
import { resetSendsBootForTest, sender, settleSends } from "./reply-wire.ts";
import { createDraft } from "./kakao/send.ts";
import { kakaoPaths } from "./kakao/types.ts";

const kpaths = kakaoPaths(DATA_DIR);
const CONV = "kakao:restart-test";
const JOBS = join(DATA_DIR, "approval-sends.json");
const job = (ref: string) => ({ ref, conv: CONV, action: "send", title: `카톡 답장 보낼까요? (${ref})`, state: "sending" });
const make = async (text: string) => (await createDraft({ chatId: "r-restart", roomName: "친구", text, basisLogId: "1" }, { paths: kpaths })).code;
const patch = (code: string, change: Record<string, unknown>) => {
	const list = JSON.parse(readFileSync(kpaths.drafts, "utf8")) as { code: string }[];
	writeFileSync(kpaths.drafts, JSON.stringify(list.map(d => (d.code === code ? { ...d, ...change } : d))));
};
const seen = (ref: string) => sender.results(CONV).find(r => r.ref === ref);
afterAll(resetSendsBootForTest);

test("a KakaoTalk send that was running at a restart: sent is sent, pressed-but-unconfirmed is unsure, a live sender is still sending", async () => {
	const done = await make("보냈어요");
	patch(done, { status: "sent", sentAt: new Date().toISOString() });
	const unsure = await make("확인 안 됨");
	patch(unsure, { status: "sent", unconfirmed: true, sentAt: new Date().toISOString() });
	const live = await make("보내는 중");
	const release = claimSend(join(dirname(kpaths.drafts), "sending", live));
	mkdirSync(dirname(JOBS), { recursive: true });
	writeFileSync(JOBS, JSON.stringify([job(done), job(unsure), job(live)]));

	settleSends();
	await sender.idle();

	release?.();
	expect(seen(done)?.state).toBe("sent");
	expect(seen(unsure)).toMatchObject({ state: "unsure" });
	expect(seen(unsure)?.text).toContain("확인하지 못했어요");
	expect(seen(live)?.state).toBe("sending");
});
