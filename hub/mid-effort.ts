// Which models keep the prompt cache when the effort changes mid-conversation. OmO's model info says so per model
// (compat.supportsMidConvoEffort): the agent dir's models.json, then OmO's bundled Anthropic data. A hand list went stale
// with every new model version, so it is only the fallback for an install where neither file can be read.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const omoAgentDir = () => process.env.OMO_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");

type Flags = Map<string, boolean>;
const cache = new Map<string, { mtime: number; flags: Flags | undefined }>();

function flagsOf(file: string, parse: (doc: any) => Iterable<any>, explicitOnly = false): Flags | undefined {
	let mtime: number;
	try {
		mtime = statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
	const hit = cache.get(file);
	if (hit?.mtime === mtime) return hit.flags;
	let flags: Flags | undefined;
	try {
		flags = new Map();
		for (const m of parse(JSON.parse(readFileSync(file, "utf8")))) {
			if (typeof m?.id !== "string") continue;
			const flag = m.compat?.supportsMidConvoEffort;
			// models.json often re-lists a bundled model for other settings: only an explicit flag there decides.
			if (typeof flag === "boolean" || !explicitOnly) flags.set(m.id, Boolean(flags.get(m.id)) || flag === true);
		}
	} catch {
		flags = undefined;
	}
	cache.set(file, { mtime, flags });
	return flags;
}

const configured = (doc: any) => Object.values<any>(doc.providers).flatMap(p => p.models ?? []);
const bundled = (doc: any) => Object.values<any>(doc).flatMap(group => Object.values<any>(group));

// OmO's bundled model data sits in its runtime dir (one directory per OmO install, named by hash).
function bundledFiles(agentDir: string): string[] {
	const root = join(agentDir, "runtime");
	try {
		return readdirSync(root).map(d => join(root, d, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "anthropic.json")).filter(existsSync);
	} catch {
		return [];
	}
}

/** True when `model` ("<provider>/<id>") sends an effort change as a marker that leaves the cache intact. A models.json entry that sets the flag wins over the bundled data; an id neither knows is false once any file was read; with none readable `fallback` answers. */
export function midConvoEffort(model: string, fallback: RegExp, agentDir = omoAgentDir()): boolean {
	const id = model.slice(model.lastIndexOf("/") + 1);
	const own = flagsOf(join(agentDir, "models.json"), configured, true);
	if (own?.has(id)) return own.get(id)!;
	const shipped = bundledFiles(agentDir).map(f => flagsOf(f, bundled)).filter((f): f is Flags => f !== undefined);
	if (shipped.length) return shipped.some(f => f.get(id) === true);
	return fallback.test(model);
}

// OmO sends an effort change as a per-message effort marker on these models (senpi anthropic-messages, compat
// supportsMidConvoEffort; Anthropic docs "Change effort mid-conversation"), so the prompt cache survives it.
export const MID_CONVO_EFFORT = /claude-(opus-5|opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1|fable-5-2|mythos-5-1)$/;
export const keepsCacheOnEffort = (runtime: string, model: string) => runtime === "omo" && midConvoEffort(model, MID_CONVO_EFFORT);
