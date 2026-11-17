// A result turn runs at the effort its work was spawned at; the owner's turns run at the current effort.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEffortBound } from "./effort-bound.ts";
import { en } from "../hub/i18n-en.ts";
import { ko } from "../hub/i18n-ko.ts";
import recording from "./fixtures/omp-wake.json";

const ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// `has`: the levels the session's model has. OmO sets the nearest one for a level it lacks (the next higher, else the next lower) and
// says nothing when that changes nothing (agent-session _setThinkingLevel, _clampThinkingLevel).
function orchestrator(level: string, has?: string[], opts: { select?: boolean } = {}) {
	const handlers: Record<string, ((event: any) => any)[]> = {};
	const switches: string[] = [];
	const hookOptions: Record<string, unknown> = {};
	let current = level;
	const fire = (name: string, event: any = {}) => (handlers[name] ?? []).forEach(fn => fn(event));
	const pi = {
		on: (name: string, fn: (event: any) => any, options?: unknown) => {
			(handlers[name] ??= []).push(fn);
			if (options) hookOptions[name] = options;
		},
		getThinkingLevel: () => current,
		setThinkingLevel: (l: string) => {
			const previousLevel = current;
			if (has && !has.includes(l)) l = ALL.slice(ALL.indexOf(l)).find(x => has.includes(x)) ?? ALL.slice(0, ALL.indexOf(l)).findLast(x => has.includes(x)) ?? l;
			if (has && l === previousLevel) return;
			switches.push(l);
			current = l;
			if (opts.select !== false) fire("thinking_level_select", { level: l, previousLevel });
		},
	};
	const file = join(mkdtempSync(join(tmpdir(), "effort-bound-")), "effort-bound.json");
	installEffortBound(pi, file);
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
	return { spawn, ownerSwitch, turn, wake, fire, switches, hookOptions, file, level: () => current };
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

// why(protocol): fixtures/omp-wake.json holds what omp@18.22.0 fired for its main agent in rpc mode, recorded from a real run: a background task spawned with the session at high, the session switched to low over RPC set_thinking_level while it ran, then the wake, which fires agent_start, context, turn_start, message_start and before_provider_request, with no before_agent_start and no thinking_level_select
type Step = { name: string; event: any };
const recorded: { spawn: Step[]; wake: Step[] } = recording;
const copyOf = (steps: Step[], name: string) => structuredClone(steps.find(s => s.name === name)!.event);

function ompSession(level: string, has?: string[]) {
	const o = orchestrator(level, has, { select: false });
	const spawn = (...ids: string[]) => {
		const event = copyOf(recorded.spawn, "tool_result");
		event.details.progress = ids.map((id, index) => ({ ...event.details.progress[0], index, id }));
		event.details.async.jobId = ids[0];
		o.fire("tool_result", event);
	};
	const delivered = (...jobs: (string | object)[]) => {
		const message = copyOf(recorded.wake, "message_start").message;
		message.details.jobs = jobs.map(job => (typeof job === "string" ? { ...message.details.jobs[0], jobId: job, agentId: job, label: job } : job));
		return message;
	};
	const start = () => o.fire("agent_start", copyOf(recorded.wake, "agent_start"));
	const request = (...tail: object[]) => {
		o.fire("context", { messages: [{ role: "toolResult" }, { role: "assistant" }, ...tail] });
		return o.level();
	};
	const end = () => o.fire("agent_end", copyOf(recorded.wake, "agent_end"));
	const wake = (...jobs: (string | object)[]) => {
		start();
		const at = request(delivered(...jobs));
		end();
		return at;
	};
	const replay = (steps: Step[]) => {
		const at: string[] = [];
		for (const step of steps) {
			o.fire(step.name, structuredClone(step.event));
			if (step.name === "before_provider_request") at.push(o.level());
		}
		return at;
	};
	return { ...o, spawn, delivered, start, request, end, wake, replay };
}

test("omp, replayed from the recording: a task spawned at high and the owner at low while it ran: the wake turn's request goes out at high, and the session is at low again when the turn ends", () => {
	expect(recorded.wake.map(s => s.name)).not.toContain("before_agent_start");
	const o = ompSession("high");
	expect(o.replay(recorded.spawn)).toEqual(["high"]);
	o.ownerSwitch("low");
	expect(o.replay(recorded.wake)).toEqual(["high"]);
	expect(o.level()).toBe("low");
	expect(o.switches).toEqual(["low", "high", "low"]);
	expect(o.hookOptions.context).toEqual({ mutatesMessages: false });
});

test("omp: every agent of a batch is recorded, and each result runs at the level its batch was spawned at", () => {
	const o = ompSession("medium");
	o.spawn("Alpha", "Beta");
	o.ownerSwitch("xhigh");
	expect(o.wake("Beta")).toBe("medium");
	expect(o.level()).toBe("xhigh");
	expect(o.wake("Alpha")).toBe("medium");
	expect(o.level()).toBe("xhigh");
});

function lowThenMedium() {
	const o = ompSession("low");
	o.spawn("Low");
	o.ownerSwitch("medium");
	o.spawn("Mid");
	o.ownerSwitch("xhigh");
	return o;
}

test("omp: two results in one message run at the highest of their levels", () => {
	const o = lowThenMedium();
	expect(o.wake("Low", "Mid")).toBe("medium");
	expect(o.level()).toBe("xhigh");
});

test("omp: two results delivered as separate messages run at the highest of their levels", () => {
	const o = lowThenMedium();
	o.start();
	expect(o.request(o.delivered("Low"), o.delivered("Mid"))).toBe("medium");
	o.end();
	expect(o.level()).toBe("xhigh");
});

test("omp: a result that arrives while a turn runs joins that turn at its level, and its record is used up", () => {
	const o = ompSession("high");
	o.spawn("Alpha");
	o.ownerSwitch("medium");
	o.spawn("Beta");
	o.ownerSwitch("low");
	o.start();
	expect(o.request(o.delivered("Alpha"))).toBe("high");
	o.fire("context", { messages: [{ role: "assistant" }, o.delivered("Beta")] });
	expect(o.level()).toBe("high");
	o.end();
	expect(o.level()).toBe("low");
	expect(o.wake("Beta")).toBe("low");
	expect(o.switches).toEqual(["medium", "low", "high", "low"]);
});

test("omp: a job nobody recorded, a shell job, a result already used up and a context without messages change nothing", () => {
	const o = ompSession("high");
	o.spawn("Alpha");
	o.ownerSwitch("low");
	const shell = { jobId: "bg_1", type: "bash", status: "completed", label: "sleep 5; echo shell-done", durationMs: 5049 };
	expect(o.wake("Ghost")).toBe("low");
	expect(o.wake(shell)).toBe("low");
	expect(o.wake("Alpha")).toBe("high");
	expect(o.wake("Alpha")).toBe("low");
	o.start();
	o.fire("context", {});
	o.fire("context", { messages: [null, 3] });
	o.end();
	expect(o.switches).toEqual(["low", "high", "low"]);
});

test("omp: the owner's switch during the wake turn is the level the session goes back to", () => {
	const o = ompSession("high");
	o.spawn("Alpha");
	o.ownerSwitch("low");
	o.start();
	expect(o.request(o.delivered("Alpha"))).toBe("high");
	o.ownerSwitch("medium");
	o.end();
	expect(o.level()).toBe("medium");
	expect(o.switches).toEqual(["low", "high", "medium"]);
});

test("omp: a recorded level equal to the current one makes no switch call", () => {
	const o = ompSession("medium");
	o.spawn("Alpha");
	expect(o.wake("Alpha")).toBe("medium");
	expect(o.switches).toEqual([]);
});

test("omp: a deep-marked prompt that starts the same run as a wake keeps xhigh, and the session goes back to its own level", () => {
	const o = ompSession("low");
	o.spawn("Alpha");
	o.ownerSwitch("medium");
	o.fire("before_agent_start", { prompt: deepPrompt("어려운 질문"), trigger: "prompt" });
	expect(o.level()).toBe("xhigh");
	o.start();
	expect(o.request(o.delivered("Alpha"))).toBe("xhigh");
	o.end();
	expect(o.level()).toBe("medium");
	expect(o.switches).toEqual(["medium", "xhigh", "medium"]);
});

test("omp: the oldest record past the cap is forgotten", () => {
	const o = ompSession("high");
	for (let i = 0; i <= 100; i++) o.spawn(`job${i}`);
	o.ownerSwitch("low");
	expect(o.wake("job0")).toBe("low");
	expect(o.wake("job100")).toBe("high");
});

test("omp records stay in memory, while an OmO id still goes to the file", () => {
	const o = ompSession("high");
	o.spawn("Alpha");
	expect(existsSync(o.file)).toBe(false);
	o.fire("tool_result", { toolName: "task", isError: false, input: {}, content: [{ type: "text", text: "Spawned st_01a1jjjj in background." }] });
	expect(existsSync(o.file)).toBe(true);
});

test("the context hook leaves OmO's wake, which arrives as prompt text, to before_agent_start", () => {
	const o = orchestrator("xhigh");
	o.spawn("st_01a1kkkk");
	o.ownerSwitch("medium");
	o.fire("agent_start");
	o.fire("context", { messages: [{ role: "assistant" }, { role: "custom", customType: "omo-senpi:wake", content: [{ type: "text", text: o.wake("st_01a1kkkk") }] }] });
	expect(o.level()).toBe("medium");
	expect(o.turn(o.wake("st_01a1kkkk"))).toBe("xhigh");
});

test("omp: on a model without the recorded level the wake turn runs at the nearest level it has, and the session still goes back", () => {
	const o = ompSession("xhigh", ["off", "low", "medium", "high", "max"]);
	o.spawn("Alpha");
	o.ownerSwitch("medium");
	expect(o.wake("Alpha")).toBe("max");
	expect(o.level()).toBe("medium");
	expect(o.switches).toEqual(["medium", "max", "medium"]);
});

test("omp: a result recorded above xhigh beats the deep marker on the run they start together", () => {
	const o = ompSession("max");
	o.spawn("Alpha");
	o.ownerSwitch("medium");
	o.fire("before_agent_start", { prompt: deepPrompt("어려운 질문"), trigger: "prompt" });
	o.start();
	expect(o.request(o.delivered("Alpha"))).toBe("max");
	o.end();
	expect(o.level()).toBe("medium");
	expect(o.switches).toEqual(["medium", "xhigh", "max", "medium"]);
});
