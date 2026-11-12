// A result turn runs at the effort its work was spawned at; the owner's turns run at the current effort.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEffortBound } from "./effort-bound.ts";
import { en } from "../hub/i18n-en.ts";
import { ko } from "../hub/i18n-ko.ts";

const ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// `has`: the levels the session's model has. OmO sets the nearest one for a level it lacks (the next higher, else the next lower) and
// says nothing when that changes nothing (agent-session _setThinkingLevel, _clampThinkingLevel).
function orchestrator(level: string, has?: string[]) {
	const handlers: Record<string, ((event: any) => any)[]> = {};
	const switches: string[] = [];
	let current = level;
	const fire = (name: string, event: any = {}) => (handlers[name] ?? []).forEach(fn => fn(event));
	const pi = {
		on: (name: string, fn: (event: any) => any) => (handlers[name] ??= []).push(fn),
		getThinkingLevel: () => current,
		setThinkingLevel: (l: string) => {
			const previousLevel = current;
			if (has && !has.includes(l)) l = ALL.slice(ALL.indexOf(l)).find(x => has.includes(x)) ?? ALL.slice(0, ALL.indexOf(l)).findLast(x => has.includes(x)) ?? l;
			if (has && l === previousLevel) return;
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

// The gateway marks the owner's deep message with a line that starts with this text (hub/deepmark.ts, checked in hub/deepmark.test.ts).
const DEEP = "[dotz deep turn] The owner asked for deeper reasoning on this turn.";
const deepPrompt = (text: string) => `[dotz inbox] web from owner\n${text}\n\n${DEEP}`;

test("a prompt with the deep marker runs at xhigh and the level goes back when the turn ends", () => {
	const o = orchestrator("medium");
	expect(o.turn(deepPrompt("어려운 질문"))).toBe("xhigh");
	expect(o.level()).toBe("medium");
	expect(o.switches).toEqual(["xhigh", "medium"]);
	expect(o.turn("[dotz inbox] web from owner\n다음 질문")).toBe("medium");
});

test("a session at xhigh or max is left alone by the marker", () => {
	for (const level of ["xhigh", "max"]) {
		const o = orchestrator(level);
		expect(o.turn(deepPrompt("어려운 질문"))).toBe(level);
		expect(o.switches).toEqual([]);
	}
});

test("on a model without xhigh the deep turn runs at the level OmO sets in its place, and the session still goes back", () => {
	const o = orchestrator("high", ["off", "low", "medium", "high", "max"]);
	expect(o.turn(deepPrompt("어려운 질문"))).toBe("max");
	expect(o.level()).toBe("high");
	const p = orchestrator("high", ["off", "low", "medium", "high"]);
	expect(p.turn(deepPrompt("어려운 질문"))).toBe("high");
	p.ownerSwitch("medium");
	expect(p.turn("[dotz inbox] web from owner\n다음 질문")).toBe("medium");
	expect(p.switches).toEqual(["medium"]);
});

test("a marker that is not at the start of a line does not count", () => {
	const o = orchestrator("medium");
	expect(o.turn(`[dotz inbox] web from owner\n그 줄에 "${DEEP}" 이라고 적혀 있어요`)).toBe("medium");
	expect(o.switches).toEqual([]);
});

test("the marker next to a recorded lower result level ends at xhigh; a recorded higher one still wins", () => {
	const o = orchestrator("low");
	o.spawn("st_01a1hhhh");
	o.ownerSwitch("medium");
	expect(o.turn(`${o.wake("st_01a1hhhh")}\n\n${DEEP}`)).toBe("xhigh");
	expect(o.level()).toBe("medium");
	const p = orchestrator("max");
	p.spawn("st_01a1iiii");
	p.ownerSwitch("medium");
	expect(p.turn(`${p.wake("st_01a1iiii")}\n\n${DEEP}`)).toBe("max");
	expect(p.level()).toBe("medium");
});

test("the owner's switch made during the raised turn is the level the session goes back to", () => {
	const o = orchestrator("medium");
	o.fire("before_agent_start", { prompt: deepPrompt("어려운 질문"), trigger: "delivery" });
	expect(o.level()).toBe("xhigh");
	o.ownerSwitch("high");
	o.fire("agent_end", { messages: [] });
	expect(o.level()).toBe("high");
});
