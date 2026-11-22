import { afterAll, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();
const mailItem = (ref: string, o: Record<string, unknown> = {}) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv: "mail:zele-t1", at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "받는이", to: "fan@example.com", subject: "Re: 자료 요청", text: "자료는 금요일까지 드릴게요.", hash: `${ref}-v1` }, ...o });
const commentItem = (ref: string, o: Record<string, unknown> = {}) => ({ item: `comment:cm:youtube:${ref}`, ref, kind: "comment", app: "youtube", label: "유튜브 댓글", conv: "comment:youtube", at: NOW, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "대상", to: "팬 댓글", text: "주말에 올라가요!", hash: `${ref}-v1` }, original: { who: "팬", text: "다음 편 언제 올라와요?" }, ...o });
const mailCard = (o: Record<string, unknown> = {}) => ({ subject: "자료 요청", from: "Fan <fan@example.com>", to: "Me <me@example.com>", source: "zele", at: AT, summary: "자료를 보내 주실 수 있나요?", reply: "needs", ...o });
let queue: Record<string, unknown>[] = [mailItem("RMAILOPEN")];
let conversations = [{ target: "mail:zele-t1", unread: 0, read: null, mail: mailCard(), last: { ts: AT, text: "자료 요청", from: "bot" } }];
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/reply/queue") return json({ items: queue, counts: {}, triageMin: 3, undoSec: 10 });
		if (url.pathname === "/api/conversations") return json({ items: conversations });
		if (/^\/api\/drafts\/[^/]+\/recipients$/.test(url.pathname)) return json({ to: ["fan@example.com"], cc: [], mode: "reply", editable: true, reply: true });
		if (/^\/api\/drafts\/[^/]+\/files$/.test(url.pathname)) return json({ files: [], canAttach: true, library: false, editable: true, tracked: true, attachIssues: [] });
		return undefined;
	},
});
const view = await hub.view({ width: 1280, height: 900, console: () => undefined });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);
const notice = (ref: string) => ({ id: `n-${ref}`, kind: "decision", title: `이 답장 보낼까요? (${ref})`, ts: new Date(NOW).toISOString(), text: "", decision: { to: "mail:zele-t1", state: "open", options: ["보내기", "고치기", "보내지 않기"].map((label, i) => ({ n: i + 1, label })), draft: { ref, toLabel: "받는이", to: "fan@example.com", subject: "Re: 자료 요청", body: "자료는 금요일까지 드릴게요." } } });
const mount = (node: string) => run(`const box = document.getElementById("ae-test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "ae-test" })); box.replaceChildren(${node})`);
const shown = () => ev<string[]>(`[...document.querySelectorAll("#ae-test [data-k=answered-elsewhere]")].filter(n => !n.hidden).map(n => n.textContent)`);

const streamed = hub.nextStream();
await view.navigate(`${hub.origin}/`);
await streamed;
await waitFor(`typeof draftCardNode === "function" && RA.loaded && MAILS.has("mail:zele-t1")`);

test("CM-13 the mail's reply draft card open when the comment reply lands says 댓글로 이미 답했어요 once its item comes again", async () => {
	await mount(`draftCardNode(${JSON.stringify(notice("RMAILOPEN"))})`);
	await waitFor(`!!document.querySelector("#ae-test .ra-card[data-ref=RMAILOPEN]")`);
	expect(await shown()).toEqual([]);
	hub.push({ kind: "reply", ref: "RMAILOPEN", item: mailItem("RMAILOPEN", { answeredElsewhere: { via: "comment", at: Date.parse(AT) } }) });
	await waitFor(`!!(RA.items.get("RMAILOPEN") || {}).answeredElsewhere`);
	expect(await ev(`!!document.querySelector("#ae-test .ra-card[data-ref=RMAILOPEN]")`)).toBe(true);
	expect(await shown()).toEqual(["댓글로 이미 답했어요"]);
});

test("CM-13 a reply draft card made after the mark says 댓글로 이미 답했어요 from the start", async () => {
	queue = [mailItem("RMAILLATE", { answeredElsewhere: { via: "comment", at: Date.parse(AT) } })];
	await run(`raLoad()`);
	await waitFor(`RA.items.has("RMAILLATE")`);
	await mount(`draftCardNode(${JSON.stringify(notice("RMAILLATE"))})`);
	await waitFor(`!!document.querySelector("#ae-test .ra-card[data-ref=RMAILLATE]")`);
	expect(await shown()).toEqual(["댓글로 이미 답했어요"]);
});

test("CM-13 a comment reply card whose writer's mail was already answered says 메일로 이미 답했어요; one not answered says nothing", async () => {
	queue = [commentItem("DMAILED", { answeredElsewhere: { via: "mail" } }), commentItem("DPLAIN")];
	await run(`raLoad()`);
	await waitFor(`RA.items.has("DMAILED") && RA.items.has("DPLAIN")`);
	await mount(`rqItemCard(RA.items.get("DMAILED"))`);
	expect(await shown()).toEqual(["메일로 이미 답했어요"]);
	await mount(`rqItemCard(RA.items.get("DPLAIN"))`);
	expect(await shown()).toEqual([]);
});

test("CM-13 the marked mail's row in the mail list and its conversation header say 댓글로 이미 답했어요, and an open header follows the mark when it lands", async () => {
	await mount(`mailMetaNode("mail:zele-t1", null)`);
	expect(await shown()).toEqual([]);
	await mount(`monConvNode("mail:zele-t1", "메일")`);
	expect(await shown()).toEqual([]);
	await mount(`mailMetaNode("mail:zele-t1", null)`);
	conversations = [{ ...conversations[0]!, mail: mailCard({ commentReplyAt: AT }) }];
	hub.push({ kind: "mail_unreplied", target: "mail:zele-t1" });
	await waitFor(`!!MAILS.get("mail:zele-t1").commentReplyAt`);
	expect(await shown()).toEqual(["댓글로 이미 답했어요"]);
	await mount(`monConvNode("mail:zele-t1", "메일")`);
	expect(await shown()).toEqual(["댓글로 이미 답했어요"]);
	expect(await ev(`MAILS.get("mail:zele-t1").reply`)).toBe("needs");
});
