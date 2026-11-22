import { homedir } from "node:os";

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const list = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? (value as unknown[]) : undefined);

/** The home directory a shell would expand `~` and `$HOME` to: the HOME of this process, as the bash a check runs in inherits it, else the account's home (os.homedir ignores a HOME set after start-up under bun). */
export const shellHome = (): string => process.env.HOME || homedir();
