// The work-channel list goes into the inbox text once per turn: a message joining a running turn whose prompt already carries it leaves it out.
import { expect, test } from "bun:test";

import { inboxText } from "./intake.ts";
import { convs } from "./convsessions.ts";
import * as discord from "./discord.ts";
import { msg } from "./i18n.ts";

discord.channels.work = { "100000000000000001": "alpha", "100000000000000002": "beta" };
const LIST = msg().workChannels(["#alpha ch:100000000000000001", "#beta ch:100000000000000002"]);
const ev = (text: string) => ({ kind: "message", source: "web", channel: "web", mid: `m-${text}`, author: "owner", text });

type State = { status: "idle" | "working"; current?: string };
const state: State = { status: "idle" };
convs.setMain({ key: "main", o: { onOwnerCancel: () => {}, orch: { get status() { return state.status; } } }, queue: { current: () => (state.current === undefined ? undefined : { text: state.current }) } } as unknown as Parameters<typeof convs.setMain>[0]);

test("a message that opens a turn carries the work-channel list", () => {
	state.status = "idle";
	state.current = undefined;
	expect(inboxText(ev("first"))).toContain(LIST);
});

test("a message joining a running turn whose prompt already carries the list leaves it out", () => {
	state.status = "working";
	state.current = inboxText(ev("opening"));
	expect(state.current).toContain(LIST);
	expect(inboxText(ev("joins"))).not.toContain(LIST);
});

test("a running turn whose prompt lacks the list (or a changed list) gets it", () => {
	state.status = "working";
	state.current = "[dotz lane report] something else";
	expect(inboxText(ev("other"))).toContain(LIST);
});
