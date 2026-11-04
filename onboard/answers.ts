// The answers of the onboarding (terminal wizard, --answers file, web onboarding) and the checks that turn them into a complete set. Shared by setup.ts and
// the web onboarding (hub/setup-apply.ts), so both write exactly the same config.
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { detectLanguage, languageName } from "../hub/language.ts";
import { cleanName, friendlyName } from "../hub/machine-name.ts";
import { defaultHarness, harness, HARNESSES } from "./harness.ts";

export const SNOWFLAKE = /^\d{17,20}$/;

export type Identity = { name: string; character: string; tone: string; notices?: string; address?: string; avatar?: string; language?: string };
export type Answers = {
	identity: Identity;
	owner_id: string;
	guild: string;
	bot_token?: string;
	allow_logins: string[];
	machine_name: string;
	peer_token?: string;
	web_port: number;
	tailscale_https_port: number;
	orchestrator_model: string;
	lane_model: string;
	install_aside?: boolean;
	runtime: string;
	install_harness?: boolean;
};

export const CHARACTERS = [
	"차분하고 믿음직한 개인 비서. 먼저 결과를 말하고 필요한 것만 묻는다.",
	"장난기 있지만 일은 확실한 친구 같은 조수. 가볍게 말하되 사실은 정확하게.",
	"꼼꼼한 엔지니어. 근거와 검증을 먼저 챙기고 불확실하면 그렇다고 말한다.",
];
// The first entry of each list is the default (Enter). Examples are everyday errands, not the author's own projects.
export const TONES = [
	"편한 해요체로 이어지는 대화. 상대 말에 바로 이어서 자연스러운 문장으로 답하고, 정해진 시작말이나 '한 줄 결론 + 불릿' 틀을 매번 쓰지 않음. 목록은 보고와 선택지에만. 근거와 숫자는 구체적으로. 이모지 없음 (예: \"확인해 봤어요. 내일 회의가 10시에서 11시로 바뀌어서 일정도 같이 옮겨 뒀어요.\")",
	"반말, 친근하고 짧게 (예: \"응, 끝났어. 메일도 보냈어\")",
	"존댓말, 간결하게 (예: \"네, 끝났어요. 메일도 보냈어요\")",
	"존댓말, 정중하게 (예: \"완료했습니다. 메일도 발송했습니다\")",
];
// Style of notices (작업로그, 알림), from everyday speech to ASD-STE100; MODE.md defines each level.
export const NOTICES = [
	"일상: 평소 말투 그대로, 관련 내용을 짧게 (예: \"자료 정리 끝났어요. 빠진 파일 없고 남은 일 없어요.\")",
	"간결: 해요체 평서문, 한 문장에 사실 하나, 군말 없이 (예: \"자료 정리를 마쳤어요. 빠진 파일은 없어요. 남은 일은 없어요.\")",
	"STE 80%: ASD-STE100 규칙(짧은 문장, 능동태, 정해진 용어, 절차는 번호 단계)을 80% 강도로, 합니다체. 강도는 'STE 100%'처럼 바꿀 수 있음 (예: \"자료 정리를 완료했습니다. 빠진 파일이 없습니다. 남은 작업은 없습니다.\")",
];
export const stripExample = (o: string): string => o.replace(/\s*\(예:.*\)$/, "");

/** What an earlier run left in config.json: every answer is the default of the next run. */
export type Prior = { raw: Record<string, any>; identity: Identity; machineName: string; defaultMachineName: string; runtime: string | undefined; selector: (t: "orchestrator" | "lanes") => string };
export function priorOf(dir: string): Prior {
	const raw = existsSync(join(dir, "config.json")) ? JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) : {};
	return {
		raw,
		identity: { name: "", character: "", tone: "", ...raw.identity },
		machineName: cleanName(raw.web?.machine_name),
		defaultMachineName: friendlyName(hostname()),
		runtime: (raw.orchestrator?.runtime ?? raw.lanes?.runtime ?? raw.runtime) as string | undefined,
		// Model settings live in `models` (hub/config.ts).
		selector: t => `${raw.models?.[t]?.model ?? "anthropic/claude-opus-5-5"}:${raw.models?.[t]?.thinking ?? "medium"}`,
	};
}

export const expandHome = (p: string, home: string): string => p.replace(/^~(?=\/|$)/, home);

export type Checked = { ok: true; answers: Answers } | { ok: false; errors: string[] };

/** Fills what an answers file may leave out from the earlier run and the defaults, and lists what is wrong. */
export function validateAnswers(a: Partial<Answers>, prior: Prior, home: string): Checked {
	const errors: string[] = [];
	const identity: Identity = { ...prior.identity, ...a.identity };
	identity.character ||= CHARACTERS[0];
	identity.tone ||= stripExample(TONES[0]);
	identity.notices ||= stripExample(NOTICES[0]);
	// The gateway instructs its agents in this language (hub/i18n.ts); detected from the answers' script, else the system locale.
	identity.language ||= detectLanguage([identity.character, identity.tone, identity.notices, identity.address].filter(Boolean).join("\n"));
	if (!identity.name || identity.name.length < 2 || identity.name.length > 32) errors.push("identity.name: 2~32자");
	if (!identity.character) errors.push("identity.character: 성격 한 줄");
	if (!identity.tone) errors.push("identity.tone: 말투 한 줄");
	if (identity.avatar && !existsSync(expandHome(identity.avatar, home))) errors.push(`identity.avatar: 파일 없음 ${identity.avatar}`);
	const guild = String(a.guild ?? "");
	const owner = String(a.owner_id ?? "");
	if (guild && !SNOWFLAKE.test(guild)) errors.push("guild: 17~20자리 숫자");
	if (guild && !SNOWFLAKE.test(owner)) errors.push("owner_id: 17~20자리 숫자 (guild 가 있으면 필수)");
	const runtime = String(a.runtime ?? defaultHarness(prior.runtime));
	if (!harness(runtime)?.adapter) errors.push(`runtime: ${HARNESSES.filter(h => h.adapter).map(h => h.id).join(" | ")} 중 하나`);
	if (errors.length) return { ok: false, errors };
	return {
		ok: true,
		answers: {
			runtime,
			install_harness: a.install_harness === true,
			identity,
			owner_id: owner,
			guild,
			bot_token: a.bot_token,
			allow_logins: a.allow_logins ?? prior.raw.web?.allow_logins ?? [],
			machine_name: cleanName(a.machine_name) || prior.machineName || prior.defaultMachineName,
			...(typeof a.peer_token === "string" && a.peer_token.trim().length >= 16 ? { peer_token: a.peer_token.trim() } : {}),
			web_port: Number(a.web_port ?? prior.raw.web?.port ?? 7420),
			tailscale_https_port: Number(a.tailscale_https_port ?? prior.raw.web?.tailscale_https_port ?? 8443),
			orchestrator_model: a.orchestrator_model ?? prior.selector("orchestrator"),
			lane_model: a.lane_model ?? prior.selector("lanes"),
			install_aside: a.install_aside === true,
		},
	};
}

export function identityDoc(id: Identity): string {
	const code = id.language || "en";
	return `# Bot identity (written by dotz setup.ts; edit freely, re-running setup keeps this file unless the answers change)

- Name: **${id.name}**. Mode phrases: "${id.name}모드 켜" / "${id.name}모드 꺼" (also /dotz on|off).
- Character: ${id.character}
- Tone: ${id.tone}
- Notices (worklog, alert): ${id.notices}
- Language: ${code}
- Owner address: ${id.address ? `call the owner "${id.address}"; no other title` : "no title; never call the owner 사장님, 주인님 or any honorific, just talk to them"}
${id.avatar ? `- Avatar: ${id.avatar}\n` : ""}
## Voice rules
- Speak as ${id.name}, in the character and tone above, in the owner's language: ${languageName(code)} (${code}), unless they switch.
- Before writing, picture what the owner wants, the state they are in and what would actually help.
- Match the owner's length and register; short chat messages, not reports. Status is plain: what happened, the evidence,
  what the owner must decide.
- No emojis in messages, thread and channel names, except the four status emoji the gateway puts in place of a
  [done]/[run]/[ask]/[fail] marker (write the marker, not the emoji); the eyes reaction is the only read receipt.
  Times in local time (KST), never bare UTC.
`;
}
