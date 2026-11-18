const EFFORT_RANK: Record<string, number> = { minimal: 0, lo: 0, low: 0, med: 1, medium: 1, hi: 2, high: 2, xhigh: 3, max: 4 };

const rankOf = (effort: string | undefined): number | undefined => (effort === undefined ? undefined : EFFORT_RANK[effort.trim().toLowerCase()]);

/** Refuses a spawn whose effort is more than one level above its role's effort. */
export function effortProblem(spawnEffort: string | undefined, roleEffort: string | undefined): string | undefined {
	const spawn = rankOf(spawnEffort);
	const role = rankOf(roleEffort);
	if (spawn === undefined || role === undefined || spawn - role <= 1) return undefined;
	return `orchestrator-guard: effort "${spawnEffort}"는 역할 기본값 "${roleEffort}"보다 두 단계 이상 높아서 막았어요. 어려운 작업이라도 한 단계까지만 올릴 수 있습니다. effort를 낮춰 다시 spawn하세요.`;
}

const REVIEWER_AGENTS = new Set(["reviewer", "security-reviewer"]);
const PATCH_PATH = /(?:^|[\s"'`(=])(\/[^\s"'`)<>]*\.patch)\b/g;

/** Absolute .patch paths named in the task text of reviewer / security-reviewer tasks, or in the shared context of a batch that has one. */
export function reviewedPatchesIn(taskInput: unknown): string[] {
	const input = taskInput as { tasks?: unknown; context?: unknown } | null | undefined;
	const tasks = input?.tasks;
	if (!Array.isArray(tasks)) return [];
	const reviews = (tasks as { agent?: unknown; task?: unknown }[]).filter(item => typeof item?.task === "string" && REVIEWER_AGENTS.has(String(item.agent)));
	const texts = reviews.map(item => String(item.task));
	if (reviews.length > 0 && typeof input?.context === "string") texts.push(input.context);
	return [...new Set(texts.flatMap(text => [...text.matchAll(PATCH_PATH)].map(m => m[1])))];
}

/** Refuses applying a patch over the threshold of changed lines unless a reviewer task named it. */
export function reviewProblem(patch: string, changedLines: number, reviewedPatches: ReadonlySet<string>, threshold = 300): string | undefined {
	if (changedLines <= threshold || reviewedPatches.has(patch)) return undefined;
	return `orchestrator-guard: 패치 ${patch}는 ${changedLines}줄을 바꿔서(기준 ${threshold}줄) 리뷰 없이는 적용을 막았어요. 먼저 \`reviewer\` 에이전트(보안 관련이면 \`security-reviewer\`)에 이 패치 경로를 알려 리뷰시킨 뒤 다시 적용하세요.`;
}

export const WORKER_FOOTER_LINES: readonly string[] = [
	"If a needed step is refused or fails, report `[fail]` with what was blocked and the exact reason; never write expected output, a guessed result or a placeholder in its place.",
	"Anything not checkable here carries `instead checked:` with what was checked in its place; a bare \"unverified\" line is not allowed.",
	"Close your todos before the final report, and make the full report the very last message.",
];

const FABLE_LIMIT_IDS = new Set(["anthropic:7d:fable", "anthropic:7d_fable", "claude:7d_fable"]);

/** Refuses a deep-tier spawn (deep-reviewer or a fable model) when the 7d fable window has under `margin` percent left. */
export function deepBudgetProblem(
	limits: readonly { id: string; amount?: { remaining?: number } }[],
	agent: string | undefined,
	model: string | undefined,
	margin = 10,
): string | undefined {
	const deep = agent === "deep-reviewer" || (model?.toLowerCase().includes("fable") ?? false);
	if (!deep) return undefined;
	const remaining = limits.find(l => FABLE_LIMIT_IDS.has(l.id))?.amount?.remaining;
	if (typeof remaining !== "number" || remaining >= margin) return undefined;
	return `orchestrator-guard: fable 7d 한도가 ${remaining}% 남아(기준 ${margin}%) deep 티어 spawn을 막았어요. 사용자에게 남은 %를 보여 주고 물어보세요: 기본 티어로 바꿔 진행할지, 리셋을 기다릴지.`;
}

/** Effort configured for `role` in the `modelRoles` block of a config.yml (`role: provider/model:effort`). */
export function roleEffortIn(configText: string, role: string): string | undefined {
	const block = /^modelRoles:[ \t]*\n((?:[ \t]+\S[^\n]*\n?)*)/m.exec(configText)?.[1] ?? "";
	for (const line of block.split("\n")) {
		const entry = /^\s+([\w-]+):\s*(\S+)\s*$/.exec(line);
		if (entry?.[1] === role) return /:([a-z]+)$/i.exec(entry[2])?.[1];
	}
	return undefined;
}

/** The role an agent definition runs on: `model: "@role"` in its frontmatter. */
export function agentRoleIn(agentText: string): string | undefined {
	const front = /^---\n([\s\S]*?)\n---/.exec(agentText)?.[1] ?? "";
	return /^model:\s*["']?@([\w-]+)["']?\s*$/m.exec(front)?.[1];
}

/** Changed lines (added plus removed) of a unified diff, counted by hunk lengths so header rows are never counted. */
export function patchChangedLines(patch: string): number {
	const rows = patch.split("\n");
	let changed = 0;
	for (let i = 0; i < rows.length; i++) {
		const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(rows[i]);
		if (!hunk) continue;
		let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
		let newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
		while ((oldLeft > 0 || newLeft > 0) && i + 1 < rows.length) {
			const row = rows[++i];
			if (row[0] === "-") {
				oldLeft--;
				changed++;
			} else if (row[0] === "+") {
				newLeft--;
				changed++;
			} else if (row[0] !== "\\") {
				oldLeft--;
				newLeft--;
			}
		}
	}
	return changed;
}
