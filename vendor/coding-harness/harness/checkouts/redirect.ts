import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { editedPaths } from "../gate/tool-paths.ts";
import { type Placement, whereis } from "./place.ts";

type Fields = Record<string, unknown>;

/** The tool input with its folder paths moved into the slot, and each moved path as the call spelled it. */
export interface Redirect {
	readonly input: Fields;
	readonly moved: string[];
}

const WRITING_TOOLS: readonly string[] = ["edit", "apply_patch", "write", "ast_edit"];
const PATCH_TOOLS: readonly string[] = ["edit", "apply_patch"];
const SLOT_RETRY_MS = 30_000;
const READING_TOOLS: readonly string[] = ["read", "grep", "glob"];

/** The tools `redirectPath` handles. */
export const REDIRECTED_TOOLS: readonly string[] = [...WRITING_TOOLS, ...READING_TOOLS];
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SELECTOR = /(?::(?:raw|img|conflicts|[\dL,.+-]+))+$/;
const WRAPPED = /^\[(.+?)(#[^\]]*)?\]$/;
const SLOPPY_SECTION = /^\*\*\* Edit File:/m;
const MAGIC_SECTION = /^# /m;
const LOOSE_HEADER = /^[ \t]*\[(.+)\][ \t\r]*$/gm;
const ENVELOPE_SECTION = /^\*\*\* (?:Update|Add|Delete) File:/m;
const SLOPPY_HEADER = /^(\*\*\* Edit File:[ \t]*)(.+?)([ \t\r]*)$/gm;
const ENVELOPE_HEADER = /^(\*\*\* (?:Update File|Add File|Delete File|Move to):[ \t]*)(.+?)([ \t\r]*)$/gm;
const HASHLINE_HEADER = /^([ \t]*\[)([^\]\n#]+)(#[^\]\n]*)?(\][ \t\r]*)$/gm;
const HASHLINE_MOVE = /^([ \t]*MV[ \t]+)(["']?)(.+?)\2([ \t\r]*)$/gm;

function isFields(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Roots {
	readonly folder: string;
	readonly slot: string;
	readonly readOnly: boolean;
	readonly moved: string[];
}

function realOf(absolute: string): string {
	const tail: string[] = [];
	let head = absolute;
	for (;;) {
		try {
			return join(realpathSync(head), ...tail.reverse());
		} catch {
			const parent = dirname(head);
			if (parent === head) return absolute;
			tail.push(basename(head));
			head = parent;
		}
	}
}

function movedSpec(spec: string, roots: Roots): string | undefined {
	const lead = /^\s*/.exec(spec)?.[0] ?? "";
	let body = spec.slice(lead.length);
	const wrapper = WRAPPED.exec(body);
	if (wrapper !== null) {
		const inner = movedSpec(wrapper[1], roots);
		return inner === undefined ? undefined : `${lead}[${inner}${wrapper[2] ?? ""}]`;
	}
	let scheme = "";
	if (body.startsWith("file://")) {
		scheme = "file://";
		body = body.slice(scheme.length);
	} else if (SCHEME.test(body)) return undefined;
	let absolute: string;
	if (body === "~" || body.startsWith("~/")) absolute = join(process.env.HOME || homedir(), body.slice(1));
	else if (isAbsolute(body)) absolute = body;
	else return undefined;
	const real = realOf(resolve(absolute));
	if (real !== roots.folder && !real.startsWith(roots.folder + sep)) return undefined;
	const target = join(roots.slot, relative(roots.folder, real));
	if (roots.readOnly) {
		const selector = existsSync(real) ? "" : (SELECTOR.exec(real)?.[0] ?? "");
		if (existsSync(real.slice(0, real.length - selector.length)) && !existsSync(target.slice(0, target.length - selector.length))) return undefined;
	}
	roots.moved.push(spec);
	return `${lead}${scheme}${target}${body.length > 1 && body.endsWith("/") ? "/" : ""}`;
}

function movedList(value: string, roots: Roots): string | undefined {
	let changed = false;
	const parts = value.split(";").map(entry => {
		const next = movedSpec(entry, roots);
		if (next === undefined) return entry;
		changed = true;
		return next;
	});
	return changed ? parts.join(";") : undefined;
}

function movedPatch(text: string, roots: Roots): string | undefined {
	let changed = false;
	const edit = (spec: string): string => {
		const next = movedSpec(spec, roots);
		if (next === undefined) return spec;
		changed = true;
		return next;
	};
	const section = (_whole: string, open: string, path: string, close: string): string => `${open}${edit(path)}${close}`;
	let revised: string;
	if (SLOPPY_SECTION.test(text)) revised = text.replace(SLOPPY_HEADER, section);
	else if (ENVELOPE_SECTION.test(text)) revised = text.replace(ENVELOPE_HEADER, section);
	else if (MAGIC_SECTION.test(text)) return undefined;
	else {
		revised = text
			.replace(HASHLINE_HEADER, (_whole, open: string, path: string, tag: string | undefined, close: string) => `${open}${edit(path)}${tag ?? ""}${close}`)
			.replace(HASHLINE_MOVE, (_whole, open: string, quote: string, path: string, close: string) => `${open}${quote}${edit(path)}${quote}${close}`);
	}
	return changed ? revised : undefined;
}

function rootsOf(placement: Placement, readOnly: boolean, moved: string[]): Roots {
	return { folder: realOf(placement.folder), slot: realOf(placement.path), readOnly, moved };
}

/**
 * The input of file tool `tool` with every absolute path that is `placement.folder` or lies under it moved to the same
 * relative path under the slot root, or undefined when no path moved (or `tool` is not a file tool). Covers `path`
 * (a `;` list, a copied `[PATH#TAG]` header, `:50-80` / `:raw` selectors, `~/` and `file://` spellings), `paths`, and
 * in `edit` and `apply_patch` the `edits[].rename` targets and the file headers of `input`: `[PATH#TAG]` and `MV`
 * in a hashline payload, `*** Edit File:` in a sloppy one, `*** Update/Add/Delete File:` and `*** Move to:` in an
 * apply_patch envelope. Body, context and hunk lines are file content and are never rewritten. Folder and input
 * paths are compared by real path. `read`, `grep` and `glob` keep a path whose file exists in the folder but not in
 * the slot: reading the folder is harmless and the file may be newer. Writing tools always move. Internal URLs, web
 * URLs and every other field stay.
 */
export function redirectPath(placement: Placement, tool: string, input: unknown): Redirect | undefined {
	const writes = WRITING_TOOLS.includes(tool);
	if ((!writes && !READING_TOOLS.includes(tool)) || !isFields(input)) return undefined;
	const fields = input;
	const moved: string[] = [];
	const roots = rootsOf(placement, !writes, moved);
	const revised: Fields = { ...fields };
	let changed = false;
	if (typeof fields.path === "string") {
		const next = movedList(fields.path, roots);
		if (next !== undefined) {
			revised.path = next;
			changed = true;
		}
	}
	const listed: unknown = fields.paths;
	if (Array.isArray(listed)) {
		const next = listed.map(entry => (typeof entry === "string" ? (movedList(entry, roots) ?? entry) : entry));
		if (next.some((entry, index) => entry !== listed[index])) {
			revised.paths = next;
			changed = true;
		}
	}
	if (PATCH_TOOLS.includes(tool)) {
		const edits: unknown = fields.edits;
		if (Array.isArray(edits)) {
			const next = edits.map((entry: unknown) => {
				if (!isFields(entry) || typeof entry.rename !== "string") return entry;
				const rename = movedSpec(entry.rename, roots);
				return rename === undefined ? entry : { ...entry, rename };
			});
			if (next.some((entry, index) => entry !== edits[index])) {
				revised.edits = next;
				changed = true;
			}
		}
		if (typeof fields.input === "string") {
			const next = movedPatch(fields.input, roots);
			if (next !== undefined) {
				revised.input = next;
				changed = true;
			}
		}
	}
	return changed ? { input: revised, moved } : undefined;
}

/** A path a write call still names under the folder, and the slot path that is the same file; for an `ast_edit` scoped above the folder (`above`), the entry as spelled and the slot root to scope the call to. */
export interface FolderWrite {
	readonly named: string;
	readonly use: string;
	readonly above?: true;
}

const WILDCARD = /[*?[{]/;

function fixedPrefix(spec: string): string {
	const segments = spec.split("/");
	const wild = segments.findIndex(segment => WILDCARD.test(segment));
	if (wild < 0) return spec;
	return segments.slice(0, wild).join("/") || (spec.startsWith("/") ? "/" : ".");
}

function aboveFolder(placement: Placement, input: Fields, cwd: string): FolderWrite[] {
	const roots = rootsOf(placement, false, []);
	const specs: string[] = [];
	if (typeof input.path === "string") specs.push(input.path);
	if (Array.isArray(input.paths)) for (const entry of input.paths) if (typeof entry === "string") specs.push(entry);
	const found: FolderWrite[] = [];
	for (const whole of specs.flatMap(entry => entry.split(";").map(part => part.trim()))) {
		const pieces = /[,\s]/.test(whole) ? [whole, ...whole.split(/[,\s]+/)] : [whole];
		for (const [index, spec] of pieces.entries()) {
			if (spec === "" || SCHEME.test(spec)) continue;
			const prefix = fixedPrefix(spec);
			const absolute = prefix === "~" || prefix.startsWith("~/") ? join(process.env.HOME || homedir(), prefix.slice(1)) : prefix;
			const real = realOf(resolve(cwd, absolute));
			if (real !== roots.folder && roots.folder.startsWith(real === sep ? real : real + sep)) found.push({ named: spec, use: roots.slot, above: true });
			else if (index > 0 && (real === roots.folder || real.startsWith(roots.folder + sep))) found.push({ named: spec, use: join(roots.slot, relative(roots.folder, real)) });
		}
	}
	return found;
}

function magicHeaders(text: string): string[] {
	const found: string[] = [];
	let fenced = false;
	for (const line of text.split("\n")) {
		if (/^[ \t]*(?:```|~~~)/.test(line)) fenced = !fenced;
		else if (!fenced) {
			const header = /^# (.+?)[ \t\r]*$/.exec(line);
			if (header !== null) found.push(header[1]);
		}
	}
	return found;
}

function payloadTargets(text: string): string[] {
	if (SLOPPY_SECTION.test(text)) return [...text.matchAll(SLOPPY_HEADER)].map(match => match[2].replace(/\s+all$/, ""));
	if (ENVELOPE_SECTION.test(text)) return [...text.matchAll(ENVELOPE_HEADER)].map(match => match[2]);
	if (MAGIC_SECTION.test(text)) return magicHeaders(text);
	return [...[...text.matchAll(LOOSE_HEADER)].map(match => match[1].replace(/#[0-9A-Za-z?]*$/, "")), ...[...text.matchAll(HASHLINE_MOVE)].map(match => match[3])];
}

/**
 * The files a write call (`edit`, `apply_patch`, `write`, `ast_edit`) still names under `placement.folder` after
 * `redirectPath`, each with the slot path to use instead: its `path` and `paths` fields, its `edits[].rename` targets and
 * the file headers of its payload, all resolved against `cwd`. Which lines are headers follows the payload's own form
 * (hashline, sloppy, apply_patch envelope or magic `# path` sections outside code fences); body lines are content and
 * never count. An `ast_edit` whose `path` or `paths` entry is a directory above the folder, or a glob whose fixed
 * prefix is one (the wildcard can then match inside the folder), is reported as `above` with the slot root as the path
 * to use; omp also splits such an entry at commas and spaces, so each of those parts is judged the same way and one
 * under the folder is reported too. Empty for a read-only tool.
 */
export function folderWrites(placement: Placement, tool: string, input: unknown, cwd: string): FolderWrite[] {
	if (!WRITING_TOOLS.includes(tool) || !isFields(input)) return [];
	const roots = rootsOf(placement, false, []);
	const fields: Fields = { ...input };
	delete fields.input;
	const named = editedPaths(tool === "apply_patch" ? "edit" : tool, fields, cwd);
	if (PATCH_TOOLS.includes(tool)) {
		const targets = typeof input.input === "string" ? payloadTargets(input.input) : [];
		const edits: unknown = input.edits;
		if (Array.isArray(edits)) for (const entry of edits) if (isFields(entry) && typeof entry.rename === "string") targets.push(entry.rename);
		named.push(...editedPaths("write", { paths: targets }, cwd));
	}
	const found: FolderWrite[] = [];
	for (const path of named) {
		const real = realOf(resolve(path));
		if (real !== roots.folder && !real.startsWith(roots.folder + sep)) continue;
		found.push({ named: path, use: join(roots.slot, relative(roots.folder, real)) });
	}
	if (tool === "ast_edit") found.push(...aboveFolder(placement, input, cwd));
	return found;
}

/** What a session's file tool call really runs with: `input` revised for the slot of `cwd` (`input` itself when nothing moved), the slot's placement, and each path that moved as the call spelled it. */
export interface SlotCall {
	readonly input: unknown;
	readonly placement: Placement | undefined;
	readonly moved: readonly string[];
}

const missedAt = new Map<string, number>();

/**
 * The input that file tool `tool` called from `cwd` will run with: `redirectPath` of it when `cwd` is inside an ovnfs
 * slot, else `input` as given. The slot lookup (`whereis`, which spawns `ovnfs`) happens only for the file tools
 * `redirectPath` handles, and a `cwd` that was not in a slot is asked again at most every 30 s. Never throws.
 */
export function slotCall(cwd: string, tool: string, input: unknown): SlotCall {
	const unmoved: SlotCall = { input, placement: undefined, moved: [] };
	if (!REDIRECTED_TOOLS.includes(tool)) return unmoved;
	const missed = missedAt.get(cwd);
	if (missed !== undefined && Date.now() - missed < SLOT_RETRY_MS) return unmoved;
	const placement = whereis(cwd);
	if (placement === undefined) {
		missedAt.set(cwd, Date.now());
		return unmoved;
	}
	missedAt.delete(cwd);
	const redirected = redirectPath(placement, tool, input);
	return redirected === undefined ? { ...unmoved, placement } : { input: redirected.input, placement, moved: redirected.moved };
}
