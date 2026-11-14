// Real wiring of the KakaoTalk web routes and the live watcher inside the gateway (hub/routes.ts and hub/main.ts import this).
// Tests build createKakaoWeb / createLive with fakes instead.
import { useReplies } from "../reply-actions.ts";
import { hostname } from "node:os";
import { enableKakaoApp, ensureKakaoVoice } from "../../features/reply-drafts/lib/kakao-voice.ts";
import { loadStyle } from "../../features/reply-drafts/lib/settings.ts";
import { cfg, DATA_DIR, log } from "../config.ts";
import { broadcast, subscriberCount } from "../events.ts";
import { resolveName } from "../machine-name.ts";
import { peerHeaders, peerTokenFor } from "../peer-auth.ts";
import { knownComputers } from "../peers.ts";
import { claimLease, postLease } from "../send-lease.ts";
import { getSecret } from "./creds.ts";
import { type KakaoDb, sqlcipherDb } from "./db.ts";
import { callReplyModel } from "../reply-model.ts";
import { replyLearning } from "../reply-mail.ts";
import { kakaoAdapter } from "./reply-adapter.ts";
import { type DraftModel, type StyleHint, type VoiceSource } from "./draft.ts";
import { createLive } from "./live.ts";
import { defaultRunner, type KakaoConfig, kakaoPaths } from "./types.ts";
import { createKakaoWeb, readConfig } from "./web.ts";

const paths = kakaoPaths(DATA_DIR);

let key: string | undefined;
let opened: { dbPath: string; db: KakaoDb } | undefined;
const openDb = async (config: KakaoConfig): Promise<KakaoDb> => {
	if (!config.dbPath) throw new Error("no database path");
	if (opened?.dbPath === config.dbPath) return opened.db;
	key ??= await getSecret("dbkey", { paths, runner: defaultRunner });
	if (!key) throw new Error("no database key");
	opened = { dbPath: config.dbPath, db: sqlcipherDb(config.dbPath, key, defaultRunner) };
	return opened.db;
};

const live = createLive({ paths, readConfig: () => readConfig(paths), openDb, subscribers: subscriberCount, broadcast, log, statPollMs: 500 });
// The one model call of a draft request (subscription only: outlang.ts never falls back to an API key). The model is the room's app setting
// 답장 모델, else the reply-drafts `model`, else the subagent model (hub/reply-model.ts); never Haiku, mini or the omp @tiny role.
const draftModel: DraftModel = async (system, user, chatId) => {
	const r = await callReplyModel("kakao", chatId ? `kakao:${chatId}` : undefined, system, user);
	return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
};
const draftStyle = (chatId: string): StyleHint => {
	const s = loadStyle({ app: "kakao", room: chatId });
	return { rules: s.rules, corrections: s.corrections, forbidden: s.forbidden, samples: s.samples };
};

const learnVoice = async (src: VoiceSource) => {
	enableKakaoApp();
	const r = await ensureKakaoVoice(src);
	if (r.mode) log(`kakao voice ${r.mode} room=${src.chatId} model tokens in=${r.tokens?.in ?? 0} out=${r.tokens?.out ?? 0} profile=${r.profile.length > 0}`);
};

// A revise that was stored teaches its lesson (never the raw request, never before the new draft exists), then the profile may fold it in.
const learning = replyLearning();
const onRevise = (chatId: string, lesson: string) => {
	const key = { app: "kakao", room: chatId };
	void learning.record(key, lesson).then(() => learning.refine(key)).catch(e => log(`kakao lesson for ${chatId} not recorded: ${e instanceof Error ? e.message : String(e)}`));
};

const machine = resolveName(cfg.web?.machine_name, hostname());
// One sender per room across this owner's computers (docs/peer-monitoring.md): before a send, this gateway claims the room's lease here
// and on every other gateway; a computer that holds it refuses, and the send does not run.
const LEASE_MS = 60_000;
const HELD = (holder?: string) => `${holder ?? "다른 컴퓨터"}에서 이 대화방으로 보내는 중이라 보내지 않았어요`;
const lease = async (chatId: string) => {
	const peers = (await knownComputers()).filter(c => !c.self);
	const r = await claimLease({ key: `kakao:${chatId}`, self: machine, ttlMs: LEASE_MS, peers, now: Date.now, post: (p, path, body) => postLease(p.url, path, body, peerHeaders(peerTokenFor(p.url))) });
	return r.ok ? { ok: true as const } : { ok: false as const, reason: r.reason === "held" ? HELD(r.holder) : "이 대화방으로 보낼 수 있는지 확인하지 못해서 보내지 않았어요" };
};

const web = createKakaoWeb({
	paths,
	runner: defaultRunner,
	now: Date.now,
	openDb,
	broadcast,
	onWatchChange: () => void live.sync(),
	collector: machine,
	lease,
	draftModel,
	draftStyle,
	learnVoice,
	onRevise,
	replies: useReplies,
});

export const kakaoRoute = web.route;
// The KakaoTalk adapter of the one reply flow (hub/reply-wire.ts).
export const kakaoReply = kakaoAdapter(web.replyKit);
export const kakaoUnreplied = web.unrepliedCount;
export const kakaoDraftFacts = web.draftFacts;
export const kakaoPendingCount = web.pendingCount;
export const startKakaoLive = () => void live.sync();
export const stopKakaoLive = () => live.stop();
