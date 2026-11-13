import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { activateFleetLaunch, createFleetLaunch } from "./fleet-launch.ts";
import type { Computer, FleetRow } from "./fleet.ts";
import { msg } from "./i18n.ts";
import { flush } from "./intake.ts";
import { makeRoute } from "./routes.ts";
import { setUpdateNow, type UpdateNow } from "./update-now.ts";

// POST /api/message `computer` (the web's computer chip): the main chat's next turn carries one machine line naming the computer the owner picked,
// so the orchestrator starts the new work there. A name that is this computer or not in the list adds nothing; other conversations never get it.
const env = setupEnv();
afterAll(env.cleanup);

const computers = async (): Promise<Computer[]> => [
	{ name: "맥미니", url: "https://a.example.test", self: true },
	{ name: "맥북", url: "https://b.example.test", self: false },
	{ name: "서버", url: "https://c.example.test", self: false, public: true },
];
activateFleetLaunch(createFleetLaunch({ name: () => "맥미니", fleet: async () => [] as FleetRow[], computers }));

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const post = (body: object) => route(new Request("http://hub.test/api/message", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));

// What the real intake path hands the bot: the update hold keeps the prompt text instead of starting a turn.
const held: string[] = [];
beforeEach(() => {
	held.length = 0;
	setUpdateNow({ hold: (text: string) => (held.push(text), true), holding: () => false } as unknown as UpdateNow);
});
afterEach(() => setUpdateNow(undefined));

const turn = async (body: object): Promise<string> => {
	expect((await post(body)).status).toBe(200);
	flush("web");
	expect(held).toHaveLength(1);
	return held[0]!;
};

test("a picked computer puts one launch line into the main chat's turn", async () => {
	const text = await turn({ text: "문서 정리해 줘", computer: "맥북" });
	expect(text).toContain("문서 정리해 줘");
	expect(text).toContain(msg().fleetPicked("맥북"));
});

test("this computer's own name, an unknown name and a public-address row add nothing", async () => {
	for (const computer of ["맥미니", "없는 컴퓨터", "서버", 7, ""]) {
		held.length = 0;
		const text = await turn({ text: "문서 정리해 줘", computer });
		expect(text).toContain("문서 정리해 줘");
		expect(text).not.toContain(msg().fleetPicked("맥북"));
		expect(text).not.toContain("computer=");
	}
});

test("a conversation other than the main chat ignores the pick", async () => {
	const r = await post({ text: "이 일은 여기서", computer: "맥북", conv: "alert" });
	expect(r.status).toBe(200);
	flush("web:alert");
	expect(held.join("\n")).not.toContain(msg().fleetPicked("맥북"));
});
