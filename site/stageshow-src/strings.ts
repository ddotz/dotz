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
  // The README video (video.tsx): captions, one chat that hands a task off, one mail answered, the morning notice, the worklog.
  video: {
    tagline: string[]
    scenes: [Cap, Cap, Cap, Cap]
    hand: { ask: string[]; ackAt: string; ack: string[]; task: string; running: string; done: string; file: string; reportAt: string; report: string[] }
    mail: { chip: string; summary: string[]; summaryAt: string; draftFor: string; draftBody: string[]; dock: string[]; sentAt: string }
    brief: { title: string; note: string; at: string }
    worklog: { title: string; rows: [string, string, string][] }
  }
}

type Cap = { title: string[]; sub: string[] }

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
  video: {
    tagline: ['A personal assistant that stays on,', 'on your own computer.'],
    scenes: [
      { title: ['Hand it a task,', 'get the result back'], sub: ['Ask from your phone.', 'A session does the work and reports back.'] },
      { title: ['Nothing goes out', 'without your OK'], sub: ['Replies wait in the chat', 'until you press Send.'] },
      { title: ['It keeps watch', 'while you are away'], sub: ['Prices, logins and daily checks', 'reach you only as a quiet notice.'] },
      { title: ['Everything it did,', 'in one list'], sub: ['The worklog keeps each result', 'one tap away.'] },
    ],
    hand: {
      ask: ["Put this week's sales", 'into a report'],
      ackAt: '9:18 AM',
      ack: ['Handed to a session.', "I'll tell you when it's done."],
      task: 'Weekly sales report',
      running: 'Running',
      done: 'Done',
      file: 'weekly-sales.pdf',
      reportAt: '9:20 AM',
      report: ['Done.', 'Sales rose 12% over last week.', 'The report is attached.'],
    },
    mail: {
      chip: "New mail · Next week's shoot",
      summary: ['A client asks', 'whether Tuesday afternoon next week', 'works for the shoot.'],
      summaryAt: '9:41 AM',
      draftFor: 'Reply draft',
      draftBody: ['Tuesday at 2 PM works.', 'See you at the studio.'],
      dock: ['Send this reply?'],
      sentAt: '9:42 AM',
    },
    brief: { title: 'Morning briefing', note: '2 events today · 1 reply waiting', at: '7:30 AM' },
    worklog: {
      title: 'Worklog',
      rows: [
        ['Price check · Camping chair', '9:44 AM', ''],
        ['Replied to the shoot mail', '9:42 AM', ''],
        ['Weekly sales report', '9:20 AM', '1 result'],
        ['Morning briefing', '7:30 AM', ''],
      ],
    },
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
  video: {
    tagline: ['내 컴퓨터에서 항상 켜져 있는', '개인 비서예요.'],
    scenes: [
      { title: ['맡기면', '결과가 돌아와요'], sub: ['폰으로 부탁하면', '세션이 일하고 결과를 가져와요.'] },
      { title: ['내가 허락해야', '나가요'], sub: ['답장은 채팅에서', '보내기를 누를 때까지 기다려요.'] },
      { title: ['자리를 비워도', '지켜봐요'], sub: ['가격, 로그인, 정해 둔 점검은', '바뀔 때만 조용히 알려 줘요.'] },
      { title: ['한 일은', '작업내역에 남아요'], sub: ['결과 파일도', '거기서 바로 열어요.'] },
    ],
    hand: {
      ask: ['이번 주 매출을', '보고서로 정리해 줘'],
      ackAt: '오전 9:18',
      ack: ['세션에 맡겼어요.', '끝나면 알려 드릴게요.'],
      task: '주간 매출 보고서',
      running: '진행 중',
      done: '완료',
      file: '주간-매출.pdf',
      reportAt: '오전 9:20',
      report: ['끝났어요.', '지난주보다 매출이 12% 늘었어요.', '보고서를 붙여 뒀어요.'],
    },
    mail: {
      chip: '새 메일 · 다음 주 촬영 일정',
      summary: ['고객이', '다음 주 화요일 오후에', '촬영이 되는지 물어봤어요.'],
      summaryAt: '오전 9:41',
      draftFor: '답장 초안',
      draftBody: ['화요일 오후 2시 좋아요.', '스튜디오에서 뵐게요.'],
      dock: ['이 답장을 보낼까요?'],
      sentAt: '오전 9:42',
    },
    brief: { title: '아침 점검', note: '오늘 일정 2개 · 답장 1건 대기', at: '오전 7:30' },
    worklog: {
      title: '작업내역',
      rows: [
        ['캠핑 의자 가격 확인', '오전 9:44', ''],
        ['촬영 메일에 답장을 보냈어요', '오전 9:42', ''],
        ['주간 매출 보고서', '오전 9:20', '결과 1'],
        ['아침 점검', '오전 7:30', ''],
      ],
    },
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
  video: {
    tagline: ['自分のパソコンで動き続ける、', 'パーソナルアシスタント。'],
    scenes: [
      { title: ['任せれば、', '結果が返ってきます'], sub: ['スマホから頼むと、', 'セッションが作業して報告します。'] },
      { title: ['あなたがOKするまで、', '何も送りません'], sub: ['返信の下書きは', 'チャットで確認を待ちます。'] },
      { title: ['席を外している間も', '見ていてくれます'], sub: ['価格やログイン、定期チェックは', '変化があったときだけ静かに通知。'] },
      { title: ['やったことは', '作業履歴に残ります'], sub: ['結果のファイルも', 'そこからすぐ開けます。'] },
    ],
    hand: {
      ask: ['今週の売上を', 'レポートにまとめて'],
      ackAt: '午前9:18',
      ack: ['セッションに任せました。', '終わったらお知らせします。'],
      task: '週間売上レポート',
      running: '実行中',
      done: '完了',
      file: '週間売上.pdf',
      reportAt: '午前9:20',
      report: ['終わりました。', '先週より売上が12%増えています。', 'レポートを添付しました。'],
    },
    mail: {
      chip: '新着メール · 来週の撮影日程',
      summary: ['お客様が、', '来週火曜の午後に', '撮影できるか聞いています。'],
      summaryAt: '午前9:41',
      draftFor: '返信の下書き',
      draftBody: ['火曜の午後2時で大丈夫です。', 'スタジオでお会いしましょう。'],
      dock: ['この返信を送りますか？'],
      sentAt: '午前9:42',
    },
    brief: { title: '朝のブリーフィング', note: '今日の予定2件 · 返信待ち1件', at: '午前7:30' },
    worklog: {
      title: '作業履歴',
      rows: [
        ['キャンプチェアの価格確認', '午前9:44', ''],
        ['撮影メールに返信しました', '午前9:42', ''],
        ['週間売上レポート', '午前9:20', '結果 1'],
        ['朝のブリーフィング', '午前7:30', ''],
      ],
    },
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
  video: {
    tagline: ['在你自己的电脑上', '一直开着的个人助理。'],
    scenes: [
      { title: ['交给它，', '结果自己回来'], sub: ['用手机吩咐一声，', '会话去干活，完成后向你汇报。'] },
      { title: ['没有你点头，', '什么都不会发出去'], sub: ['回复草稿会留在聊天里，', '等你点发送。'] },
      { title: ['你不在时，', '它替你盯着'], sub: ['价格、登录和定时检查，', '有变化才悄悄通知你。'] },
      { title: ['做过的事，', '都留在工作记录里'], sub: ['结果文件', '也能直接从这里打开。'] },
    ],
    hand: {
      ask: ['把本周的销售数据', '整理成报告'],
      ackAt: '上午9:18',
      ack: ['已交给会话处理。', '完成后我会告诉你。'],
      task: '每周销售报告',
      running: '进行中',
      done: '已完成',
      file: '每周销售.pdf',
      reportAt: '上午9:20',
      report: ['完成了。', '销售额比上周增长了 12%。', '报告已附上。'],
    },
    mail: {
      chip: '新邮件 · 下周拍摄安排',
      summary: ['客户问', '下周二下午', '能不能拍摄。'],
      summaryAt: '上午9:41',
      draftFor: '回复草稿',
      draftBody: ['周二下午两点可以。', '我们在工作室见。'],
      dock: ['要发送这封回复吗？'],
      sentAt: '上午9:42',
    },
    brief: { title: '早间简报', note: '今天 2 个日程 · 1 封待回复', at: '上午7:30' },
    worklog: {
      title: '工作记录',
      rows: [
        ['露营椅价格检查', '上午9:44', ''],
        ['已回复拍摄邮件', '上午9:42', ''],
        ['每周销售报告', '上午9:20', '结果 1'],
        ['早间简报', '上午7:30', ''],
      ],
    },
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
  video: {
    tagline: ['Un asistente personal siempre activo', 'en tu propio ordenador.'],
    scenes: [
      { title: ['Se lo encargas', 'y vuelve con el resultado'], sub: ['Pídeselo desde el móvil.', 'Una sesión trabaja y te lo entrega.'] },
      { title: ['Nada sale', 'sin tu visto bueno'], sub: ['Las respuestas esperan en el chat', 'hasta que pulses Enviar.'] },
      { title: ['Vigila por ti', 'cuando no estás'], sub: ['Precios, accesos y revisiones diarias', 'te llegan como un aviso discreto.'] },
      { title: ['Todo lo que hizo,', 'en una sola lista'], sub: ['El historial guarda cada resultado', 'a un toque.'] },
    ],
    hand: {
      ask: ['Prepara un informe', 'con las ventas de la semana'],
      ackAt: '9:18',
      ack: ['Se lo he pasado a una sesión.', 'Te aviso cuando termine.'],
      task: 'Informe semanal de ventas',
      running: 'En curso',
      done: 'Listo',
      file: 'ventas-semana.pdf',
      reportAt: '9:20',
      report: ['Listo.', 'Las ventas subieron un 12 % respecto a la semana pasada.', 'Te adjunto el informe.'],
    },
    mail: {
      chip: 'Correo nuevo · Rodaje',
      summary: ['Un cliente pregunta si', 'el martes que viene por la tarde', 'va bien para el rodaje.'],
      summaryAt: '9:41',
      draftFor: 'Borrador de respuesta',
      draftBody: ['El martes a las 14:00 me va bien.', 'Nos vemos en el estudio.'],
      dock: ['¿Enviar esta respuesta?'],
      sentAt: '9:42',
    },
    brief: { title: 'Resumen de la mañana', note: '2 eventos hoy · 1 respuesta pendiente', at: '7:30' },
    worklog: {
      title: 'Historial',
      rows: [
        ['Precio de la silla de camping', '9:44', ''],
        ['Respuesta enviada sobre el rodaje', '9:42', ''],
        ['Informe semanal de ventas', '9:20', '1 resultado'],
        ['Resumen de la mañana', '7:30', ''],
      ],
    },
  },
}

const TABLE: Record<string, Strings> = { en, ko, ja, 'zh-cn': zhCN, es }

export function strings(lang = document.documentElement.lang): Strings {
  return TABLE[lang.toLowerCase()] ?? en
}
