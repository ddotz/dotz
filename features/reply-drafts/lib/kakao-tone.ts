// Tone source for KakaoTalk rooms: the user's own text lines of ONE room (fromMe, type 1) from the hub/kakao reader -> that room's
// profile, tone/kakao/<chatId>.md. The reader is injected (tests use hub/kakao/fixture.ts); nothing here talks to the app or sends.
import { readFileSync } from "node:fs";
import type { Msg } from "../../../hub/kakao/types.ts";
import { dataDir, hasSamples } from "./settings.ts";
import { learnTone, type LearnResult } from "./tone.ts";

export type OwnerReader = { messages: (chatId: string, limit: number) => Promise<Msg[]> };

export const KAKAO_APP = "kakao";
const READ_LIMIT = 200;

// Newest first, like the sent-mail source.
export async function kakaoOwnTexts(reader: OwnerReader, chatId: string, limit = READ_LIMIT): Promise<string[]> {
	return (await reader.messages(chatId, limit)).filter(m => m.fromMe && m.type === 1 && m.text.trim()).map(m => m.text).reverse();
}

export async function learnKakaoRoom(chatId: string, reader: OwnerReader): Promise<LearnResult> {
	const texts = await kakaoOwnTexts(reader, chatId);
	return learnTone({ app: KAKAO_APP, room: chatId }, { texts, textsLabel: `이 대화방에서 보낸 말 ${texts.length}개` });
}

// First use of a room: learns it only when its own profile has no samples yet. Returns the learn result, or undefined when nothing was needed.
export async function ensureKakaoRoom(chatId: string, reader: () => Promise<OwnerReader>): Promise<LearnResult | undefined> {
	if (hasSamples({ app: KAKAO_APP, room: chatId })) return undefined;
	return learnKakaoRoom(chatId, await reader());
}

// The real reader: the hub/kakao database reader, only for a room the integration may draft for (same rule as `cli.ts read`).
export async function defaultKakaoReader(chatId: string): Promise<OwnerReader> {
	const { kakaoPaths } = await import("../../../hub/kakao/types.ts");
	const { realCtx } = await import("../../../hub/kakao/cli.ts");
	const paths = kakaoPaths(dataDir());
	let config: any;
	try {
		config = JSON.parse(readFileSync(paths.config, "utf8"));
	} catch {}
	if (config?.enabled !== true) throw new Error("카톡 연동이 꺼져 있어요");
	const reader = await realCtx(paths).reader(config);
	const room = (await reader.rooms()).find(r => r.chatId === chatId);
	if (!room || !reader.draftable(room)) throw new Error("이 대화방은 말투를 배울 수 없어요 (답장 초안 대상이 아니에요)");
	return reader;
}
