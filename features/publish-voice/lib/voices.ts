// Reading and writing one person's voices: needs, per-voice meta, per-document measurements, hashes, the texts of the owner's own writing, and the
// profile computed from them. Texts are only ever written for a `self` voice; another person's text is never stored anywhere.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ALL_CELLS, type CellId } from "./cells.ts";
import { type CopySource, decodeHashes } from "./copycheck.ts";
import { buildProfile, type DocRec, type Kind, type Profile } from "./profile.ts";
import { loadJson, rootPaths, saveJson, voiceNames, voicePaths, writeAtomic } from "./store.ts";

export type VoiceMeta = { name: string; kind: Kind };

type NeedsFile = { cells: string[]; audience?: string };
const loadNeeds = (root: string): NeedsFile => loadJson<NeedsFile>(rootPaths(root).needs, { cells: [] });

export const readNeeds = (root: string): CellId[] => {
	const saved = loadNeeds(root).cells;
	return ALL_CELLS.filter(id => saved.includes(id));
};
export const readAudience = (root: string): string | undefined => loadNeeds(root).audience;
export const writeNeeds = (root: string, cells: readonly CellId[], audience = readAudience(root)): void =>
	saveJson(rootPaths(root).needs, { cells, ...(audience ? { audience } : {}), updated: new Date().toISOString() });

export const readMeta = (root: string, name: string): VoiceMeta | undefined => {
	const meta = loadJson<VoiceMeta | undefined>(voicePaths(root, name).meta, undefined);
	return meta && (meta.kind === "self" || meta.kind === "other") ? meta : undefined;
};
export const writeMeta = (root: string, meta: VoiceMeta): void => saveJson(voicePaths(root, meta.name).meta, meta);

export const readDocs = (root: string, name: string): DocRec[] => loadJson<DocRec[]>(voicePaths(root, name).docs, []);
export const writeDocs = (root: string, name: string, docs: readonly DocRec[]): void => saveJson(voicePaths(root, name).docs, docs);

export const readHashes = (root: string, name: string): Record<string, string> => loadJson<Record<string, string>>(voicePaths(root, name).hashes, {});
export const writeHashes = (root: string, name: string, hashes: Record<string, string>): void => saveJson(voicePaths(root, name).hashes, hashes);

const textFile = (root: string, name: string, id: string) => join(voicePaths(root, name).texts, `${id}.txt`);
export const writeText = (root: string, name: string, id: string, text: string): void => writeAtomic(textFile(root, name, id), text);
export const readText = (root: string, name: string, id: string): string => {
	const file = textFile(root, name, id);
	return existsSync(file) ? readFileSync(file, "utf8") : "";
};
export const dropText = (root: string, name: string, id: string): void => rmSync(textFile(root, name, id), { force: true });

export const readProfile = (root: string, name: string): Profile | undefined => loadJson<Profile | undefined>(voicePaths(root, name).profile, undefined);

// Recomputed from the stored per-document measurements, so a new need never means reading the sources again.
export function refreshProfile(root: string, meta: VoiceMeta, now = new Date()): Profile {
	const profile = buildProfile({ voice: meta.name, kind: meta.kind, docs: readDocs(root, meta.name), cells: readNeeds(root), now });
	saveJson(voicePaths(root, meta.name).profile, profile);
	return profile;
}

export function copySources(root: string): CopySource[] {
	return voiceNames(root).flatMap(name => {
		const meta = readMeta(root, name);
		if (!meta) return [];
		const hashes = new Set<number>();
		for (const encoded of Object.values(readHashes(root, name))) for (const h of decodeHashes(encoded)) hashes.add(h);
		return [{ voice: name, kind: meta.kind, hashes }];
	});
}
