import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { NoticeText } from "../notice.ts";
import { liveClaims, livePeers, peersDir } from "../peers/bus.ts";
import { list, type Result, type Row } from "./ovnfs.ts";
import { type Placement, type SlotWork, workOf } from "./place.ts";
import { parseSlotName, slugOf } from "./slots.ts";

const SHOWN_PATHS = 3;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** How a slot stands: `live` (the names of the sessions whose cwd is in it, and `starting` when a launch has claimed it), `parked` (nobody holds it and `work` says what it holds), or `free`. */
export type SlotCondition =
	| { readonly state: "live"; readonly sessions: readonly string[]; readonly starting: boolean }
	| { readonly state: "parked"; readonly work: SlotWork }
	| { readonly state: "free" };

/** One slot of one folder: its checkout name and root, the real path of its folder, when ovnfs last saw it change (epoch ms, 0 when unknown) and its condition. */
export interface SlotReport {
	readonly name: string;
	readonly path: string;
	readonly folder: string;
	readonly n: number;
	readonly touched: number;
	readonly condition: SlotCondition;
}

type Say = (text: NoticeText) => string;

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function slotNumber(row: Row): number | undefined {
	return parseSlotName(row.name, slugOf(row.source));
}

/**
 * The state of every slot ovnfs lists, from one `ovnfs ls --json`: a row is a slot when its name is `main-<slug of its own source>-<n>`; only the slots whose source is `folder` when `folder` is given.
 * A slot is `live` while a live peer record has its cwd inside the slot or a launch claim names it, and `workOf` runs only for the others. Sorted by folder, then slot number.
 * ovnfs failing or answering something unreadable is `{ ok: false, why }`.
 */
export async function slotStates(folder?: string): Promise<Result<SlotReport[]>> {
	const listed = await list();
	if (!listed.ok) return listed;
	const wanted = folder === undefined ? undefined : realOrResolved(folder);
	const dir = peersDir();
	const peers = livePeers(dir).map(peer => ({ name: peer.name, cwd: realOrResolved(peer.cwd) }));
	const claimed = new Set(liveClaims(dir, Date.now()).map(entry => entry.slot));
	const slots = listed.value.filter(row => slotNumber(row) !== undefined && (wanted === undefined || row.source === wanted));
	const reports = await Promise.all(
		slots.map(async (row): Promise<SlotReport> => {
			const n = slotNumber(row) ?? 0;
			const path = realOrResolved(row.path);
			const sessions = [...new Set(peers.filter(peer => peer.cwd === path || peer.cwd.startsWith(path + sep)).map(peer => peer.name))].sort();
			const starting = claimed.has(row.name);
			const base = { name: row.name, path, folder: row.source, n, touched: row.touched };
			if (sessions.length > 0 || starting) return { ...base, condition: { state: "live", sessions, starting } };
			const placement: Placement = { name: row.name, path, folder: row.source, n, subdir: "" };
			const work = await workOf(placement);
			return { ...base, condition: work.work ? { state: "parked", work } : { state: "free" } };
		}),
	);
	return { ok: true, value: reports.sort((a, b) => a.folder.localeCompare(b.folder) || a.n - b.n) };
}

function ageText(touched: number, now: number, t: Say): string {
	if (touched <= 0) return t({ en: "unknown", ko: "알 수 없음" });
	const ms = Math.max(0, now - touched);
	if (ms < HOUR_MS) {
		const minutes = Math.floor(ms / 60_000);
		return t({ en: `${minutes} min ago`, ko: `${minutes}분 전` });
	}
	if (ms < 2 * DAY_MS) {
		const hours = Math.floor(ms / HOUR_MS);
		return t({ en: `${hours} h ago`, ko: `${hours}시간 전` });
	}
	const days = Math.floor(ms / DAY_MS);
	return t({ en: `${days} d ago`, ko: `${days}일 전` });
}

/** What `work` holds, in words: unlanded commits, the count of uncommitted paths with the first three named, or the git error that kept it from knowing. */
export function describeWork(work: SlotWork, t: Say): string {
	if (work.gitError !== undefined) return t({ en: `git could not tell what it holds (${work.gitError})`, ko: `git이 내용을 확인하지 못했습니다(${work.gitError})` });
	const parts: string[] = [];
	if (work.unlanded) parts.push(t({ en: "unlanded commits", ko: "폴더에 반영되지 않은 커밋" }));
	const count = work.uncommitted.length;
	if (count > 0) {
		const shown = `${work.uncommitted.slice(0, SHOWN_PATHS).join(", ")}${count > SHOWN_PATHS ? ", ..." : ""}`;
		parts.push(t({ en: `${count} uncommitted path${count === 1 ? "" : "s"} (${shown})`, ko: `커밋되지 않은 경로 ${count}개 (${shown})` }));
	}
	return parts.length > 0 ? parts.join(", ") : t({ en: "work", ko: "작업" });
}

/** Which `ovnfs` command moves what `work` holds into its folder: `land` for unlanded commits, `apply` for uncommitted paths; neither when git could not read the slot. */
export function mergeWays(work: SlotWork): { readonly land: boolean; readonly apply: boolean } {
	if (work.gitError !== undefined) return { land: false, apply: false };
	return { land: work.unlanded, apply: work.uncommitted.length > 0 };
}

/** The line for one parked slot: its name, folder, what it holds, the age of its last change at `now`, and the ways out: `omp -c`, and `ovnfs land` and/or `ovnfs apply` as `mergeWays` says. */
export function parkedLine(slot: SlotReport, t: Say, now: number): string {
	const what = slot.condition.state === "parked" ? describeWork(slot.condition.work, t) : "";
	const ways = slot.condition.state === "parked" ? mergeWays(slot.condition.work) : { land: false, apply: false };
	const age = ageText(slot.touched, now, t);
	const en = [`parked checkout ${slot.name} of ${slot.folder} holds ${what}; last change ${age}; \`omp -c\` in ${slot.folder} continues it`];
	const ko = [`주인 없는 체크아웃 ${slot.name} (${slot.folder})에 남은 작업: ${what}. 마지막 변경 ${age}. ${slot.folder}에서 \`omp -c\`로 이어서 할 수 있습니다`];
	if (ways.land) {
		en.push(`\`ovnfs land ${slot.name}\` run in ${slot.folder} lands its commits`);
		ko.push(`${slot.folder}에서 \`ovnfs land ${slot.name}\`로 커밋을 폴더에 반영할 수 있습니다`);
	}
	if (ways.apply) {
		en.push(`\`ovnfs apply ${slot.name}\` run in ${slot.folder} merges its uncommitted changes`);
		ko.push(`${slot.folder}에서 \`ovnfs apply ${slot.name}\`로 커밋되지 않은 변경을 폴더에 병합할 수 있습니다`);
	}
	return t({ en: en.join("; "), ko: ko.join(". ") });
}

/** The lines a person reads about `states`: one per parked slot, then per folder one summary of its live and free slots (none when a folder has only parked slots). Nothing when there are no slots. `now` replaces the clock. */
export function slotLines(states: readonly SlotReport[], t: Say, now: number = Date.now()): string[] {
	const lines: string[] = [];
	for (const slot of states) if (slot.condition.state === "parked") lines.push(parkedLine(slot, t, now));
	const folders = [...new Set(states.map(slot => slot.folder))];
	for (const folder of folders) {
		const own = states.filter(slot => slot.folder === folder);
		const live = own.filter(slot => slot.condition.state === "live").length;
		const free = own.filter(slot => slot.condition.state === "free").length;
		if (live + free === 0) continue;
		lines.push(t({ en: `checkouts of ${folder}: ${live} live, ${free} free`, ko: `${folder}의 체크아웃: 사용 중 ${live}개, 비어 있음 ${free}개` }));
	}
	return lines;
}

/** The line for a session that runs in slot `placement`: its slot, folder and whether it holds unlanded commits or uncommitted paths right now (`work` from `workOf`). */
export function ownSlotLine(placement: Placement, work: SlotWork, t: Say): string {
	const holds = work.work || work.gitError !== undefined ? describeWork(work, t) : t({ en: "no unlanded commits and no uncommitted paths", ko: "폴더에 반영되지 않은 커밋도, 커밋되지 않은 경로도 없음" });
	return t({ en: `this session runs in checkout ${placement.name} of ${placement.folder}: it holds ${holds} right now`, ko: `이 세션은 ${placement.folder}의 체크아웃 ${placement.name}에서 실행 중입니다. 지금 가진 것: ${holds}` });
}

/** The line saying the slots could not be listed, with ovnfs's reason. */
export function slotsUnlistedLine(why: string, t: Say): string {
	return t({ en: `checkout slots could not be listed: ${why}`, ko: `체크아웃 목록을 읽지 못했습니다: ${why}` });
}
