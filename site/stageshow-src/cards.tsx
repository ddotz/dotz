import type { ReactNode } from 'react'
import { Stage } from './kit/stage'
import { Bar } from './kit/window'
import { Collapse } from './kit/motion/Collapse'
import { Icon } from './kit/parts/Icon'
import { Check } from './kit/parts/Check'
import { Spinner } from './kit/parts/Spinner'
import { Avatar } from './kit/parts/Avatar'
import type { Act } from './kit/act'
import { AppMark, DraftActions, P, useDark, type Send } from './shared'
import './cards.css'

// Four feature cards, each one beat that plays once when the card comes into
// view and then holds its payoff: the morning briefing arrives, a comment's
// reply draft is sent, a watch alert lands, a background task finishes with
// its result file. Only the comment card has a cursor; the others are the
// system acting on its own.

function CardStage<S extends object>({ name, initial, poster, script, cursor, children }: {
  name: string
  initial: S
  poster: S
  script: (a: Act<S>) => Promise<void>
  cursor?: boolean
  children: (s: S) => ReactNode
}) {
  const dark = useDark()
  return (
    <Stage
      className={`dz cz cz--${name}`}
      width={520}
      height={280}
      compact={{ below: 440, width: 350, height: 270 }}
      theme={dark ? 'dark' : 'light'}
      initial={initial}
      poster={poster}
      script={script}
      play="once"
      fill
      cursor={cursor ? { at: { wide: { x: 470, y: 250 }, compact: { x: 320, y: 250 } }, idle: false } : undefined}
    >
      {(s) => <div className="cz-panel">{children(s)}</div>}
    </Stage>
  )
}

const ChatHead = ({ at, tag }: { at: string; tag?: string }) => (
  <div className="cz-head">
    <AppMark size={22} />
    <span className="cz-meta"><b>dotz</b> · {at}</span>
    {tag && <span className="cz-tag">{tag}</span>}
  </div>
)

type Brief = { msg: boolean; rows: number; mail: boolean }
const BRIEF: [string, string[]][] = [
  ['10:00', ['팀 주간 회의']],
  ['13:30', ['치과 예약']],
  ['19:00', ['저녁 약속', '· 연남동']],
]

export function BriefingScene() {
  return (
    <CardStage<Brief>
      name="brief"
      initial={{ msg: false, rows: 0, mail: false }}
      poster={{ msg: true, rows: 3, mail: true }}
      script={async (a) => {
        await a.wait(500)
        a.put({ msg: true })
        await a.wait(700)
        for (let i = 1; i <= 3; i++) {
          a.put({ rows: i })
          await a.wait(260)
        }
        await a.wait(400)
        a.put({ mail: true })
      }}
    >
      {(s) => (
        <>
          <ChatHead at="오전 9:00" tag="아침 점검" />
          <Collapse open={s.msg} reveal="drop" from="below">
            <P className="cz-text">{['좋은 아침이에요.', '오늘 일정은 세 개예요.']}</P>
          </Collapse>
          <div className="cz-list">
            {BRIEF.map(([t, title], i) => (
              <Collapse key={t} open={s.rows > i}>
                <div className="cz-ev">
                  <span className="cz-ev__t">{t}</span>
                  <P className="cz-ev__title">{title}</P>
                </div>
              </Collapse>
            ))}
          </div>
          <Collapse open={s.mail} reveal="drop" from="below">
            <div className="cz-chip"><Icon name="mail" size={13} /><P>{['새 메일 2통은', '요약해 뒀어요']}</P></div>
          </Collapse>
        </>
      )}
    </CardStage>
  )
}

type Reply = { draft: boolean; send: Send }

export function CommentScene() {
  return (
    <CardStage<Reply>
      name="reply"
      cursor
      initial={{ draft: false, send: 'idle' }}
      poster={{ draft: true, send: 'done' }}
      script={async (a) => {
        await a.wait(500)
        a.put({ draft: true })
        await a.wait(1300)
        await a.click({ at: 'send', x: 0.55, y: 0.6 })
        a.put({ send: 'busy' })
        await a.wait(700)
        a.put({ send: 'done' })
        await a.move({ wide: { x: 470, y: 250 }, compact: { x: 320, y: 250 } })
      }}
    >
      {(s) => (
        <>
          <div className="cz-comment">
            <Avatar name="산" size={28} />
            <div className="cz-comment__b">
              <span className="cz-meta"><b>산책하는고양이</b> · 유튜브 댓글</span>
              <P className="cz-text">{['영상 잘 봤어요!', '다음 편은 언제 올라와요?']}</P>
            </div>
          </div>
          <Collapse open={s.draft} reveal="drop" from="below">
            <div className="dz-draft cz-draft">
              <div className="dz-draft__body">
                <P>{['다음 주 금요일에 올라가요.', '봐 주셔서 고마워요!']}</P>
              </div>
              <DraftActions send={s.send} at="방금" />
            </div>
          </Collapse>
        </>
      )}
    </CardStage>
  )
}

type Watch = { alert: boolean }

export function WatchScene() {
  return (
    <CardStage<Watch>
      name="watch"
      initial={{ alert: false }}
      poster={{ alert: true }}
      script={async (a) => {
        await a.wait(600)
        a.put({ alert: true })
      }}
    >
      {(s) => (
        <>
          <div className="cz-title"><Icon name="bell" size={15} />알림</div>
          <div className="cz-alerts">
            <Collapse open={s.alert} reveal="drop">
              <div className="cz-alert" data-new>
                <span className="cz-alert__ic"><Icon name="bell" size={14} /></span>
                <span className="cz-alert__b">
                  <b>가격이 바뀌었어요</b>
                  <span className="cz-price">캠핑 의자 <s>89,000원</s> → <em>72,000원</em></span>
                </span>
                <span className="cz-alert__time">방금</span>
              </div>
            </Collapse>
            <div className="cz-alert">
              <span className="cz-alert__ic"><Icon name="lock" size={14} /></span>
              <span className="cz-alert__b">
                <b>로그인 유지</b>
                <span>사이트 세 곳 · 바뀐 것 없음</span>
              </span>
              <span className="cz-alert__time">오전 8:00</span>
            </div>
            <div className="cz-alert">
              <span className="cz-alert__ic"><Icon name="globe" size={14} /></span>
              <span className="cz-alert__b"><Bar w={120} h={7} tone={3} /><Bar w={170} h={6} tone={2} /></span>
              <span className="cz-alert__time">어제</span>
            </div>
          </div>
        </>
      )}
    </CardStage>
  )
}

type Task = { run: boolean; done: boolean; file: boolean }

export function TaskScene() {
  return (
    <CardStage<Task>
      name="task"
      initial={{ run: false, done: false, file: false }}
      poster={{ run: true, done: true, file: true }}
      script={async (a) => {
        await a.wait(300)
        a.put({ run: true })
        await a.wait(2300)
        a.put({ done: true })
        await a.wait(500)
        a.put({ file: true })
      }}
    >
      {(s) => (
        <>
          <div className="cz-title"><Icon name="file" size={15} />블로그 글</div>
          <div className="cz-task">
            <div className="cz-task__row">
              <span className="cz-task__name">
                <span className="cz-meta">백그라운드 작업</span>
                <P className="cz-task__t">{['캠핑장 세 곳', '비교해서 정리하기']}</P>
              </span>
              <span className="cz-badge" data-done={s.done || undefined}>
                <span className="dz-layer" data-on={!s.done || undefined}><Spinner size={11} />진행 중</span>
                <span className="dz-layer" data-on={s.done || undefined}><Check on={s.done} size={12} />완료</span>
              </span>
            </div>
            <div className="cz-meter"><span data-run={s.run || undefined} /></div>
          </div>
          <Collapse open={s.file} reveal="drop" from="below">
            <div className="cz-bot">
              <ChatHead at="오후 3:12" />
              <P className="cz-text">{['정리했어요.', '결과 파일을 올려 뒀어요.']}</P>
              <div className="cz-file">
                <span className="cz-file__ic"><Icon name="file" size={15} /></span>
                <span><b>캠핑장_비교.md</b><span>결과 파일 · 3.1KB</span></span>
              </div>
            </div>
          </Collapse>
        </>
      )}
    </CardStage>
  )
}
