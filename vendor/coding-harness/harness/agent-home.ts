import { homedir } from "node:os";
import { join } from "node:path";

/** omp's own agent directory, where its settings (`config.yml`) and sessions live: PI_CODING_AGENT_DIR (omp's override), else `~/.omp/agent`. */
export const ompAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");

/** The agent directory this harness copy keeps its state in: HARNESS_AGENT_HOME (set by a host that ships its own copy, such as dotz), else `ompAgentDir()`. Read per call, so a test that moves HOME or the variable sees the change. */
export const agentHome = (): string => process.env.HARNESS_AGENT_HOME || ompAgentDir();

/** The `harness/` directory under `agentHome()`. */
export const harnessDir = (): string => join(agentHome(), "harness");

/** The directory the harness writes its logs in: `<harness>/logs`. */
export const logsDir = (): string => join(harnessDir(), "logs");

/** True when a host ships its own harness copy (HARNESS_AGENT_HOME set); such a copy must not read the machine owner's omp sessions. */
export const isHostCopy = (): boolean => Boolean(process.env.HARNESS_AGENT_HOME);
