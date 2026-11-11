// Korean names for the measured things, shared by the brief and the check so both say the same words.
export const ENDING_LABEL: Record<string, string> = {
	hapsyo: "합쇼체(~습니다)",
	haeyo: "해요체",
	haera: "해라체(~다)",
	banmal: "반말",
	eumseum: "음슴체",
	noun: "명사로 끝남",
};
export const OPENING_LABEL: Record<string, string> = { question: "물음으로 시작", number: "숫자로 시작", short: "짧은 한 문장으로 시작", scene: "장면·평서로 시작" };
export const CLOSING_LABEL: Record<string, string> = { question: "물음으로 끝", short: "짧은 한 문장으로 끝", plain: "평서로 끝", suggest: "권유로 끝" };
export const PUNCT_LABEL: Record<string, string> = {
	comma: "쉼표",
	question: "물음표",
	exclaim: "느낌표",
	ellipsis: "말줄임",
	quote: "따옴표",
	paren: "괄호",
	dash: "줄표",
	tilde: "물결",
	choseong: "초성체(ㅋㅋ)",
	emoji: "이모지",
	emphasis: "굵게·제목 표시",
};
export const STATUS_LABEL = { ok: "충분", direction: "방향만", empty: "근거 없음" } as const;
