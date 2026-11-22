import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** The folder omp keeps its settings, logins and sessions in. A named profile (OMP_PROFILE, else PI_PROFILE; "default" or empty is none) has its own folder under the config root and ignores PI_CODING_AGENT_DIR; the default profile uses PI_CODING_AGENT_DIR, else <home>/<PI_CONFIG_DIR or .omp>/agent. No config import, so the recall command line and the agent-side extension can load it. */
export function ompAgentDir(env: Env = process.env, home: string = homedir()): string {
	const profile = (env.OMP_PROFILE ?? env.PI_PROFILE ?? "").trim();
	const root = join(home, env.PI_CONFIG_DIR || ".omp");
	if (profile && profile !== "default") return join(root, "profiles", profile, "agent");
	return env.PI_CODING_AGENT_DIR || join(root, "agent");
}

/** Where omp writes its session files: one folder per working directory under the agent folder. */
export const ompSessionsDir = (env: Env = process.env, home: string = homedir()): string => join(ompAgentDir(env, home), "sessions");
