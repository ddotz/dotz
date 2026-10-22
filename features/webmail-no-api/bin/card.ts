// Home card data command (kv view). Offline- and pre-setup-safe: it only reads local files, never the network, so it never
// fails the card. Before setup it tells the owner how to turn the site on.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadConfig, loadSpec } from "../lib/config.ts";

const SITE = process.env.WEBMAIL_SITE ?? process.argv[2] ?? "";

function watchState(site: string): any {
	const f = join(dataDir(), "watches");
	if (!existsSync(f)) return undefined;
	for (const dir of readdirSync(f)) {
		const sf = join(f, dir, "state.json");
		if (existsSync(sf)) {
			try {
				const s = JSON.parse(readFileSync(sf, "utf8"));
				if (Array.isArray(s.seen)) return s;
			} catch {}
		}
	}
	return undefined;
}

function card(): Record<string, string> {
	const spec = loadSpec(SITE);
	const config = loadConfig(SITE);
	if (!spec || !config) return { 상태: `설정 전이에요. 채팅에서 "${SITE || "회사"} 메일 설정해줘"라고 말해 주세요` };
	const st = watchState(SITE);
	const out: Record<string, string> = { 사이트: SITE, 확인간격: `${config.poll_minutes}분` };
	if (st?.loggedOut) out.상태 = "로그인이 풀렸어요";
	else if (st?.lastOk) out.상태 = `정상 (마지막 확인 ${new Date(st.lastOk).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })})`;
	else out.상태 = "감시 대기 중";
	return out;
}

if (import.meta.main) console.log(JSON.stringify(card()));
