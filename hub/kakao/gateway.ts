// Real wiring of the KakaoTalk web routes and the live watcher inside the gateway (hub/routes.ts and hub/main.ts import this).
// Tests build createKakaoWeb / createLive with fakes instead.
import { hostname } from "node:os";
import { loadSettings, loadStyle } from "../../features/reply-drafts/lib/settings.ts";
import { cfg, DATA_DIR, log } from "../config.ts";
import { broadcast, subscriberCount } from "../events.ts";
import { resolveName } from "../machine-name.ts";
import { getSecret } from "./creds.ts";
import { type KakaoDb, sqlcipherDb } from "./db.ts";
import type { DraftModel, StyleHint } from "./draft.ts";
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

const live = createLive({ paths, readConfig: () => readConfig(paths), openDb, subscribers: subscriberCount, broadcast, log });
// The one model call of a draft request (subscription only: outlang.ts never falls back to an API key). The model is the reply-drafts
// setting `model` when set, else outlang's small-model default (OmO: anthropic-subscription/claude-sonnet-5-5, never Haiku; omp: @tiny).
const draftModel: DraftModel = async (system, user) => {
	const { callModel } = await import("../outlang.ts");
	const r = await callModel(system, user, { model: loadSettings().model, timeoutMs: 120_000 });
	return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
};
const draftStyle = (chatId: string): StyleHint => {
	const s = loadStyle({ app: "kakao", room: chatId });
	return { rules: s.rules, corrections: s.corrections, forbidden: s.forbidden, samples: s.samples };
};

const web = createKakaoWeb({
	paths,
	runner: defaultRunner,
	now: Date.now,
	openDb,
	broadcast,
	onWatchChange: () => void live.sync(),
	collector: resolveName(cfg.web?.machine_name, hostname()),
	draftModel,
	draftStyle,
});

export const kakaoRoute = web.route;
export const startKakaoLive = () => void live.sync();
export const stopKakaoLive = () => live.stop();
