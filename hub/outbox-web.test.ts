import { afterAll, expect, test } from "bun:test";
import { advanceTimers, ev, fakeHub, inbox, json, on, run } from "./test-web.ts";

// A message sent while the gateway cannot be reached waits as a dimmed bubble and goes out by itself, once. The stub keeps no memory of ids (a gateway that restarted),
// so only the page's own check of the history can keep a message whose answer was lost from going out twice.
type Mode = "ok" | "down" | "lose" | "refuse";
let mode: Mode = "ok";
const stored: { ts: string; kind: string; source: string; target: string; mid: string; text: string }[] = [];
const posts = inbox<{ cid: string; text: string; reply_to?: string }>();
const checks = inbox<number>();

const hub = fakeHub({
	slowTimers: true,
	api: async (req, url) => {
		if (url.pathname === "/api/message" && req.method === "POST") {
			const b = (await req.json()) as { cid: string; text: string; reply_to?: string };
			posts.push(b);
			if (mode === "down") return new Response("bad gateway", { status: 502 });
			if (mode === "refuse") return json({ error: "text required" }, 400);
			stored.push({ ts: new Date().toISOString(), kind: "message", source: "web", target: "web", mid: `m${stored.length}`, text: b.text });
			return mode === "lose" ? new Response("bad gateway", { status: 502 }) : json({ ok: true });
		}
		if (url.pathname === "/api/history") {
			if (url.searchParams.has("after")) checks.push(1);
			return json({ target: "main", events: stored });
		}
		return undefined;
	},
});
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);

const look = () => ev<{ bubbles: string[]; toasts: number; box: string }>(view, `({
	bubbles: [...tl.querySelectorAll(".qd .ub")].map(n => n.textContent),
	toasts: document.querySelectorAll(".snack").length,
	box: ta.value,
})`);
const send = (text: string) => run(view, `ta.value = ${JSON.stringify(text)}; sendChat()`);

async function ready() {
	mode = "ok"; stored.length = 0; posts.length = 0; checks.length = 0;
	await view.navigate(`${hub.origin}/`);
	await run(view, `localStorage.removeItem("dotz.outbox")`);
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof sendChat === "function" && S && typeof openTarget === "function"`);
	await run(view, `openTarget("main", "chat")`);
	await waitFor(`everConnected`);
}

test("a send during an outage shows the pending bubble and no toast, and goes out once when the gateway answers", async () => {
	await ready();
	mode = "down";
	await send("내일 오전 회의 자료를 정리해 주세요");
	await posts.until(a => a.length >= 1);
	await waitFor(`tl.querySelector(".qd")`);
	expect(await look()).toEqual({ bubbles: ["내일 오전 회의 자료를 정리해 주세요"], toasts: 0, box: "" });
	mode = "ok";
	await advanceTimers(view, 2_000);
	await posts.until(a => a.length >= 2);
	await waitFor(`!tl.querySelector(".qd")`);
	expect(stored.map(m => m.text)).toEqual(["내일 오전 회의 자료를 정리해 주세요"]);
	expect(posts[1]!.cid).toBe(posts[0]!.cid);
	expect((await look()).toasts).toBe(0);
}, 40_000);

test("the gateway stored the message but the answer was lost: after recovery the gateway holds exactly one copy", async () => {
	await ready();
	mode = "lose";
	await send("사진 두 장을 메일로 보내 주세요");
	await posts.until(a => a.length >= 1);
	await waitFor(`tl.querySelector(".qd")`);
	expect(stored.length).toBe(1);
	mode = "ok";
	await advanceTimers(view, 2_000);
	await checks.until(a => a.length >= 1, 8000, "history read before any resend");
	await waitFor(`!tl.querySelector(".qd")`);
	expect(posts.length).toBe(1);
	expect(stored.length).toBe(1);
	expect((await look()).toasts).toBe(0);
}, 40_000);

test("a reload while a message waits keeps it, and it goes out once when the stream attaches", async () => {
	await ready();
	mode = "down";
	await send("점심 약속은 열두 시 반이에요");
	await posts.until(a => a.length >= 1);
	await waitFor(`OUTBOX.length === 1`);
	mode = "ok";
	await view.navigate(`${hub.origin}/`);
	await posts.until(a => a.length >= 2, 8000, "sent at the first attach");
	await waitFor(`OUTBOX.length === 0`);
	expect(stored.map(m => m.text)).toEqual(["점심 약속은 열두 시 반이에요"]);
}, 40_000);

test("an answer to a decision card sent during an outage waits the same way", async () => {
	await ready();
	mode = "down";
	await run(view, `answerDecision({ t: "main", key: "k1", blocks: [{ title: "진행할까요?", options: [] }], at: "2026-11-10T01:00:00.000Z", question: "진행할까요?" }, "1) 진행해 주세요", null)`);
	await posts.until(a => a.length >= 1);
	await waitFor(`tl.querySelector(".qd")`);
	expect(await look()).toEqual({ bubbles: ["1) 진행해 주세요"], toasts: 0, box: "" });
	mode = "ok";
	await advanceTimers(view, 2_000);
	await posts.until(a => a.length >= 2);
	await waitFor(`!tl.querySelector(".qd")`);
	expect(stored.length).toBe(1);
	expect(posts[1]!.reply_to).toBe("2026-11-10T01:00:00.000Z");
}, 40_000);

test("a refusal from a reachable gateway stays an error and the text goes back to the box", async () => {
	await ready();
	mode = "refuse";
	await send("   보낼 말");
	await waitFor(`document.querySelectorAll(".snack").length === 1`);
	expect(await look()).toEqual({ bubbles: [], toasts: 1, box: "보낼 말" });
	expect(posts.length).toBe(1);
}, 40_000);
