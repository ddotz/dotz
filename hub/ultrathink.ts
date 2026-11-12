// The owner's "ultrathink": one turn at a deeper effort. Pure; the raw text the owner typed goes in, never a wrapped prompt.
// Claude Code's own rules for the keyword: not in code, not in quotation marks, not in a URL or path, not in a slash command.
const KEYWORD = /\bultrathink\b/i;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const QUOTED = /"[^"\n]*"|\u201C[^\u201D]*\u201D|\u300C[^\u300D]*\u300D|\u300E[^\u300F]*\u300F|(?<![\p{L}\p{N}])['\u2018][^'\u2019\n]*['\u2019](?![\p{L}\p{N}])|^[ \t]*>.*$/gmu;
// A URL, or any word holding a slash or backslash (a file path), with the "~", "./" and drive forms.
const LOCATION = /\S*(?::\/\/|[\/\\])\S*/g;

export function ownerWantsUltrathink(text: string): boolean {
	if (!KEYWORD.test(text) || text.trimStart().startsWith("/")) return false;
	return KEYWORD.test(text.replace(CODE, " ").replace(QUOTED, " ").replace(LOCATION, " "));
}
