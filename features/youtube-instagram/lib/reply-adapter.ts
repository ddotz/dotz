// The YouTube and Instagram side of the reply-drafts comment adapter (features/reply-drafts/lib/comments.ts): the watch lines
// `yt-comment <id> video=.. by=..: text` / `ig-comment <id> media=.. by=..: text`, the pending reply job behind an ask, and the
// owner's own past replies a tone is learned from. One implementation for both platforms.
import { type CommentAdapter, type CommentDeps, draftComments } from "../../reply-drafts/lib/comments.ts";
import { type Config, type Ctx, loadConfig, SetupError } from "./config.ts";
import { commentsFor, mediaWithCounts } from "./instagram.ts";
import { newJob, reject } from "./jobs.ts";
import { COSTS, can } from "./quota.ts";
import { oneLine, type Platform, type RunResult } from "./watchkit.ts";
import { ownReplies } from "./youtube.ts";

const LINE = {
	youtube: { tag: "yt-comment", where: "video", label: "유튜브", context: "YouTube video" },
	instagram: { tag: "ig-comment", where: "media", label: "인스타", context: "Instagram post" },
} as const;

export function snsAdapter(ctx: Ctx, platform: Platform): CommentAdapter {
	const l = LINE[platform];
	const re = new RegExp(`^${l.tag} (\\S+) ${l.where}=(\\S+) by=(.*?): (.*)$`);
	return {
		app: platform,
		label: l.label,
		parse: line => {
			const m = re.exec(line);
			return m ? { id: m[1]!, author: m[3]!.trim(), text: m[4]!, context: `${l.context} ${m[2]}` } : undefined;
		},
		stage: async (c, reply) => newJob(ctx, { kind: "reply", reply: { platform, comment_id: c.id, text: reply } }).id,
		discard: async id => void reject(id),
	};
}

export async function withReplyDrafts(ctx: Ctx, platform: Platform, res: RunResult, deps?: CommentDeps): Promise<RunResult> {
	if (res.code !== 0 || !res.lines.length) return res;
	return { ...res, lines: await draftComments(snsAdapter(ctx, platform), res.lines, deps) };
}

export function snsConnected(platform: Platform): boolean {
	try {
		return Boolean(loadConfig()[platform]);
	} catch (e) {
		if (e instanceof SetupError) return false;
		throw e;
	}
}

export const cleanExample = (s: string): string => oneLine(s.replace(/@\S+/g, ""), 200);

// The owner's own replies on one platform, newest first as the platform lists them; nothing when the quota is short.
export async function ownReplyTexts(ctx: Ctx, cfg: Config, platform: Platform, limit: number): Promise<string[]> {
	const texts: string[] = [];
	if (platform === "youtube" && cfg.youtube && can(ctx, cfg, COSTS.list * 3)) texts.push(...(await ownReplies(ctx, cfg.youtube.channel_id, limit)));
	if (platform === "instagram" && cfg.instagram) {
		const owner = cfg.instagram.username.toLowerCase();
		for (const m of (await mediaWithCounts(ctx)).filter(x => x.comments_count > 0).slice(0, 10)) {
			for (const c of await commentsFor(ctx, m.id)) for (const r of c.replies) if (r.username.toLowerCase() === owner) texts.push(r.text);
			if (texts.length >= limit) break;
		}
	}
	return texts;
}
