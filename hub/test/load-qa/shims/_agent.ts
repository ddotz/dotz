// Fake omo / omp / senpi: the one binary every model call of the gateway goes through. It speaks the two protocols the
// gateway uses (hub/runtime/omp.ts and hub/model-runner.ts):
//   --mode rpc  JSONL frames on stdin (prompt, steer, new_session, get_state, ...), event frames on stdout; the orchestrator,
//               lanes, conversation sessions (--extension given) and the warm one-shot runners (--no-tools) all use it.
//   -p --mode json  one one-shot call, the reply as a message_end event.
// Each prompt is recorded in model-calls.jsonl and answered with a canned valid reply after $LOAD_QA_MODEL_LATENCY_MS.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { begin, estTokens, modelLatencyMs, recordModel } from "./_lib.ts";

type Turn = { kind: string; reply: string };

const flat = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

const DRAFT_REPLY = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "load-qa canned draft", to: "", body: "안녕하세요. 메일 잘 받았습니다. 확인하고 다시 연락드리겠습니다.", questions: [] })}\n\`\`\``;
const SUMMARY_REPLY = "메일 내용을 확인하라는 안내예요.\n**이번 주 안에 회신**해 주세요.";

// The kind of a one-shot or warm call comes from its system prompt; unknown prompts are "other" and keep their head in `item`.
function classify(system: string, text: string): Turn {
	if (system.startsWith("You draft ONE reply")) return { kind: "draft", reply: DRAFT_REPLY };
	if (system.startsWith("You summarize one email")) return { kind: "summary", reply: SUMMARY_REPLY };
	if (system.startsWith("You translate")) return { kind: "translate", reply: text };
	if (/\brules?\b/i.test(system.slice(0, 200))) return { kind: "rule-match", reply: "none" };
	return { kind: "other", reply: "확인했어요." };
}

// Orchestrator and lane turns: an owner message gets a visible answer, keepalives "ok", every other wake (mail, schedule, report) the silent "-".
function classifyAgent(role: string, text: string): Turn {
	if (text.startsWith("[keepalive]")) return { kind: role, reply: "ok" };
	return { kind: role, reply: text.includes("[dotz inbox]") ? "확인했어요." : "-" };
}

async function answer(turn: Turn, system: string, text: string, item: string): Promise<{ text: string; usage: object }> {
	const input = estTokens(system) + estTokens(text);
	const output = estTokens(turn.reply);
	recordModel({ kind: turn.kind, chars_in: system.length + text.length, est_tokens: input, item: flat(item, 120) });
	const wait = modelLatencyMs();
	if (wait) await Bun.sleep(wait);
	return { text: turn.reply, usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
}

const assistant = (text: string, usage: object) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage });
const emit = (frame: object): void => void process.stdout.write(`${JSON.stringify(frame)}\n`);

export async function agent(tool: string, argv: string[]): Promise<void> {
	begin(tool, argv);
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (argv[0] === "host") return void (argv.includes("--json") && console.log("{}"));
	if (argv.includes("--version") || argv[0] === "version") return void console.log("0.0.0-load-qa");
	if (argv[0] === "models") return void console.log("[]");
	const system = flag("--system-prompt") ?? "";
	if (argv.includes("-p")) {
		const text = argv.at(-1) ?? "";
		const done = await answer(classify(system, text), system, text, text);
		return emit({ type: "message_end", message: assistant(done.text, done.usage) });
	}
	if (flag("--mode") !== "rpc") {
		console.error(`${tool}: ${argv.join(" ")}: not supported by the load-qa shim`);
		process.exit(1);
	}
	const role = argv.includes("--extension") ? (process.env.DOTZ_LANE ? "lane" : "orchestrator") : undefined;
	const note = flag("--append-system-prompt") ?? system;
	const session = join(process.env.LOAD_QA_RUN ?? tmpdir(), `fake-session-${process.pid}.jsonl`);
	let context = 0;
	const prompt = async (id: string, command: string, text: string): Promise<void> => {
		emit({ type: "response", id, command, success: true });
		emit({ type: "agent_start" });
		emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
		const turn = role ? classifyAgent(role, text) : classify(system, text);
		const done = await answer(turn, role ? "" : system, text, text);
		context += (done.usage as { input: number }).input;
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta" } });
		emit({ type: "message_end", message: assistant(done.text, done.usage) });
		emit({ type: "agent_end" });
	};
	const state = () => ({ sessionFile: session, contextUsage: { tokens: context + estTokens(note), contextWindow: 200_000 } });
	let queue: Promise<void> = Promise.resolve();
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of Bun.stdin.stream()) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			let f: { id?: string; type?: string; message?: string };
			try {
				f = JSON.parse(line);
			} catch {
				continue;
			}
			const id = String(f.id ?? "");
			if (f.type === "prompt" || f.type === "steer") queue = queue.then(() => prompt(id, f.type!, f.message ?? ""));
			else {
				const data = f.type === "get_state" || f.type === "get_session_stats" ? state() : f.type === "compact" ? { tokensBefore: context } : undefined;
				if (f.type === "new_session" || f.type === "compact") context = 0;
				queue = queue.then(() => emit({ type: "response", id, command: f.type, success: true, ...(data ? { data } : {}) }));
			}
		}
	}
	await queue;
}
