// How the guard sees the files a shell line or an eval cell reads and the variables that name them (review before apply).

// Variables of an eval cell or a shell line, in order, with spaces around = and const/let/var allowed: "const iso = '/x'; `${iso}/y.patch`" resolves
// to /x/y.patch. `known` carries the strings an earlier cell of this session set (the eval kernel keeps its globals), so a later cell that
// only says ${iso}/st_1/root.patch is compared by its real path. Only plain strings are resolved; the rest stays as written.
const CELL_ASSIGN = /(?:^|[;&|\s,(])(?:(?:export|const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*("[^"\n]*"|'[^'\n]*'|`[^`]*`|[^\s;&|`'"=<>)(,}][^\s;&|`'")(,}]*)/g;
const KNOWN_VARS_MAX = 200;
export function expandCellVars(code: string, known: Map<string, string>, remember = true): string {
	const vars = new Map(known);
	const fill = (text: string) => text.replace(/\$\{([A-Za-z_$][\w$]*)\}|\$([A-Za-z_][\w]*)/g, (whole, a: string | undefined, b: string | undefined) => vars.get(a ?? b ?? "") ?? whole);
	for (const m of code.matchAll(CELL_ASSIGN)) vars.set(m[1], fill(/^["'`]/.test(m[2]) ? m[2].slice(1, -1) : m[2]));
	if (remember) {
		for (const [name, value] of vars) {
			known.delete(name);
			known.set(name, value);
		}
		while (known.size > KNOWN_VARS_MAX) known.delete(known.keys().next().value as string);
	}
	return fill(code);
}
// The files an eval cell or shell line opens for reading: read(x), Bun.file(x), readFileSync(x), readFile(x), open(x), where x is a quoted path or a variable.
const READ_CALL = /(?:\bread|Bun\.file|readFileSync|readFile|readText|\bopen)\(\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$]*)\s*[,)])/g;
export function readPaths(code: string, known: Map<string, string>): string[] {
	return [...code.matchAll(READ_CALL)].map(m => m[1] ?? known.get(m[2]!) ?? "").filter(Boolean);
}
