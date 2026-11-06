// Light guard for the "personal data goes through the form, never chat" rule (MODE.md): true when an outgoing bot message
// reads like a request to type card, ID, phone, address or password details into the chat. A message that already points at the
// form is left alone. Tuned for few false positives: both a data word and a request phrase must be there.
const DATA = /카드\s*번호|카드\s*정보|유효\s*기간|\bcvc\b|\bcvv\b|보안\s*코드|주민\s*(등록\s*)?번호|여권\s*번호|계좌\s*번호|(전화|휴대폰|핸드폰)\s*번호|집\s*주소|배송\s*(지|주소)|상세\s*주소|우편\s*번호|비밀번호|패스워드|card number|credit card|expiry date|security code|passport number|social security|\bssn\b|account number|phone number|home address|shipping address|street address|password/i;
const DATA_ALL = new RegExp(DATA.source, "gi");
const ASK = /(알려|보내|적어|입력해|말씀해|공유해|붙여\s*넣어)\s*(주세요|줘요|줄래|주실래|주시겠|달라|주시면)|주세요[.?!]?\s*$|\b(please\s+)?(send|share|give|tell|type|paste|provide|reply with)\b[^.\n]{0,40}\b(me|here|us)\b|\bwhat('s| is) your\b/i;
const FORM = /폼|양식|입력\s*창|입력창|dotz_auth|\bform\b|secure/i;
// A clause saying the value is not handled: "비밀번호는 저장하지 않았어요", "넘기지 않고", "채팅에 적지 마세요", "화면에 안 보이고".
// Conditionals ("보내지 않으면") are left out, since they usually come before the request itself.
const NOT_HANDLED = /(저장|보관|기록|전달|공유|요청|입력)(하|되)지\s*(않(?!으면|으시면|는다면)|마|말)|(남기|넘기|보내|받|묻|쓰|적|넣|치|읽)지\s*(않(?!으면|으시면|는다면)|마|말)|안\s*(보이|남|받|물|넘기|보내|저장)|모르게|모르도록|\b(not|never|n't)\s+(be\s+)?(stor|sav|sen[dt]|shar|kept|keep|log|record|typ|past|seen)\w*|\bstays?\s+(on|in)\b/i;

// The old rule (no form pointer, a data word and a request phrase anywhere), except that data words inside a clause that says the value
// is not handled do not count. A clause that also carries a request phrase keeps its data words ("저장하지 않을 테니 알려 주세요").
export const asksPersonalInChat = (text: string): boolean => {
	if (FORM.test(text) || !ASK.test(text)) return false;
	const kept = text.replace(/[^.!?,;\n]+[.!?,;\n]*/g, c => (NOT_HANDLED.test(c) && !ASK.test(c) ? c.replace(DATA_ALL, "") : c));
	return DATA.test(kept);
};
