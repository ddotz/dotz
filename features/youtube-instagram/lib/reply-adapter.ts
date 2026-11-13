// What YouTube and Instagram keep for the tone of replies (the owner's own past replies), the title of a watch line, and whether a platform is
// connected. Comment replies themselves are drafted and sent by the comments app (hub/comments), not here.
import { type Config, type Ctx, loadConfig, SetupError } from "./config.ts";
import { ownerView } from "./ig-owner.ts";
import { commentsFor, mediaWithCounts } from "./instagram.ts";
import { COSTS, can } from "./quota.ts";
import { oneLine, type Platform } from "./watchkit.ts";
import { ownReplies } from "./youtube.ts";

export const titleArg = (title: string | undefined): string => (title ? ` title=${JSON.stringify(oneLine(title, 80))}` : "");

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
		const owner = { userId: cfg.instagram.user_id, username: cfg.instagram.username };
		for (const m of (await mediaWithCounts(ctx)).filter(x => x.comments_count > 0).slice(0, 10)) {
			const list = await commentsFor(ctx, m.id);
			const view = ownerView(list, owner);
			for (const c of list) for (const r of c.replies) if (view.isOwner(r)) texts.push(r.text);
			if (texts.length >= limit) break;
		}
	}
	return texts;
}
