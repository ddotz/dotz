// Turns the feature on or off for THIS install and learns the user's tone: `on [--to <target>]`, `off`, `status`, `learn [--app <app|install>] [--room <id>] [--from-file <f>]`.
// On = config.json enabled + a personal copy of the shipped feature.md with enabled: true (a personal folder of the same id replaces the
// shipped one; same switch as webmail-no-api). Prints one Korean summary line the orchestrator relays to whoever asked (--to).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, listProfiles, loadSettings, paths, REPO_FEATURE, saveSettings, validApp, type ToneKey } from "../lib/settings.ts";
import { learnTone, realRunner, toneSummary, zeleEnabled, type Runner } from "../lib/tone.ts";

type Out = { lines: string[]; code: number };

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

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

async function learn(key: ToneKey, fromFile: string | undefined, run: Runner, zeleOn: boolean): Promise<string> {
	try {
		return toneSummary(await learnTone(key, { fromFile, run, zeleOn }));
	} catch (e) {
		return `말투를 배우지 못했어요: ${(e as Error).message}. 정중한 기본 말투로 시작해요.`;
	}
}

export async function runOnboard(args: string[], run: Runner = realRunner, zeleOn: boolean = zeleEnabled(installConfig())): Promise<Out> {
	const [cmd] = args;
	switch (cmd) {
		case "on": {
			saveSettings({ enabled: true });
			writeSwitch();
			return { lines: [`답장 초안을 켰어요. 새 메일 중 답장이 필요한 건 초안을 만들어 물어봐요. ${await learn({ app: "mail" }, undefined, run, zeleOn)}`], code: 0 };
		}
		case "off": {
			saveSettings({ enabled: false });
			rmSync(paths.personalFeature(), { force: true });
			return { lines: ["답장 초안을 껐어요. 배운 말투는 그대로 남겨 둬요."], code: 0 };
		}
		case "learn": {
			const file = flag(args, "--from-file");
			const app = flag(args, "--app") ?? "mail";
			const room = flag(args, "--room");
			if (app !== "install" && !validApp(app)) return { lines: [`앱 이름은 영문 소문자·숫자·-만 쓸 수 있어요: ${app}`], code: 1 };
			if (file && !existsSync(file)) return { lines: [`파일을 찾지 못했어요: ${file}`], code: 1 };
			return { lines: [await learn({ app, ...(room !== undefined ? { room } : {}) }, file, run, zeleOn)], code: 0 };
		}
		case "status": {
			const s = loadSettings();
			return { lines: [`${s.enabled ? "켜짐" : "꺼짐"} · 새 메일 자동 초안 ${s.auto ? "켜짐" : "꺼짐"} · 말투 프로필 ${listProfiles().join(", ") || "없음"}`], code: 0 };
		}
		default:
			return { lines: ["usage: onboard.ts on [--to <target>] | off | status | learn [--app <app|install>] [--room <id>] [--from-file <file>]"], code: 2 };
	}
}

if (import.meta.main) {
	const out = await runOnboard(process.argv.slice(2));
	for (const l of out.lines) console.log(l);
	process.exit(out.code);
}
