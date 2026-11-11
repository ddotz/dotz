// Every visible string of the demo scenes, one table per page language. The scenes read document.documentElement.lang
// (set by the page template) and fall back to English. Phrase arrays are the unbreakable chunks P (shared.tsx) lays out.

export type Strings = {
  // Phrases join with this (a space, or nothing where the language writes without spaces).
  sep: string
  actions: { send: string; edit: string; skip: string; sent: string }
  tags: { review: string; sent: string }
  hero: {
    ask: string[]
    ack: string[]
    ackAt: string
    mail: string
    summary: string[]
    summaryAt: string
    draftFor: string
    draftBody: string[]
    dock: string[]
    sentAt: string
    composer: string
  }
  phone: { time: string; ask: string; busy: string; reply: string; events: [string, string][] }
  watch: {
    item: string
    watching: string
    before: string
    after: string
    notices: string
    changed: string
    now: string
    keep: string
    keepNote: string
    keepAt: string
  }
}

const en: Strings = {
  sep: ' ',
  actions: { send: 'Send', edit: 'Edit', skip: "Don't send", sent: 'Sent' },
  tags: { review: 'Needs review', sent: 'Sent' },
  hero: {
    ask: ['When a new mail arrives,', 'summarize it and draft a reply'],
    ack: ['Got it.', "I'll always ask before sending."],
    ackAt: '9:12 AM',
    mail: "New mail · Emily Carter · Next week's shoot",
    summary: ['Emily Carter asked', 'whether Tuesday afternoon', 'next week works for the shoot.'],
    summaryAt: '9:41 AM',
    draftFor: 'Reply draft · Emily Carter',
    draftBody: ['Tuesday at 2 PM works.', 'See you at the studio.'],
    dock: ['Send this reply', 'to Emily Carter?'],
    sentAt: '9:42 AM',
    composer: 'Send a message',
  },
  phone: {
    time: '8:30',
    ask: "What's on my schedule today?",
    busy: 'Checking',
    reply: 'You have two events today.',
    events: [['10:00 AM', 'Weekly team meeting'], ['1:30 PM', 'Dentist appointment']],
  },
  watch: {
    item: 'Camping chair',
    watching: 'Watching',
    before: '$89',
    after: '$72',
    notices: 'Notifications',
    changed: 'Price changed',
    now: 'Just now',
    keep: 'Stay signed in',
    keepNote: '3 sites · No changes',
    keepAt: '8:00 AM',
  },
}

const ko: Strings = {
  sep: ' ',
  actions: { send: '보내기', edit: '고치기', skip: '보내지 않기', sent: '보냈어요' },
  tags: { review: '확인 필요', sent: '보냈어요' },
  hero: {
    ask: ['새 메일이 오면', '요약하고 답장 초안 써 줘'],
    ack: ['알겠어요.', '보내기 전에 꼭 물어볼게요.'],
    ackAt: '오전 9:12',
    mail: '새 메일 · 한지우 · 다음 주 촬영 일정',
    summary: ['한지우 님이', '다음 주 화요일 오후에', '촬영이 되는지 물어봤어요.'],
    summaryAt: '오전 9:41',
    draftFor: '답장 초안 · 한지우',
    draftBody: ['화요일 오후 2시 좋아요.', '성수 스튜디오에서 뵐게요.'],
    dock: ['한지우 님께', '이 답장을 보낼까요?'],
    sentAt: '오전 9:42',
    composer: '메시지 보내기',
  },
  phone: {
    time: '8:30',
    ask: '오늘 일정 알려 줘',
    busy: '확인하는 중',
    reply: '오늘 일정은 두 개예요.',
    events: [['10:00', '팀 주간 회의'], ['13:30', '치과 예약']],
  },
  watch: {
    item: '캠핑 의자',
    watching: '지켜보는 중',
    before: '89,000원',
    after: '72,000원',
    notices: '알림',
    changed: '가격이 바뀌었어요',
    now: '방금',
    keep: '로그인 유지',
    keepNote: '사이트 세 곳 · 바뀐 것 없음',
    keepAt: '오전 8:00',
  },
}

const ja: Strings = {
  sep: '',
  actions: { send: '送信', edit: '編集', skip: '送信しない', sent: '送信しました' },
  tags: { review: '確認待ち', sent: '送信済み' },
  hero: {
    ask: ['新しいメールが届いたら、', '要約して返信の下書きを書いて'],
    ack: ['わかりました。', '送る前に必ず確認しますね。'],
    ackAt: '午前9:12',
    mail: '新着メール · 佐藤 美咲 · 来週の撮影日程',
    summary: ['佐藤 美咲さんが、', '来週火曜の午後に', '撮影できるか聞いています。'],
    summaryAt: '午前9:41',
    draftFor: '返信の下書き · 佐藤 美咲',
    draftBody: ['火曜の午後2時で大丈夫です。', 'スタジオでお会いしましょう。'],
    dock: ['この返信を', '佐藤 美咲さんに送りますか？'],
    sentAt: '午前9:42',
    composer: 'メッセージを送信',
  },
  phone: {
    time: '8:30',
    ask: '今日の予定を教えて',
    busy: '確認中',
    reply: '今日の予定は2件です。',
    events: [['10:00', 'チーム定例会議'], ['13:30', '歯医者の予約']],
  },
  watch: {
    item: 'キャンプチェア',
    watching: 'ウォッチ中',
    before: '8,900円',
    after: '7,200円',
    notices: '通知',
    changed: '価格が変わりました',
    now: 'たった今',
    keep: 'ログイン維持',
    keepNote: 'サイト3件 · 変更なし',
    keepAt: '午前8:00',
  },
}

const zhCN: Strings = {
  sep: '',
  actions: { send: '发送', edit: '修改', skip: '不发送', sent: '已发送' },
  tags: { review: '待确认', sent: '已发送' },
  hero: {
    ask: ['来新邮件时，', '帮我总结并起草回复'],
    ack: ['好的。', '发送之前我一定会先问你。'],
    ackAt: '上午9:12',
    mail: '新邮件 · 林悦 · 下周拍摄安排',
    summary: ['林悦问', '下周二下午', '能不能拍摄。'],
    summaryAt: '上午9:41',
    draftFor: '回复草稿 · 林悦',
    draftBody: ['周二下午两点可以。', '我们在工作室见。'],
    dock: ['要把这封回复', '发给林悦吗？'],
    sentAt: '上午9:42',
    composer: '发送消息',
  },
  phone: {
    time: '8:30',
    ask: '告诉我今天的日程',
    busy: '正在查看',
    reply: '今天有两个日程。',
    events: [['10:00', '团队周会'], ['13:30', '牙医预约']],
  },
  watch: {
    item: '露营椅',
    watching: '关注中',
    before: '¥599',
    after: '¥469',
    notices: '通知',
    changed: '价格变了',
    now: '刚刚',
    keep: '保持登录',
    keepNote: '3 个网站 · 没有变化',
    keepAt: '上午8:00',
  },
}

const es: Strings = {
  sep: ' ',
  actions: { send: 'Enviar', edit: 'Editar', skip: 'No enviar', sent: 'Enviado' },
  tags: { review: 'Por revisar', sent: 'Enviado' },
  hero: {
    ask: ['Cuando llegue un correo nuevo,', 'resúmelo y escribe un borrador de respuesta'],
    ack: ['Entendido.', 'Siempre te preguntaré antes de enviar.'],
    ackAt: '9:12',
    mail: 'Correo nuevo · Lucía Fernández · Rodaje de la próxima semana',
    summary: ['Lucía Fernández pregunta', 'si el martes por la tarde', 'de la próxima semana va bien para el rodaje.'],
    summaryAt: '9:41',
    draftFor: 'Borrador de respuesta · Lucía Fernández',
    draftBody: ['El martes a las 14:00 me va bien.', 'Nos vemos en el estudio.'],
    dock: ['¿Enviar esta respuesta', 'a Lucía Fernández?'],
    sentAt: '9:42',
    composer: 'Enviar un mensaje',
  },
  phone: {
    time: '8:30',
    ask: '¿Qué tengo hoy?',
    busy: 'Comprobando',
    reply: 'Hoy tienes dos eventos.',
    events: [['10:00', 'Reunión semanal del equipo'], ['13:30', 'Cita con el dentista']],
  },
  watch: {
    item: 'Silla de camping',
    watching: 'Vigilando',
    before: '89 €',
    after: '72 €',
    notices: 'Notificaciones',
    changed: 'El precio ha cambiado',
    now: 'Ahora',
    keep: 'Mantener sesión',
    keepNote: '3 sitios · Sin cambios',
    keepAt: '8:00',
  },
}

const TABLE: Record<string, Strings> = { en, ko, ja, 'zh-cn': zhCN, es }

export function strings(lang = document.documentElement.lang): Strings {
  return TABLE[lang.toLowerCase()] ?? en
}
