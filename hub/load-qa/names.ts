// Generated fake identities and text pieces for hub/load-qa/seed.ts. Nothing here names a real person, address, company or work:
// names are syllable mixes, addresses live on reserved example domains, texts are generic.

export const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오"];
export const GIVEN: [ko: string, roman: string][] = [["서윤", "seoyun"], ["민재", "minjae"], ["하린", "harin"], ["도현", "dohyun"], ["지안", "jian"], ["예준", "yejun"], ["소율", "soyul"], ["태오", "taeo"], ["나윤", "nayun"], ["시우", "siwoo"], ["유나", "yuna"], ["건호", "gunho"], ["다온", "daon"], ["재이", "jaei"], ["보람", "boram"], ["승현", "seunghyun"]];
export const DOMAINS = ["example.test", "example.org", "mail.example.test", "shop.example.test", "school.example.test"];

export type Role = "student" | "parent" | "teacher" | "person" | "friend" | "vendor" | "customer";

type RoleText = { subjects: string[]; lines: string[]; asks: boolean };
export const ROLE_TEXT: Record<Role, RoleText> = {
	student: {
		subjects: ["수업 시간 변경 문의", "연습 영상 확인 부탁드려요", "다음 주 수업 일정", "숙제 제출 관련 질문"],
		lines: ["이번 주 연습을 마쳐서 영상을 보내 드려요.", "다음 수업 시간을 한 시간 미룰 수 있을까요?", "숙제 범위가 헷갈려서 한 번 더 여쭤봐요.", "시험 전에 한 번 더 봐 주실 수 있는지 궁금해요."],
		asks: true,
	},
	parent: {
		subjects: ["상담 일정 문의", "수강료 안내 요청", "결석 사유 전달", "발표회 참석 안내 요청"],
		lines: ["아이가 감기로 이번 수업에 빠지게 되었어요.", "수강료 입금 계좌를 다시 알려 주실 수 있을까요?", "발표회 날짜와 장소가 정해지면 알려 주세요.", "상담은 평일 저녁이 편합니다."],
		asks: true,
	},
	teacher: {
		subjects: ["학부모 상담 안내", "현장학습 동의서 제출", "준비물 안내", "알림장 확인 부탁드립니다"],
		lines: ["다음 주 화요일까지 동의서를 제출해 주세요.", "상담 가능한 시간을 두 가지만 골라 주시면 조율하겠습니다.", "준비물 목록은 첨부한 안내문을 참고해 주세요.", "알림장 확인란에 서명 부탁드립니다."],
		asks: true,
	},
	person: {
		subjects: ["모임 장소 확인", "지난번 부탁드린 건", "안부 인사 드립니다", "자료 공유 요청"],
		lines: ["다음 모임 장소가 바뀌었는지 확인하고 싶어요.", "지난번에 말씀드린 건은 어떻게 되었을까요?", "오랜만에 연락드려요. 잘 지내시죠?", "공유해 주신 자료가 열리지 않아요."],
		asks: true,
	},
	friend: {
		subjects: ["주말 약속", "사진 공유", "다음 달 일정", "생일 모임 장소"],
		lines: ["이번 주말에 시간 괜찮아?", "지난번에 찍은 사진 정리해서 보낼게.", "다음 달 일정 정해지면 알려 줘.", "생일 모임은 역 근처가 어때?"],
		asks: true,
	},
	vendor: {
		subjects: ["견적서 송부", "배송 일정 안내", "재고 입고 안내", "세금계산서 발행 문의", "[광고] 이달의 프로모션"],
		lines: ["요청하신 견적서를 첨부해 드립니다.", "주문하신 물품은 목요일에 출고될 예정입니다.", "품절이던 상품이 입고되어 안내드립니다.", "세금계산서 발행을 위해 사업자 정보를 회신해 주세요."],
		asks: false,
	},
	customer: {
		subjects: ["주문 확인 문의", "교환 요청", "영수증 요청", "배송 지연 문의"],
		lines: ["주문번호를 확인해 주실 수 있을까요?", "사이즈가 맞지 않아 교환하고 싶어요.", "결제 영수증을 메일로 받고 싶어요.", "아직 배송이 시작되지 않은 것 같아요."],
		asks: true,
	},
};

export const GREETING = ["안녕하세요.", "안녕하세요, 잘 지내셨나요?", "수고 많으십니다.", "늘 감사드립니다."];
export const CLOSING = ["감사합니다.", "확인 부탁드립니다.", "편하실 때 답 주세요.", "좋은 하루 보내세요."];

export type Tone = { identity: string[]; templates: string[]; rules: string[]; samples: string[]; forbidden: string[] };
export type Account = {
	/** App instance id in custom/apps.json (the default instance is `mail`). */
	inst: string;
	/** `source` of the mails (POST /api/mail): the instance owns `mail:<source>-…`. */
	source: string;
	label: string;
	owner: string;
	address: string;
	weight: number;
	/** Who writes to this account, with weights. */
	roles: [Role, number][];
	tone: Tone;
};

export const ACCOUNTS: Account[] = [
	{
		inst: "mail", source: "alpha", label: "레슨 메일", owner: "하늘 선생", address: "haneul.lesson@example.test", weight: 0.5,
		roles: [["student", 4], ["parent", 3], ["person", 2], ["vendor", 1]],
		tone: {
			identity: ["동네 교습소에서 아이들을 가르치는 선생님", "학생과 학부모에게 따뜻하지만 단정하게 답해요"],
			templates: ["안녕하세요, 하늘 선생입니다.", "확인하고 안내드리겠습니다."],
			rules: ["존댓말(합니다체)로 쓰고 첫 줄에 인사를 둔다", "날짜와 시간은 요일까지 같이 적는다", "세 문장 안으로 끝낸다"],
			samples: ["안녕하세요, 하늘 선생입니다. 말씀하신 시간으로 옮겨 두었습니다. 목요일 5시에 뵙겠습니다.", "안녕하세요. 수강료 안내는 첨부한 파일에 정리해 두었습니다. 확인 부탁드립니다."],
			forbidden: ["이모티콘", "반말"],
		},
	},
	{
		inst: "mail-beta", source: "beta", label: "가게 메일", owner: "보리 상점", address: "bori.shop@example.test", weight: 0.3,
		roles: [["vendor", 4], ["customer", 4], ["person", 1]],
		tone: {
			identity: ["작은 온라인 상점을 혼자 운영하는 사장", "간결하고 사무적으로 답해요"],
			templates: ["안녕하세요, 보리 상점입니다."],
			rules: ["결론을 첫 문장에 쓴다", "주문번호가 있으면 그대로 다시 적는다", "사과는 한 번만 한다"],
			samples: ["안녕하세요, 보리 상점입니다. 교환은 가능합니다. 상품을 보내 주시면 확인 후 바로 발송하겠습니다.", "확인했습니다. 입고 일정은 금요일입니다."],
			forbidden: ["길게 변명하기"],
		},
	},
	{
		inst: "mail-gamma", source: "gamma", label: "개인 메일", owner: "나래", address: "narae.home@example.org", weight: 0.2,
		roles: [["friend", 3], ["teacher", 3], ["person", 2], ["vendor", 1]],
		tone: {
			identity: ["두 아이를 키우는 직장인", "친구에게는 편하게, 학교에는 정중하게 답해요"],
			templates: ["안녕하세요, 나래예요."],
			rules: ["해요체로 쓴다", "학교와 업체에는 한 줄 더 정중하게 쓴다", "가능한 날짜를 두 개 제안한다"],
			samples: ["안녕하세요, 나래예요. 동의서는 내일 아이 편에 보낼게요. 감사합니다.", "응, 토요일 좋아. 점심쯤 볼까?"],
			forbidden: ["영어 섞어 쓰기"],
		},
	},
];

/** Attachment name pieces: Korean, parentheses and the same name in several folders on purpose. */
export const FILE_STEMS = ["수강안내", "연습표", "견적서", "발표회 안내", "교재 목록", "영수증", "시간표", "동의서 양식"];
export const FILE_SUFFIX = ["(최종)", "(1)", "(수정본)", "_v2", " 2026", ""];
export const FILE_FOLDERS = ["문서", "문서 (복사본)", "2026", "보관"];

export const COMMENT_TEXT = ["이 자료 받을 수 있을까요? {addr}", "자료 부탁드려요! {addr}", "좋은 영상 감사합니다. 설명 잘 봤어요.", "다음 영상도 기대할게요", "궁금한 점이 있어서 메일 드렸어요. {addr}"];
export const POST_TITLES = ["연습 방법 정리", "이번 달 소식", "수업 풍경", "자주 묻는 질문", "새 자료 안내"];
export const KAKAO_ROOMS = ["학부모 모임방", "동네 모임", "가족방", "수업 공지방"];
export const KAKAO_LINES = ["내일 시간 괜찮으세요?", "공지 확인했어요", "사진 올려 주세요", "모임 장소 정해졌나요?"];
export const ALERTS = ["[done] 메일 정리를 마쳤어요", "[done] 오늘 일정을 확인했어요", "[fail] 로그인 확인이 필요해요", "[done] 주간 정리를 올렸어요"];
