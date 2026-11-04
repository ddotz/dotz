// A command runner that can never wait for a person: no stdin, no terminal, a deadline. The web onboarding gives it to the installers in
// onboard/aside.ts and onboard/tailscale.ts, which otherwise inherit the terminal (a brew cask that asks for the Mac password would hang there).
import type { Run } from "../onboard/tailscale.ts";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const NON_INTERACTIVE = { NONINTERACTIVE: "1", CI: "1", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", SUDO_ASKPASS: "/usr/bin/false", GIT_TERMINAL_PROMPT: "0" };

async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	let rest = "";
	for await (const chunk of stream) {
		const parts = (rest + decoder.decode(chunk, { stream: true })).split(/\r\n|\r|\n/);
		rest = parts.pop() ?? "";
		for (const part of parts) if (part.replace(ANSI, "").trim()) onLine(part.replace(ANSI, ""));
	}
	if (rest.replace(ANSI, "").trim()) onLine(rest.replace(ANSI, ""));
}

/** Each output line goes to `onLine`; the result is whether the command exited 0 within `timeoutMs` (it is killed after that). */
export function lineRunner(onLine: (line: string) => void, timeoutMs = 30 * 60_000): Run {
	return async cmd => {
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...NON_INTERACTIVE }, timeout: timeoutMs, killSignal: "SIGKILL" });
		} catch (error) {
			onLine((error as Error).message);
			return false;
		}
		await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, onLine), pump(proc.stderr as ReadableStream<Uint8Array>, onLine)]);
		return (await proc.exited) === 0;
	};
}
