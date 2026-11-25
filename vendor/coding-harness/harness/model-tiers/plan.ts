export const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

export type Role = { above: string } | { effort?: string };
export type Point = [index: number, usdPerTask: number];
export type Spot = { effort: string; confidence: string; basis: string; sources: string[]; checked: string; points?: Record<string, Point> };
export type Data = {
	roles: Record<string, Role>;
	sweetSpots: Record<string, Spot>;
};
export type Model = { provider: string; id: string; levels: string[] };
export type Resolution = { set: Record<string, string>; userSet: string[]; research: string[] };

export const key = (m: Model) => `${m.provider}/${m.id}`;

function parse(selector: string): { model: string; level?: string } {
	const split = /^(.+):([a-z]+)$/.exec(selector);
	return split ? { model: split[1], level: split[2] } : { model: selector };
}

function clamp(level: string, levels: string[]): string {
	const supported = LADDER.filter(l => levels.includes(l));
	return supported.find(l => LADDER.indexOf(l) >= LADDER.indexOf(level)) ?? supported[supported.length - 1] ?? level;
}

/** The level a role one notch harder than `level` runs `model` at: the next supported level whose recorded benchmark index beats `level`'s, skipping plateaus; without points for either level, the next supported level; with no level above that gains, `level` itself. */
export function gainStep(data: Data, model: string, level: string, levels: string[]): string {
	const supported = LADDER.filter(l => levels.includes(l));
	const at = supported.indexOf(level);
	if (at < 0) return level;
	const points = data.sweetSpots[model]?.points;
	const base = points?.[level]?.[0];
	for (const next of supported.slice(at + 1)) {
		const index = points?.[next]?.[0];
		if (base === undefined || index === undefined || index > base) return next;
	}
	return level;
}

/**
 * The modelRoles values the policy writes, given the user's `current` values and the values it wrote last time (`applied`).
 * A role without `above` keeps the model the user put in it and runs at that model's sweet spot (or the role's fixed `effort`, clamped to the model's levels); when the user changed only the level of a model the policy had written, that level stays.
 * A role with `above` runs the model of the role it names at `gainStep` above that role's level; a value the user wrote over the policy's last one stays.
 * A model with no recorded sweet spot keeps its value and is listed for research. Unset roles are left unset.
 */
export function resolveRoles({ data, current, applied, models }: { data: Data; current: Record<string, string | undefined>; applied: Record<string, string>; models: Model[] }): Resolution {
	const levelsOf = (model: string) => models.find(m => key(m) === model)?.levels ?? LADDER.slice(1);
	const set: Record<string, string> = {};
	const userSet: string[] = [];
	const research = new Set<string>();
	const effective: Record<string, string> = {};
	const entries = Object.entries(data.roles);
	for (const [role, spec] of entries) {
		const now = current[role];
		if ("above" in spec || now === undefined) continue;
		effective[role] = now;
		const chosen = parse(now);
		const last = applied[role] === undefined ? undefined : parse(applied[role]);
		if (last?.model === chosen.model && last.level !== chosen.level) {
			userSet.push(role);
			continue;
		}
		const spot = data.sweetSpots[chosen.model];
		if (!spot) {
			research.add(`sweet spot for ${chosen.model}`);
			continue;
		}
		effective[role] = set[role] = `${chosen.model}:${clamp(spec.effort ?? spot.effort, levelsOf(chosen.model))}`;
	}
	for (const [role, spec] of entries) {
		if (!("above" in spec)) continue;
		const base = effective[spec.above] === undefined ? undefined : parse(effective[spec.above]);
		if (!base?.level) continue;
		const target = `${base.model}:${gainStep(data, base.model, base.level, levelsOf(base.model))}`;
		const now = current[role];
		if (now !== undefined && applied[role] !== undefined && now !== applied[role] && now !== target) {
			userSet.push(role);
			continue;
		}
		set[role] = target;
	}
	return { set, userSet, research: [...research] };
}

/** The selector a harder task should run on instead of `selector` (`provider/model:level`): the same model's next supported level, unless another model in `candidates` (the selectors the roles use) has a cheaper point whose index reaches that next level, in which case the cheapest such point wins. A model without points steps one level on itself; the top level stays. */
export function escalationTarget(data: Data | undefined, selector: string, candidates: readonly string[]): string | undefined {
	const { model, level } = parse(selector);
	if (level === undefined) return undefined;
	const own = data?.sweetSpots[model]?.points;
	const supported = LADDER.filter(l => (own ? l in own : l !== "minimal"));
	const at = supported.indexOf(level);
	const next = at < 0 ? undefined : supported[Math.min(supported.length - 1, at + 1)];
	if (next === undefined) return undefined;
	const reach = own?.[next];
	let best = { target: `${model}:${next}`, cost: reach?.[1] ?? Infinity, index: reach?.[0] ?? -Infinity };
	if (!data || !reach) return best.target;
	for (const other of new Set(candidates.map(c => parse(c).model))) {
		if (other === model) continue;
		for (const [l, [index, cost]] of Object.entries(data.sweetSpots[other]?.points ?? {})) {
			if (index >= reach[0] && (cost < best.cost || (cost === best.cost && index > best.index))) best = { target: `${other}:${l}`, cost, index };
		}
	}
	return best.target;
}
