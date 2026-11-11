// The "Files touched:" block of a handover: the paths a saved session wrote or edited, nothing else. Each runtime picks the
// paths out of its own tool-call shape (structured path arguments only); a command or its output can carry a token, so
// neither is ever read.
const MAX_FILES = 20;
const MAX_PATH = 200;
const MAX_BLOCK = 1500;

// The path argument of an edit/write call, or undefined when it is not a plain one-line string.
export const touchedPath = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : undefined);

// The handover tail followed by the block of `paths` (oldest first, as met in the session): most recent first, each once,
// at most 20 within about 1500 characters; no block when there are none.
export function withTouchedFiles(tail: string, paths: string[]): string {
	const lines: string[] = [];
	let size = "Files touched:".length;
	for (const p of [...new Set([...paths].reverse())]) {
		const line = `- ${p.length > MAX_PATH ? `...${p.slice(-(MAX_PATH - 3))}` : p}`;
		if (lines.length >= MAX_FILES || size + line.length + 1 > MAX_BLOCK) break;
		lines.push(line);
		size += line.length + 1;
	}
	if (!lines.length) return tail;
	return `${tail ? `${tail}\n\n` : ""}Files touched:\n${lines.join("\n")}`;
}
