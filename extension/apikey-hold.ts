// A process running on an API-key fallback entry (hub/fallback.ts keyEnv) starts no task workers and no sessions (owner
// 2026-10-21: the API key is for the orchestrator's own answers only; heavy work waits until the subscription's limit resets,
// and dotz moves the orchestrator back to the subscription in a fresh conversation then).
export const API_KEY_HOLD =
	"dotz: you are on the API-key fallback (the subscription hit its usage limit). Task subagents and sessions (dotz_lane launch/send/handover/verify) do not run on the API key. Answer and do light work yourself; put heavier work in state.json open_tasks and tell the owner it starts when the subscription resets (dotz then moves you back in a fresh conversation).";
const HELD_LANE_ACTIONS = new Set(["launch", "send", "handover", "verify"]);
let held = false;
export const onApiKey = (): boolean => held;

export function holdWorkOnApiKey(pi: any): void {
	held = true;
	pi.on("before_subagent_spawn", () => ({ block: true, reason: API_KEY_HOLD }));
	pi.on("tool_call", (event: any) => (event?.toolName === "task" ? { block: true, reason: API_KEY_HOLD } : undefined));
}

export const laneHeld = (action: string): string | undefined => (held && HELD_LANE_ACTIONS.has(action) ? API_KEY_HOLD : undefined);
