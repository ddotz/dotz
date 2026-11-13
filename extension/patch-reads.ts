// How the guard sees the files a shell line or an eval cell reads and the variables that name them (review before apply).

// Variables of an eval cell or a shell line, in order, with spaces around = and const/let/var allowed: "const iso = '/x'; `${iso}/y.patch`" resolves
// to /x/y.patch. `known` carries the strings an earlier cell of this session set (the eval kernel keeps its globals), so a later cell that
// only says ${iso}/st_1/root.patch is compared by its real path. Only plain strings are resolved; the rest stays as written.
// A string join (JS or Python: W + '/st_1/root.patch') becomes one string when its parts are known; a part with an unknown name stays as written,
// so that name still names no file. globalThis.X = '...' sets X; X = Y with a known Y takes Y's value (globalThis.iso = iso keeps the path). A loop over a literal list (for (const n of ['a', 'b']), for n in ['a', 'b']:,
// for n in a b; do) repeats each line that uses n once per value, so ${n}.patch is seen as a.patch and b.patch, plus once as ${n}.patch, so a read
// and an apply that both name the file through an unresolved ${n} still match as before.
const STR = "\"[^\"\\n]*\"|'[^'\\n]*'|`[^`]*`";
const TERM = `${STR}|[A-Za-z_$][\\w$]*`;
const JOIN = `(?:${TERM})(?:\\s*\\+\\s*(?:${TERM}))+`;
const BARE = "[^\\s;&|`'\"=<>)(,}][^\\s;&|`'\")(,}]*";
const CELL_ASSIGN = new RegExp(`(?:^|[;&|\\s,(])(?:(?:export|const|let|var)\\s+|globalThis\\.)?([A-Za-z_$][\\w$]*)\\s*=\\s*(?:(${JOIN})|(${STR}|${BARE}))`, "g");
const JOIN_RE = new RegExp(JOIN, "g");
const TERM_RE = new RegExp(TERM, "g");
const ONE_STRING = new RegExp(`^(?:${STR})$`);
const LIST_LOOP = /\bfor\s*\(?\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s+(?:of|in)\s+[[(]((?:\s*(?:"[^"\n]*"|'[^'\n]*')\s*,?)+)\s*[\])]/g;
const SHELL_LOOP = /\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n`'"$]+?)\s*;\s*do\b/g;
const KNOWN_VARS_MAX = 200;

const quote = (s: string) => (!s.includes("'") ? `'${s}'` : !s.includes('"') ? `"${s}"` : `\`${s}\``);
// Each run of known parts with at least one quoted string becomes one quoted string; a run of names only (i + j) is left alone.
function joinStrings(text: string, vars: Map<string, string>): string {
	return text.replace(JOIN_RE, chain => {
		const out: string[] = [];
		let run: { token: string; value: string; quoted: boolean }[] = [];
		const flush = () => {
			if (run.length > 1 && run.some(part => part.quoted)) out.push(quote(run.map(part => part.value).join("")));
			else out.push(...run.map(part => part.token));
			run = [];
		};
		for (const [token] of chain.matchAll(TERM_RE)) {
			const quoted = /^["'`]/.test(token);
			const value = quoted ? token.slice(1, -1) : vars.get(token);
			if (value === undefined) {
				flush();
				out.push(token);
			} else run.push({ token, value, quoted });
		}
		flush();
		return out.join(" + ");
	});
}
const fillWith = (text: string, vars: Map<string, string>) =>
	joinStrings(text, vars).replace(/\$\{([A-Za-z_$][\w$]*)\}|\$([A-Za-z_][\w]*)/g, (whole, a: string | undefined, b: string | undefined) => vars.get(a ?? b ?? "") ?? whole);
const usesName = (line: string, name: string) => {
	const n = name.replace(/\$/g, "\\$");
	return new RegExp(`\\$\\{${n}\\}|\\$${n}(?!\\w)|(?<![\\w$.])${n}(?![\\w$])`).test(line);
};

export function expandCellVars(code: string, known: Map<string, string>, remember = true): string {
	const vars = new Map(known);
	const fill = (text: string) => fillWith(text, vars);
	for (const m of code.matchAll(CELL_ASSIGN)) {
		if (m[2] === undefined) vars.set(m[1], vars.get(m[3]) ?? fill(/^["'`]/.test(m[3]) ? m[3].slice(1, -1) : m[3]));
		else {
			const joined = fill(m[2]);
			if (ONE_STRING.test(joined)) vars.set(m[1], joined.slice(1, -1));
			else vars.delete(m[1]);
		}
	}
	if (remember) {
		for (const [name, value] of vars) {
			known.delete(name);
			known.set(name, value);
		}
		while (known.size > KNOWN_VARS_MAX) known.delete(known.keys().next().value as string);
	}
	const loops = [
		...[...code.matchAll(LIST_LOOP)].map(m => [m[1], [...m[2].matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map(v => v[1] ?? v[2] ?? "")] as const),
		...[...code.matchAll(SHELL_LOOP)].map(m => [m[1], m[2].trim().split(/\s+/)] as const),
	];
	if (!loops.length) return fill(code);
	let lines = code.split("\n").map(text => ({ text, bound: new Map<string, string>() }));
	for (const [name, values] of loops)
		lines = lines.flatMap(line => (usesName(line.text, name) ? [...values, `\${${name}}`].map(value => ({ text: line.text, bound: new Map(line.bound).set(name, value) })) : [line]));
	return lines.map(line => (line.bound.size ? fillWith(line.text, new Map([...vars, ...line.bound])) : fill(line.text))).join("\n");
}
// The files an eval cell or shell line opens for reading: read(x), Bun.file(x), readFileSync(x), readFile(x), open(x), where x is a quoted path or a variable.
const READ_CALL = /(?:\bread|Bun\.file|readFileSync|readFile|readText|\bopen)\(\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$]*)\s*[,)])/g;
export function readPaths(code: string, known: Map<string, string>): string[] {
	return [...code.matchAll(READ_CALL)].map(m => m[1] ?? known.get(m[2]!) ?? "").filter(Boolean);
}
