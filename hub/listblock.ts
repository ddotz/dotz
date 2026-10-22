// The 목록 block: a list the web shows as UI rows (web/js/02-basic-markdown.js listBlockHtml) - a round initial, title, subtitle,
// meta on the right and a count badge. Any list of things for the owner (rooms, files, mails, results) goes out as this block.
export type ListRow = { title: string; sub?: string; meta?: string; badge?: number | string };

// " | " separates fields and a fence line ends the block, so both are neutralised inside a field.
const field = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").replaceAll(" | ", " / ").replaceAll("```", "'''").trim();

export function listBlock(title: string, rows: ListRow[]): string {
	const lines = rows.map(r => {
		const badge = r.badge === undefined || r.badge === 0 || r.badge === "0" ? "" : field(r.badge);
		const cells = [field(r.title) || "-", field(r.sub), field(r.meta), badge];
		while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
		return cells.join(" | ");
	});
	return ["```목록", ...(title.trim() ? [`# ${field(title)}`] : []), ...lines, "```"].join("\n");
}
