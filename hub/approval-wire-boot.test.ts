import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { commentSettleSending } from "./comments/gateway.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { sender, settleSends } from "./approval-wire.ts";
import { addDraft, claimFile, newId, setStatus } from "../features/reply-drafts/lib/store.ts";

const draft = () => {
	const id = newId();
	addDraft({ id, kind: "mail", app: "mail", source: "nowhere", mailId: `m-${id}`, ref: `ab-${id.toLowerCase()}`, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", text: "", from: "" } } as never);
	return id;
};
const job = (ref: string, state: "queued" | "sending") => ({ ref, conv: "mail:ab-test", action: "send", title: `답장 보낼까요? (${ref})`, state });

test("on boot the file's jobs are taken up: a running one is judged and never re-run, a queued one runs again, a sent draft is marked sent", async () => {
	const lost = draft(), queued = draft(), done = draft();
	setStatus(done, "sent");
	const gone = Bun.spawn([process.execPath, "-e", "0"]);
	await gone.exited;
	mkdirSync(dirname(claimFile(lost)), { recursive: true });
	writeFileSync(claimFile(lost), String(gone.pid));
	writeFileSync(join(DATA_DIR, "approval-sends.json"), JSON.stringify([job(lost, "sending"), job(queued, "queued"), job(done, "sending")]));

	settleSends();
	await sender.idle();
	const state = (ref: string) => sender.results().find(r => r.ref === ref);
	expect(state(lost)).toMatchObject({ state: "failed" });
	expect(state(lost)!.text).toContain("나갔을 수");
	expect(state(done)).toMatchObject({ state: "sent" });
	expect(state(queued)).toMatchObject({ state: "failed" });
	expect(state(queued)!.text).not.toContain("나갔을 수");
	// Failed sends stay in the file until they are resolved, so a restart forgets none; the sent one leaves it.
	const kept = (JSON.parse(await Bun.file(join(DATA_DIR, "approval-sends.json")).text()) as { ref: string; state: string }[]).map(k => `${k.ref}:${k.state}`).sort();
	expect(kept).toEqual([`${lost}:failed`, `${queued}:failed`].sort());
});

test("a comment reply left sending by the run that stopped ends unsure, visible, and is not sent again by itself", () => {
	const store = createStore(commentsDir(DATA_DIR));
	store.putReply({ id: "send:cm:a:1", commentId: "cm:a:1", source: "a", thread: "p", text: "답", state: "sending", at: 1, draft: "D9", via: "owner", collector: "x" });
	expect(commentSettleSending()).toBe(1);
	expect(store.replies().find(r => r.id === "send:cm:a:1")).toMatchObject({ state: "unsure" });
	expect(commentSettleSending()).toBe(0);
});
