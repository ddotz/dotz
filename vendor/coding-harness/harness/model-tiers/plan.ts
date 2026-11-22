export const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

export type Family = { provider: string; tier: string; pattern: string };
export type Role = { tier: string; step?: number; effort?: string };
export type Spot = { effort: string; confidence: string; basis: string; sources: string[]; checked: string };
export type Data = {
	primaryProvider: string;
	ignoredProviders?: string[];
	ignoredModels?: string[];
	pinnedRoles?: string[];
	families: Family[];
	roles: Record<string, Role>;
	sweetSpots: Record<string, Spot>;
};
export type Model = { provider: string; id: string; levels: string[] };
export type TierPick = { adopted?: Model; newest: Model };
export type Plan = { tiers: Record<string, TierPick>; roles: Record<string, string>; research: string[] };

export const key = (m: Model) => `${m.provider}/${m.id}`;

function version(family: Family, id: string): number[] | undefined {
	const match = new RegExp(family.pattern).exec(id);
	return match ? match.slice(1).map(group => Number(group ?? 0)) : undefined;
}

function compareVersions(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff) return diff;
	}
	return 0;
}

function stepEffort(base: string, step: number, levels: string[]): string {
	const supported = LADDER.filter(level => levels.includes(level));
	let index = supported.indexOf(base);
	if (index < 0) index = supported.findIndex(level => LADDER.indexOf(level) >= LADDER.indexOf(base));
	if (index < 0) index = supported.length - 1;
	return supported[Math.min(supported.length - 1, Math.max(0, index + step))];
}

/** The role each tier policy picks from `models`: per tier the newest model on the primary provider whose sweet spot is recorded, at that sweet spot plus the role's `step` (or its fixed `effort`), clamped to the model's levels; pinned roles are left out; newer unresearched models, unknown providers and unclassified model lines are listed as research. */
export function plan(data: Data, models: Model[]): Plan {
	const tiers: Record<string, TierPick> = {};
	const research: string[] = [];
	for (const family of data.families) {
		const ranked = models
			.filter(m => m.provider === family.provider)
			.map(m => ({ m, v: version(family, m.id) }))
			.filter((x): x is { m: Model; v: number[] } => x.v !== undefined)
			.sort((a, b) => compareVersions(b.v, a.v));
		if (!ranked.length) continue;
		const newest = ranked[0].m;
		const adopted = ranked.find(x => data.sweetSpots[key(x.m)])?.m;
		if (!data.sweetSpots[key(newest)]) {
			research.push(`sweet spot for ${key(newest)} (tier ${family.tier}${adopted ? `; ${key(adopted)} stays in use until it is recorded` : ""})`);
		}
		if (family.provider === data.primaryProvider) tiers[family.tier] = { adopted, newest };
	}
	const known = new Set(data.families.map(f => f.provider));
	const ignored = new Set([...(data.ignoredProviders ?? []), data.primaryProvider]);
	for (const provider of new Set(models.map(m => m.provider))) {
		if (!known.has(provider) && !ignored.has(provider)) research.push(`tier families for provider ${provider} (which of its model lines are worker / base / deep / light class)`);
	}
	const skip = (data.ignoredModels ?? []).map(p => new RegExp(p));
	const unclassified = new Map<string, string[]>();
	for (const m of models) {
		if (m.provider !== data.primaryProvider || /-\d{8}$/.test(m.id) || skip.some(r => r.test(m.id))) continue;
		if (data.families.some(f => f.provider === m.provider && version(f, m.id) !== undefined)) continue;
		const line = m.id.replace(/(-\d+)+$/, "");
		unclassified.set(line, [...(unclassified.get(line) ?? []), m.id]);
	}
	for (const [line, ids] of unclassified) {
		research.push(`tier family for ${data.primaryProvider} model line ${line} (${ids.join(", ")}): record a family, or add it to ignoredModels if it fits no tier`);
	}
	const roles: Record<string, string> = {};
	for (const [role, spec] of Object.entries(data.roles)) {
		if (data.pinnedRoles?.includes(role)) continue;
		const model = tiers[spec.tier]?.adopted;
		if (!model) continue;
		const effort = spec.effort ? stepEffort(spec.effort, 0, model.levels) : stepEffort(data.sweetSpots[key(model)].effort, spec.step ?? 0, model.levels);
		roles[role] = `${key(model)}:${effort}`;
	}
	return { tiers, roles, research };
}
