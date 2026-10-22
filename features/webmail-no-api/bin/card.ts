// Home card data command (kv view). Offline- and pre-setup-safe: it reads only this site's local files (the watch's
// status.json and the onboarding state), never the network, so it never fails the card.
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, paths } from "../lib/config.ts";

const readJson = (f: string): any => {
	try {
		return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
	} catch {
		return undefined;
	}
};
const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function card(site: string): Record<string, string> {
	const config = loadConfig(site);
	const ob = readJson(paths.onboard(site));
	if (!config) {
		if (ob && ob.status !== "done") return { 상태: `연결 중 멈춤: ${ob.message ?? ob.current ?? "다시 실행하면 이어서 해요"}` };
		return { 상태: "연결 전이에요. zele로 안 되는 메일을 쓰고 싶다고 채팅에 말해 주세요" };
	}
	const st = readJson(paths.status(site));
	const out: Record<string, string> = { 확인간격: `${config.poll_minutes}분` };
	if (!st) out.상태 = "첫 확인을 기다리는 중";
	else if (st.loggedOut) out.상태 = "로그인이 풀렸어요";
	else if (st.failing) out.상태 = "확인이 계속 실패해요";
	else out.상태 = st.lastOk ? `정상 (${kst(st.lastOk)} 확인)` : "확인 중";
	if (st?.lastNewAt) out.최근새메일 = `${kst(st.lastNewAt)} ${st.lastNewCount}통`;
	return out;
}

if (import.meta.main) console.log(JSON.stringify(card(process.env.WEBMAIL_SITE ?? process.argv[2] ?? "")));
