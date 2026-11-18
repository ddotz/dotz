declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	/** The registry setting handle at `path`. The omp binary ships no type declarations, so this names only the host module surface the harness imports. */
	export function lookup(path: string): unknown;
}

declare module "@oh-my-pi/pi-coding-agent" {
	/** omp's TUI prompt composer; a restart submits `/restart` through its native `send` event. */
	export const CustomEditor: import("./restart/restart.ts").ComposerClass;
}
