import { ruleOfFinding } from "../../../hub/ban.ts";
import { NO_RECIPIENT, RECIPIENT_FAILURE, SENT_CLAIM_FAILURE } from "../../../hub/reply-draft.ts";
import { reasonOf } from "../../../hub/reply-reasons.ts";

export function ownerWarning(w: string): string {
	if (w === NO_RECIPIENT) return "받는 사람의 메일 주소를 찾지 못했어요. 보내기 전에 주소를 알려 주세요";
	const m = (re: RegExp) => re.exec(w);
	let x: RegExpExecArray | null;
	if ((x = m(/^'(.+)' is the user's own address$/))) return `${x[1]}은(는) 내 주소예요`;
	if ((x = m(/^'(.+)' is not the sender, reply-to or a cc of the original$/))) return `${x[1]}은(는) 원래 메일의 보낸 사람·회신 주소·참조가 아니에요`;
	if (w === "the subject must start with 'Re:'") return "제목이 Re:로 시작하지 않아요";
	if (w === "the body is empty") return "본문이 비어 있어요";
	if ((x = m(/^the body is (\d+) characters; the limit is (\d+)$/))) return `본문이 ${x[1]}자예요 (최대 ${x[2]}자)`;
	if (w === RECIPIENT_FAILURE) return "보낸 사람이 누구인지 판단한 근거가 메일에 없어요. 호칭과 내용이 이 사람에게 맞는지 봐 주세요";
	if (w === SENT_CLAIM_FAILURE) return "이미 보냈다고 썼는데 보낸 근거가 없어요";
	if (w === "the text contains a placeholder") return "채워 넣지 않은 자리표시가 있어요";
	if ((x = m(/^it uses the forbidden expression '(.+)'$/))) return `쓰지 않기로 한 표현 '${x[1]}'이(가) 있어요`;
	const rule = ruleOfFinding(w);
	return rule === undefined ? w : reasonOf("wording_rule", { label: rule }).text;
}

export function lintCode(raw: string): { code: string; vars?: Record<string, string | number> } {
	let x: RegExpExecArray | null;
	if (raw === NO_RECIPIENT) return { code: "recipient_missing" };
	if ((x = /^'(.+)' is the user's own address$/.exec(raw))) return { code: "recipient_self", vars: { address: x[1]! } };
	if ((x = /^'(.+)' is not the sender, reply-to or a cc of the original$/.exec(raw))) return { code: "recipient_not_on_mail", vars: { address: x[1]! } };
	if ((x = /^the body is (\d+) characters; the limit is (\d+)$/.exec(raw))) return { code: "too_long", vars: { n: Number(x[1]), max: Number(x[2]) } };
	if ((x = /^it uses the forbidden expression '(.+)'$/.exec(raw))) return { code: "forbidden_word", vars: { word: x[1]! } };
	const rule = ruleOfFinding(raw);
	if (rule !== undefined) return { code: "wording_rule", vars: { label: rule } };
	if (raw === "the subject must start with 'Re:'") return { code: "subject_re" };
	if (raw === "the body is empty") return { code: "empty" };
	return { code: "placeholder" };
}
