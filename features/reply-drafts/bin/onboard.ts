// Turns the feature on or off for THIS install and learns the user's tone: `on [--app mail|youtube|instagram] [--to <target>]`,
// `off [--app <app>]`, `status`, `learn [--app <app|install>] [--room <id>] [--from-file <f>]`.
// On = the source's own switch in config.json + a personal copy of the shipped feature.md with enabled: true (a personal folder of the
// same id replaces the shipped one; same switch as webmail-no-api). Every source starts off; `on --app youtube` leaves mail and instagram
// as they were. youtube and instagram need the SNS connection first (exit 3 with the next step when it is missing), and each learns its
// own tone from the user's own past replies on that platform. Prints one Korean summary line the orchestrator relays to whoever asked.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, realCtx } from "../../youtube-instagram/lib/config.ts";
import { cleanExample, ownReplyTexts, snsConnected } from "../../youtube-instagram/lib/reply-adapter.ts";
import type { Platform } from "../../youtube-instagram/lib/watchkit.ts";
import { appOn, dataDir, listProfiles, loadSettings, paths, REPO_FEATURE, saveSettings, setApp, validApp, type ToneKey } from "../lib/settings.ts";
import { learnTone, realRunner, toneSummary, zeleEnabled, type Runner } from "../lib/tone.ts";

type Out = { lines: string[]; code: number };
export type SnsAccess = { connected: (p: Platform) => boolean; ownTexts: (p: Platform) => Promise<string[]> };

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const SNS: Record<string, string> = { youtube: "유튜브", instagram: "인스타" };
const SNS_ONBOARD = join(REPO_FEATURE, "..", "youtube-instagram", "bin", "onboard.ts");

export const realSns: SnsAccess = {
	connected: snsConnected,
	ownTexts: async p => (await ownReplyTexts(realCtx(), loadConfig(), p, 30)).map(cleanExample).filter(Boolean),
};

function installConfig(): Record<string, any> | undefined {
	try {
		return JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"));
	} catch {
		return undefined;
	}
}

function writeSwitch(): void {
	const shipped = readFileSync(join(REPO_FEATURE, "feature.md"), "utf8");
	mkdirSync(dirname(paths.personalFeature()), { recursive: true });
	writeFileSync(paths.personalFeature(), shipped.replace(/^enabled:\s*false\s*$/m, "enabled: true"));
}

async function learn(key: ToneKey, opts: Parameters<typeof learnTone>[1]): Promise<string> {
	try {
		return toneSummary(await learnTone(key, opts));
	} catch (e) {
		return `말투를 배우지 못했어요: ${(e as Error).message}. 정중한 기본 말투로 시작해요.`;
	}
}

export async function runOnboard(args: string[], run: Runner = realRunner, zeleOn: boolean = zeleEnabled(installConfig()), sns: SnsAccess = realSns): Promise<Out> {
	const [cmd] = args;
	const app = flag(args, "--app");
	switch (cmd) {
		case "on": {
			if (app === undefined || app === "mail") {
				setApp("mail", true);
				writeSwitch();
				return { lines: [`답장 초안을 켰어요. 새 메일 중 답장이 필요한 건 초안을 만들어 물어봐요. ${await learn({ app: "mail" }, { run, zeleOn })}`], code: 0 };
			}
			if (!(app in SNS)) return { lines: [`켤 수 있는 곳은 mail, youtube, instagram이에요: ${app}`], code: 2 };
			const platform = app as Platform;
			if (!sns.connected(platform)) {
				const to = flag(args, "--to");
				return { lines: [`${SNS[app]}이(가) 아직 연결되지 않았어요. 먼저 연결해 주세요: bun ${SNS_ONBOARD} run --${app}${to ? ` --target ${to}` : ""}`, `연결이 끝나면 같은 명령(onboard.ts on --app ${app})을 다시 실행해요`], code: 3 };
			}
			setApp(app, true);
			writeSwitch();
			let texts: string[] = [];
			let warning: string | undefined;
			try {
				texts = await sns.ownTexts(platform);
			} catch (e) {
				warning = `${SNS[app]}에서 지난 답글을 읽지 못했어요: ${(e as Error).message}`;
			}
			const tone = await learn({ app }, { texts, textsLabel: `${SNS[app]}에 쓴 답글 ${texts.length}개` });
			return { lines: [`${SNS[app]} 댓글 답글 초안을 켰어요. 새 댓글 중 답이 필요한 건 초안을 만들어 물어봐요. ${tone}${warning ? ` (${warning})` : ""}`], code: 0 };
		}
		case "off": {
			if (app === undefined) {
				saveSettings({ enabled: false });
				rmSync(paths.personalFeature(), { force: true });
				return { lines: ["답장 초안을 껐어요. 배운 말투는 그대로 남겨 둬요."], code: 0 };
			}
			if (app !== "mail" && !(app in SNS)) return { lines: [`끌 수 있는 곳은 mail, youtube, instagram이에요: ${app}`], code: 2 };
			setApp(app, false);
			return { lines: [`${app === "mail" ? "메일" : SNS[app]} 답장 초안을 껐어요. 배운 말투는 그대로 남겨 둬요.`], code: 0 };
		}
		case "learn": {
			const file = flag(args, "--from-file");
			const learnApp = app ?? "mail";
			const room = flag(args, "--room");
			if (learnApp !== "install" && !validApp(learnApp)) return { lines: [`앱 이름은 영문 소문자·숫자·-만 쓸 수 있어요: ${learnApp}`], code: 1 };
			if (file && !existsSync(file)) return { lines: [`파일을 찾지 못했어요: ${file}`], code: 1 };
			return { lines: [await learn({ app: learnApp, ...(room !== undefined ? { room } : {}) }, { fromFile: file, run, zeleOn })], code: 0 };
		}
		case "status": {
			const s = loadSettings();
			const state = (a: string) => (appOn(s, a) ? "켜짐" : "꺼짐");
			return { lines: [`${s.enabled ? "켜짐" : "꺼짐"} · 메일 ${state("mail")} · 유튜브 ${state("youtube")} · 인스타 ${state("instagram")} · 말투 프로필 ${listProfiles().join(", ") || "없음"}`], code: 0 };
		}
		default:
			return { lines: ["usage: onboard.ts on [--app mail|youtube|instagram] [--to <target>] | off [--app <app>] | status | learn [--app <app|install>] [--room <id>] [--from-file <file>]"], code: 2 };
	}
}

if (import.meta.main) {
	const out = await runOnboard(process.argv.slice(2));
	for (const l of out.lines) (out.code === 0 ? console.log : console.error)(l);
	process.exit(out.code);
}
