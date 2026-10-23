// A notice's title: the first sentence of its text, at most `max` characters (cut at a word boundary with "…"), without the closing period.
export function shortTitle(line: string, max = 60): string {
	const one = line.replace(/\s+/g, " ").trim();
	const base = (/^.*?[.!?。？！](?=\s|$)/.exec(one)?.[0] ?? one).replace(/[.。]+$/, "");
	if (base.length <= max) return base;
	const cut = base.slice(0, max), sp = cut.lastIndexOf(" ");
	return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
