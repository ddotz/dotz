// Whether the Instagram token can publish Reels. Meta has no call that lists a token's scopes, so the state is learned: a publish that
// answers API code 10 (no instagram_business_content_publish) sets it, a new token (setup, token source sync) or a publish that works clears
// it. Reads of this file by the hub (hub/app-features.ts) show the owner why a Reels upload cannot go out yet.
import { existsSync, rmSync } from "node:fs";
import { type Ctx, paths, readJson, writeJson } from "./config.ts";

export const PUBLISH_SCOPE = "instagram_business_content_publish";
// Shown to the owner (card, approval row, watch line): which permission is missing and where the token is made again.
export const PUBLISH_MISSING_KO = `릴스를 올리려면 ${PUBLISH_SCOPE} 권한이 필요해요. Meta 앱 대시보드의 Instagram API 설정에서 '액세스 토큰 생성'으로 토큰을 다시 만들어 주세요`;
export const PUBLISH_BLOCKED_CARD = `아직 릴스를 올릴 수 없어요. ${PUBLISH_MISSING_KO}`;

export type PublishState = { missing: boolean; since?: string };

export function publishState(): PublishState {
	try {
		const s = readJson<{ missing?: boolean; since?: string }>(paths.igPublish());
		return s?.missing ? { missing: true, since: s.since } : { missing: false };
	} catch {
		return { missing: false };
	}
}

export function setPublishMissing(ctx: Ctx): void {
	if (publishState().missing) return;
	writeJson(paths.igPublish(), { missing: true, since: ctx.now().toISOString() });
}

export function clearPublishMissing(): void {
	if (existsSync(paths.igPublish())) rmSync(paths.igPublish(), { force: true });
}
