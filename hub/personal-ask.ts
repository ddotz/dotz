// Light guard for the "personal data goes through the form, never chat" rule (MODE.md): true when an outgoing bot message
// reads like a request to type card, ID, phone, address or password details into the chat. A message that already points at the
// form is left alone. Tuned for few false positives: both a data word and a request phrase must be there.
const DATA = /카드\s*번호|카드\s*정보|유효\s*기간|\bcvc\b|\bcvv\b|보안\s*코드|주민\s*(등록\s*)?번호|여권\s*번호|계좌\s*번호|(전화|휴대폰|핸드폰)\s*번호|집\s*주소|배송\s*(지|주소)|상세\s*주소|우편\s*번호|비밀번호|패스워드|card number|credit card|expiry date|security code|passport number|social security|\bssn\b|account number|phone number|home address|shipping address|street address|password/i;
const ASK = /(알려|보내|적어|입력해|말씀해|공유해|붙여\s*넣어)\s*(주세요|줘요|줄래|주실래|주시겠|달라|주시면)|주세요[.?!]?\s*$|\b(please\s+)?(send|share|give|tell|type|paste|provide|reply with)\b[^.\n]{0,40}\b(me|here|us)\b|\bwhat('s| is) your\b/i;
const FORM = /폼|양식|입력\s*창|입력창|dotz_auth|\bform\b|secure/i;

export const asksPersonalInChat = (text: string): boolean => !FORM.test(text) && DATA.test(text) && ASK.test(text);
