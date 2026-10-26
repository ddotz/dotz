// A short-lived `omo --mode rpc` for OmO's own login commands (hub/providers.ts drives the sign-in through it). OmO keeps its logins in
// <agent dir>/auth.json, which `omp login` never writes, so a web login on an OmO install has to go through OmO itself.
// Protocol (senpi session worker, checked against a real `omo --mode rpc` 2026-10-26 with a throwaway agent dir):
// - {type:"get_auth_providers"} -> response data.providers [{id, name, authType:"oauth"|"api_key", ...}]
// - {type:"login_start", provider} -> an immediate success response, then the login runs in the background and emits
//   {type:"auth_login_url", provider, url}, prompts as {type:"extension_ui_request", id, method:"input"|"select", title, options?}
//   (answered with {type:"extension_ui_response", id, value} or {..., cancelled:true}), and finally
//   {type:"auth_login_end", provider, success, error?}.
// - {type:"login_cancel", provider} aborts it (auth_login_end success:false "Login cancelled").
// OmO adds a login to a provider's account pool (a new `login-N` slot; the pin and the other accounts stay).
// --no-session: nothing is saved as a session; memory and the question tool are off as for every dotz process (omo.ts).
import { tmpdir } from "node:os";
import { OMO } from "./omo-hosts.ts";

export type RpcFrame = { type?: string; id?: string; [k: string]: unknown };

// Tests swap `argv` for a fake RPC; nothing else reads it.
export const omoRpcCommand = { argv: (): string[] => [OMO, "--mode", "rpc", "--no-session", "--omo-senpi-memory-disabled", "--no-ask-user"] };

export class OmoRpc {
	readonly proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
	readonly exited: Promise<number>;
	private listeners: ((f: RpcFrame) => void)[] = [];
	private seq = 0;

	constructor() {
		// BROWSER=true: nothing opens a browser on the gateway's computer; the owner opens the URL on their own device.
		this.proc = Bun.spawn(omoRpcCommand.argv(), { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, BROWSER: "true" } });
		this.exited = this.proc.exited;
		void this.read();
	}

	private async read(): Promise<void> {
		const dec = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of this.proc.stdout) {
				buf += dec.decode(chunk, { stream: true });
				for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					if (!line.startsWith("{")) continue;
					let f: RpcFrame;
					try {
						f = JSON.parse(line);
					} catch {
						continue;
					}
					for (const l of this.listeners) l(f);
				}
			}
		} catch {
			// the process went away; `exited` reports it
		}
	}

	on(fn: (f: RpcFrame) => void): void {
		this.listeners.push(fn);
	}

	send(frame: RpcFrame): void {
		try {
			this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
			void this.proc.stdin.flush();
		} catch {
			// stdin closed: the process is exiting
		}
	}

	// Sends a command and resolves with its response frame (undefined on timeout or exit).
	request(type: string, extra: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<RpcFrame | undefined> {
		const id = `dotz-${++this.seq}`;
		const { promise, resolve } = Promise.withResolvers<RpcFrame | undefined>();
		const timer = setTimeout(() => resolve(undefined), timeoutMs);
		this.on(f => {
			if (f.type === "response" && f.id === id) {
				clearTimeout(timer);
				resolve(f);
			}
		});
		void this.exited.then(() => {
			clearTimeout(timer);
			resolve(undefined);
		});
		this.send({ id, type, ...extra });
		return promise;
	}

	close(): void {
		try {
			this.proc.kill();
		} catch {}
		setTimeout(() => {
			try {
				this.proc.kill(9);
			} catch {}
		}, 2000).unref();
	}
}

// OmO's OAuth login providers (its own ids). Undefined: OmO could not be asked.
export async function omoLoginProviders(timeoutMs = 30_000): Promise<{ id: string; name: string }[] | undefined> {
	let rpc: OmoRpc;
	try {
		rpc = new OmoRpc();
	} catch {
		return undefined;
	}
	try {
		const r = await rpc.request("get_auth_providers", {}, timeoutMs);
		const list = (r?.data as { providers?: unknown } | undefined)?.providers;
		if (!r?.success || !Array.isArray(list)) return undefined;
		return list.filter((p): p is { id: string; name?: unknown; authType?: unknown } => typeof p?.id === "string" && p.authType === "oauth").map(p => ({ id: p.id, name: String(p.name ?? p.id) }));
	} finally {
		rpc.close();
	}
}
