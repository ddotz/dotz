import { execFileSync } from "node:child_process";
import { mkdirSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename } from "node:path";
import { deliveryText, livePeers, peersDir, register, resolvePeers, send, takeNew, unregister } from "../harness/peers/bus.ts";
import type { PeerRecord } from "../harness/peers/bus.ts";

const POLL_MS = 2000;

interface Ctx {
	cwd?: string;
	agent?: { kind?: string };
	sessionManager?: { getSessionId?(): string };
	ui?: { notify(text: string, level: "info" | "warning"): void };
}

interface Schema {
	optional(): Schema;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

interface Api {
	zod: { object(shape: Record<string, Schema>): Schema; string(): Schema };
	on(event: "session_start" | "session_switch" | "session_shutdown" | "agent_start", handler: (event: unknown, ctx: Ctx) => void | Promise<void>): void;
	registerTool<P>(tool: { name: string; label: string; description: string; parameters: Schema; execute(id: string, params: P | undefined, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<ToolResult> }): void;
	registerCommand(name: string, command: { description: string; handler(args: unknown, ctx: Ctx): Promise<void> }): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "aside"; triggerTurn: boolean }): void;
	getSessionName?(): string | undefined;
}

/** The running bus of one omp process; `drain` delivers whatever reached this session's inbox now. */
export interface PeerBus {
	drain(): void;
}

const text = (body: string, isError = false): ToolResult => ({ content: [{ type: "text", text: body }], details: {}, ...(isError ? { isError } : {}) });

function repoOf(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Lets the main sessions on this machine message each other: `peer_list`, `peer_send` and `/peer-name`; a message to a session reaches it as an aside that starts a turn when it is idle. */
export default function registerPeerBus(pi: Api): PeerBus {
	const dir = peersDir();
	let self: PeerRecord | undefined;
	let chosenName: string | undefined;
	let watcher: FSWatcher | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;

	const nameFor = (id: string, cwd: string) => chosenName ?? pi.getSessionName?.()?.trim() ?? `${basename(cwd)}-${id.slice(-4)}`;

	const drain = () => {
		if (self === undefined) return;
		for (const message of takeNew(dir, self.id)) {
			pi.sendMessage({ customType: "peer-message", content: deliveryText(message), display: true }, { deliverAs: "aside", triggerTurn: true });
		}
	};

	const stopWatching = () => {
		watcher?.close();
		watcher = undefined;
		clearInterval(poll);
		poll = undefined;
	};

	const leave = () => {
		stopWatching();
		if (self !== undefined) unregister(dir, self.id, process.pid);
		self = undefined;
	};

	const join = (ctx: Ctx) => {
		leave();
		const id = ctx.sessionManager?.getSessionId?.();
		if (ctx.agent?.kind !== "main" || id === undefined) return;
		const cwd = String(ctx.cwd ?? process.cwd());
		self = { id, name: nameFor(id, cwd), cwd, repo: repoOf(cwd), pid: process.pid, startedAt: new Date().toISOString() };
		register(dir, self);
		drain();
		if (process.env.HARNESS_PEERS_WATCH === "0") return;
		mkdirSync(dir, { recursive: true });
		const inbox = `${id}.inbox.jsonl`;
		watcher = watch(dir, (_kind, file) => {
			if (file === inbox) drain();
		});
		poll = setInterval(drain, POLL_MS);
		poll.unref?.();
	};

	const refreshName = () => {
		if (self === undefined) return;
		const name = nameFor(self.id, self.cwd);
		if (name === self.name) return;
		self = { ...self, name };
		register(dir, self);
	};

	pi.on("session_start", (_event, ctx) => join(ctx));
	pi.on("session_switch", (_event, ctx) => join(ctx));
	pi.on("session_shutdown", () => leave());
	pi.on("agent_start", () => refreshName());

	pi.registerTool({
		name: "peer_list",
		label: "Peer sessions",
		description: "List the other live omp main sessions on this machine (name, session id, cwd, whether they share this git repo), to coordinate with them through peer_send.",
		parameters: pi.zod.object({}),
		async execute() {
			if (self === undefined) return text("peer_list: only main sessions take part in peer messaging.", true);
			refreshName();
			const others = livePeers(dir).filter(peer => peer.id !== self?.id);
			if (others.length === 0) return text(`No other live main session. This session is "${self.name}".`);
			return text([`This session is "${self.name}". Other live main sessions:`, ...others.map(peer => `- ${peer.name} (${peer.id}) ${peer.cwd}${peer.repo !== undefined && peer.repo === self?.repo ? " [same repo]" : ""}`)].join("\n"));
		},
	});

	pi.registerTool<{ to?: string; message?: string }>({
		name: "peer_send",
		label: "Message a peer session",
		description: 'Send a message to another live omp main session on this machine: `to` is its name from peer_list, its session id or a unique id prefix, or "all" for every other session in this git repo; `message` is the text. It reaches that session as a message that starts a turn when it is idle, or at its next step when busy. Use it to hand over a request or a finding instead of asking the user to relay it.',
		parameters: pi.zod.object({ to: pi.zod.string(), message: pi.zod.string() }),
		async execute(_id, params) {
			if (self === undefined) return text("peer_send: only main sessions take part in peer messaging.", true);
			const body = String(params?.message ?? "").trim();
			if (body === "") return text("peer_send: the message is empty; nothing was sent.", true);
			refreshName();
			const picked = resolvePeers(livePeers(dir), self, String(params?.to ?? ""));
			if ("error" in picked) return text(`peer_send: ${picked.error}`, true);
			for (const target of picked.targets) send(dir, self, target, body);
			return text(`Queued in the inbox of ${picked.targets.map(peer => `${peer.name} (${peer.id})`).join(", ")}; it reaches that session at its next step, or starts a turn there when it is idle. A reply comes back to "${self.name}".`);
		},
	});

	pi.registerCommand("peer-name", {
		description: "Name this session for peer messaging: /peer-name <name> (no spaces)",
		handler: async (args, ctx) => {
			const name = String(args ?? "").trim();
			if (!/^\S+$/.test(name)) return ctx.ui?.notify("peer-bus: usage: /peer-name <name> (one word)", "warning");
			chosenName = name;
			refreshName();
			ctx.ui?.notify(`peer-bus: this session is "${name}" for peer messaging.`, "info");
		},
	});

	return { drain };
}
