// Real wiring of the comment engine: the YouTube/Instagram connection of features/youtube-instagram, the website adapter, the owner's tone
// profiles of features/reply-drafts, and the one subscription-only model call. The gateway and the watch/onboard scripts build the engine here.
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { loadStyle, recordCorrection } from "../../features/reply-drafts/lib/settings.ts";
import { loadConfig, realCtx } from "../../features/youtube-instagram/lib/config.ts";
import { commentsFor, mediaWithCounts, reply as igReply } from "../../features/youtube-instagram/lib/instagram.ts";
import { commentThreadsSince, ownReplies, recentUploads, replyToComment, videoInfos } from "../../features/youtube-instagram/lib/youtube.ts";
import { appBase, appEntries, commentOwner } from "../integrations.ts";
import { featureEnabled } from "../app-feature-flags.ts";
import { callReplyModel } from "../reply-model.ts";
import { appOf, type DraftModel, createEngine, type Engine } from "./engine.ts";
import { instagramAdapter, youtubeAdapter } from "./adapters/google-meta.ts";
import { bunExec, websiteAdapter } from "./adapters/website.ts";
import { commentsDir } from "./store.ts";

const requireYoutube = () => {
	const y = loadConfig().youtube;
	if (!y) throw new Error("유튜브가 연결돼 있지 않아요");
	return y;
};
const requireInstagram = () => {
	const i = loadConfig().instagram;
	if (!i) throw new Error("인스타가 연결돼 있지 않아요");
	return i;
};

export const realModel: DraftModel = async (system, user, app) => {
	const r = await callReplyModel(app ?? "site", undefined, system, user);
	return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
};

export function realEngine(dataDir: string, opts: { broadcast?: (e: Record<string, unknown>) => void; collector?: string; model?: DraftModel } = {}): Engine {
	const dir = commentsDir(dataDir);
	const secretsDir = join(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"), "secrets");
	return createEngine({
		dir,
		now: Date.now,
		collector: opts.collector ?? hostname(),
		model: opts.model ?? realModel,
		// custom/apps.json is read live: a site added as its own app instance owns its threads, its needs and its reply model setting.
		owner: src => commentOwner(appEntries(dataDir), appOf(src), src.key),
		broadcast: opts.broadcast,
		// Only the website app (or an instance of it) has its own 댓글 답글 switch; YouTube and Instagram follow their 자동 초안 setting, which the reply-drafts flow reads (appOn).
		featureOn: (app, id) => appBase(app) !== "site" || featureEnabled(dataDir, app, id),
		style: src => loadStyle({ app: src.key }),
		learn: (src, change) => recordCorrection({ app: src.key }, change, new Date()),
		adapters: {
			youtube: youtubeAdapter(() => ({
				channelId: () => requireYoutube().channel_id,
				threadsSince: (id, since) => commentThreadsSince(realCtx(), id, since),
				uploads: id => recentUploads(realCtx(), id, 50),
				videos: ids => videoInfos(realCtx(), ids),
				reply: (parent, text) => replyToComment(realCtx(), parent, text),
				ownReplies: (id, limit) => ownReplies(realCtx(), id, limit),
			})),
			instagram: instagramAdapter(() => ({
				username: () => requireInstagram().username,
				media: () => mediaWithCounts(realCtx(), 50),
				comments: id => commentsFor(realCtx(), id),
				reply: (id, text) => igReply(realCtx(), id, text),
			})),
			website: websiteAdapter({ exec: bunExec, fetch, secretsDir, siteDir: join(dir, "sites") }),
		},
	});
}
