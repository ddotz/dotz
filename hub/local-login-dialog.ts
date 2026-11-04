import { NAME } from "./config.ts";

// The confirmation of a web login on 이 컴퓨터만: a native dialog on the desktop of the user the gateway runs as (hub/local-login.ts asks, the owner answers).
// The number and the name reach the dialog only as argv items, never as text of a script or a shell line.

export type DialogAnswer = "allow" | "deny" | "unavailable";
export type Confirm = (number: string) => Promise<DialogAnswer>;

const GIVE_UP_S = 110;
const BODY = (number: string): string => `웹 브라우저 로그인을 허용할까요?\n브라우저의 번호: ${number}\n내가 방금 누른 것이 아니면 거부를 눌러 주세요.`;

// item 1 = the number, item 2 = the name; both are read from argv, so nothing is interpolated into this text
export const MAC_SCRIPT = `on run argv
	set theNumber to item 1 of argv
	set theName to item 2 of argv
	activate
	set answer to display dialog ("웹 브라우저 로그인을 허용할까요?" & linefeed & "브라우저의 번호: " & theNumber & linefeed & "내가 방금 누른 것이 아니면 거부를 눌러 주세요.") with title (theName & " 로그인") buttons {"거부", "허용"} default button "거부" giving up after ${GIVE_UP_S}
	if gave up of answer then return "timeout"
	return button returned of answer
end run`;

/** The command that shows the dialog, or undefined when this platform has none. `find` resolves a program on PATH. */
export function dialogCommand(platform: NodeJS.Platform, number: string, name: string, find: (bin: string) => string | null): string[] | undefined {
	const title = `${name} 로그인`;
	if (platform === "darwin") return ["osascript", "-e", MAC_SCRIPT, number, name];
	if (platform !== "linux") return undefined;
	if (find("zenity")) return ["zenity", "--question", "--no-markup", `--title=${title}`, `--text=${BODY(number)}`, "--ok-label=허용", "--cancel-label=거부", `--timeout=${GIVE_UP_S}`];
	if (find("kdialog")) return ["kdialog", "--title", title, "--yes-label", "허용", "--no-label", "거부", "--yesno", BODY(number)];
	return undefined;
}

/** What the dialog's exit means. A cancel and "nobody answered" are a no; any other failure means no dialog could be shown. */
export function dialogAnswer(platform: NodeJS.Platform, exitCode: number | null, stdout: string, stderr: string): DialogAnswer {
	if (platform === "darwin") {
		if (exitCode === 0) return stdout.trim() === "허용" ? "allow" : "deny";
		return stderr.includes("(-128)") ? "deny" : "unavailable";
	}
	if (exitCode === 0) return "allow";
	return exitCode === 1 || exitCode === 5 ? "deny" : "unavailable";
}

/** Where a dialog program is found. On Linux without a display it cannot show anything and exits like a "no", so it counts as not there. */
export const dialogFinder = (platform: NodeJS.Platform, env: Record<string, string | undefined>, which: (bin: string) => string | null) => (bin: string): string | null =>
	platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY ? null : which(bin);

export const nativeConfirm: Confirm = async number => {
	const argv = dialogCommand(process.platform, number, NAME, dialogFinder(process.platform, process.env, bin => Bun.which(bin)));
	if (!argv) return "unavailable";
	try {
		const signal = AbortSignal.timeout((GIVE_UP_S + 5) * 1000);
		const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
		const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return signal.aborted ? "deny" : dialogAnswer(process.platform, exitCode, stdout, stderr);
	} catch {
		return "unavailable";
	}
};
