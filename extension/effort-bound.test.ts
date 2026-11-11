// A result turn runs at the effort its work was spawned at; the owner's turns run at the current effort.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEffortBound } from "./effort-bound.ts";
import { en } from "../hub/i18n-en.ts";
import { ko } from "../hub/i18n-ko.ts";

function orchestrator(level: string) {
	const handlers: Record<string, ((event: any) => any)[]> = {};
	const switches: string[] = [];
	let current = level;
	const fire = (name: string, event: any = {}) => (handlers[name] ?? []).forEach(fn => fn(event));
	const pi = {
		on: (name: string, fn: (event: any) => any) => (handlers[name] ??= []).push(fn),
		getThinkingLevel: () => current,
		setThinkingLevel: (l: string) => {
			const previousLevel = current;
			switches.push(l);
			current = l;
			fire("thinking_level_select", { level: l, previousLevel });
		},
	};
	installEffortBound(pi, join(mkdtempSync(join(tmpdir(), "effort-bound-")), "effort-bound.json"));
	const spawn = (id: string) => fire("tool_result", { toolName: "task", isError: false, input: {}, content: [{ type: "text", text: `Spawned ${id} in background.` }] });
	// The gateway applies the owner's effort change between turns (hub/orchestrator.ts switchInPlace -> set_thinking_level).
	const ownerSwitch = (l: string) => pi.setThinkingLevel(l);
	// A turn: the level its model request is sent at.
	const turn = (prompt: string) => {
		fire("before_agent_start", { prompt, trigger: "prompt" });
		const at = current;
		fire("agent_end", { messages: [] });
		return at;
	};
	const wake = (id: string) => `task completion name:job id:${id} category:deep-low status:completed result:"done"`;
	return { spawn, ownerSwitch, turn, wake, fire, switches, level: () => current };
}

test("a worker spawned at xhigh, then a switch to medium: its completion turn runs at xhigh and the next owner turn at medium", () => {
	const o = orchestrator("xhigh");
	o.spawn("st_01a1aaaa");
	o.ownerSwitch("medium");
	expect(o.turn(o.wake("st_01a1aaaa"))).toBe("xhigh");
	expect(o.level()).toBe("medium");
	expect(o.turn("[dotz inbox] web from owner\nnext question")).toBe("medium");
});

test("a worker spawned at medium completes at medium while the session runs at xhigh", () => {
	const o = orchestrator("medium");
	o.spawn("st_01a1bbbb");
	o.ownerSwitch("xhigh");
	expect(o.turn(o.wake("st_01a1bbbb"))).toBe("medium");
	expect(o.level()).toBe("xhigh");
});

test("an owner message after the switch runs at the current effort with no switch call", () => {
	const o = orchestrator("xhigh");
	o.spawn("st_01a1cccc");
	o.ownerSwitch("medium");
	const before = o.switches.length;
	expect(o.turn("[dotz inbox] web from owner\n이거 해줘")).toBe("medium");
	expect(o.switches.length).toBe(before);
});

test("a recorded effort equal to the current one makes no switch call", () => {
	const o = orchestrator("medium");
	o.spawn("st_01a1dddd");
	expect(o.turn(o.wake("st_01a1dddd"))).toBe("medium");
	expect(o.switches).toEqual([]);
});

test("a lane launched at xhigh reports into an xhigh turn after a switch to medium; several results take the highest", () => {
	const o = orchestrator("xhigh");
	o.fire("tool_result", { toolName: "dotz_lane", isError: false, input: { action: "launch", title: "빌드 점검" }, content: [{ type: "text", text: JSON.stringify({ ok: true, lane: "build-check", channel: "lane:build-check" }) }] });
	o.ownerSwitch("medium");
	o.spawn("st_01a1eeee");
	expect(o.turn(`${en.inboxLaneReport("build-check")}\nall green`)).toBe("xhigh");
	expect(o.level()).toBe("medium");
	o.spawn("st_01a1ffff");
	expect(o.turn(`${o.wake("st_01a1eeee")}\n${o.wake("st_01a1ffff")}`)).toBe("medium");
});

test("the owner's switch made during a result turn is the level the session goes back to", () => {
	const o = orchestrator("xhigh");
	o.spawn("st_01a1gggg");
	o.ownerSwitch("medium");
	o.fire("before_agent_start", { prompt: o.wake("st_01a1gggg"), trigger: "extension" });
	expect(o.level()).toBe("xhigh");
	o.ownerSwitch("high");
	o.fire("agent_end", { messages: [] });
	expect(o.level()).toBe("high");
});

test("a lane report in Korean is matched too", () => {
	const o = orchestrator("xhigh");
	o.fire("tool_result", { toolName: "dotz_lane", isError: false, input: { action: "send", name: "build-check" }, content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
	o.ownerSwitch("medium");
	expect(o.turn(`${ko.inboxLaneReport("build-check")}\n끝`)).toBe("xhigh");
});
