// dotz_connect: the hub's OnboardView (GET/POST /api/onboarding/<key>...) as the short plain text the model reads back to the owner.
export type ConnectView = {
	key?: string;
	state?: string;
	step?: { id?: string; title?: string; detail?: string } | null;
	owner?: { label?: string; hint?: string } | null;
	error?: string | null;
	url?: string | null;
	choices?: { id: string; label: string }[];
};

export function connectText(v: ConnectView): string {
	const lines = [`${v.key ?? "messenger"}: ${v.state ?? "unknown"}`];
	if (v.step?.title) lines.push(`step: ${v.step.title}${v.step.detail ? ` - ${v.step.detail}` : ""}`);
	if (v.owner?.label) lines.push(`owner does: ${v.owner.label}${v.owner.hint ? ` (${v.owner.hint})` : ""}`);
	if (v.error) lines.push(`error: ${v.error}`);
	if (v.url) lines.push(`link: ${v.url}`);
	if (v.choices?.length) {
		lines.push("choices (continue with choice=<id>):");
		v.choices.forEach((c, i) => lines.push(`${i + 1}. ${c.label} [${c.id}]`));
	}
	return lines.join("\n");
}
