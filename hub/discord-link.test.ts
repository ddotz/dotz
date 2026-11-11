// The "웹에서 보기" button of a Discord message: a decision or an alert carries it, an ordinary message does not, and the address is the one
// hub/messenger.ts uses (hub/weblink.ts convPath), so a target the web has no chat route for gets no button. The link holds no token.
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as discord from "./discord.ts";
import { setWebBase } from "./weblink.ts";

type Req = { payload: { components?: { components: { label?: string; url?: string }[] }[] } };
const requests: Req[] = [];
let server: ReturnType<typeof Bun.serve>;
const ASK = "[ask] 시작 설정\n\n**1) 지금 고치기**\n재부팅 뒤에도 켜져요\n**2) 그대로 두기**\n다음 재부팅까지는 괜찮아요";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			requests.push({ payload: JSON.parse(await req.text()) });
			return Response.json({ id: `m${requests.length}` });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	discord.status.enabled = true;
	discord.channels.work["222"] = "files";
	discord.channels.chat = "444";
	discord.channels.alert = "333";
	discord.channels.worklog = "555";
	setWebBase("https://gw.example");
});
afterAll(() => {
	setWebBase(undefined);
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
});

const linkOf = async (target: string, text: string): Promise<string | undefined> => {
	requests.length = 0;
	expect((await discord.send(target, text)).delivered).toBe(true);
	const buttons = requests.at(-1)!.payload.components?.flatMap(r => r.components) ?? [];
	return buttons.find(b => b.label === "웹에서 보기")?.url;
};

test("a decision and an alert carry the link button, an ordinary message does not, and the link holds no token", async () => {
	expect(await linkOf("chat", ASK)).toBe("https://gw.example/#chat/main");
	expect(await linkOf("ch:222", ASK)).toBe("https://gw.example/#chat/ch:222");
	const alert = await linkOf("alert", "[alert] 디스크가 거의 찼어요");
	expect(alert).toBe("https://gw.example/#chat/alert");
	expect(alert).not.toMatch(/token|[?&]t=/i);
	expect(await linkOf("chat", "[done] 끝났어요")).toBeUndefined();
	expect(await linkOf("ch:222", "[done] 끝났어요")).toBeUndefined();
});

test("an edit asked to refresh buttons carries the card's options now; a plain edit and a closed card leave them alone", async () => {
	const card = `${ASK}\n**3) 이대로 보내기**\n그대로 보내요`;
	const edited = async (opts?: { buttons?: boolean; clearComponents?: boolean }) => {
		requests.length = 0;
		await discord.edit("ch:222", "m1", card, opts);
		return requests.at(-1)!.payload.components?.flatMap(r => r.components).map(b => b.label);
	};
	expect(await edited({ buttons: true })).toEqual(["지금 고치기", "그대로 두기", "이대로 보내기", "웹에서 보기"]);
	expect(await edited()).toBeUndefined();
	expect(await edited({ clearComponents: true })).toEqual([]);
	// Too long to show the options: the buttons it has stay; a lone link button must not replace them.
	requests.length = 0;
	await discord.edit("ch:222", "m1", `${"긴 본문 ".repeat(800)}\n${card}`, { buttons: true });
	expect(requests.at(-1)!.payload.components).toBeUndefined();
});

test("a lane has no web chat route, so its decision gets no button", async () => {
	expect(await linkOf("lane:no-such-lane", ASK)).toBeUndefined();
});
