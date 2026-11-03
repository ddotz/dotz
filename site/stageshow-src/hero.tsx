import { Stage } from './kit/stage'
import { Window, Bar } from './kit/window'
import { Collapse } from './kit/motion/Collapse'
import { Icon } from './kit/parts/Icon'
import type { Act } from './kit/act'
import { AppMark, DraftActions, P, useDark, type Send } from './shared'
import './hero.css'

// Beats: a new mail lands in the dotz chat, dotz posts a summary, then the
// reply draft as a confirmation card; the cursor presses 보내기 and the card
// says 보냈어요 on itself. The three added items leave together (newest first)
// and the loop begins on the same finished chat it opened on.

type S = { mail: boolean; summary: boolean; draft: boolean; send: Send }

const initial: S = { mail: false, summary: false, draft: false, send: 'idle' }
const poster: S = { mail: true, summary: true, draft: true, send: 'idle' }

async function script(a: Act<S>) {
  await a.wait(700)
  a.put({ mail: true })
  await a.wait(1100)
  a.put({ summary: true })
  await a.wait(1300)
  a.put({ draft: true })
  await a.wait(1500)
  await a.click({ at: 'send', x: 0.55, y: 0.6 })
  a.put({ send: 'busy' })
  await a.wait(800)
  a.put({ send: 'done' })
  await a.move({ wide: { x: 900, y: 470 }, compact: { x: 320, y: 470 } })
  await a.wait(2000)
  a.put({ draft: false })
  await a.wait(70)
  a.put({ summary: false })
  await a.wait(70)
  a.put({ mail: false })
  await a.wait(700)
  a.put({ send: 'idle' })
}

const TABS = ['홈', '채팅', '프로젝트', '모니터링', '설정']

function Sidebar() {
  return (
    <div className="hz-side">
      <div className="hz-item" data-on>
        <span className="hz-ic"><AppMark size={16} /></span>
        <span className="hz-item__t"><b>dotz</b><span>새 메일을 정리하고 있어요</span></span>
      </div>
      <div className="hz-item">
        <span className="hz-ic"><Icon name="bell" size={14} /></span>
        <span className="hz-item__t"><b>알림</b><Bar w={96} h={6} tone={2} /></span>
      </div>
      <div className="hz-item">
        <span className="hz-ic"><Icon name="clock" size={14} /></span>
        <span className="hz-item__t"><b>작업내역</b><Bar w={110} h={6} tone={2} /></span>
      </div>
      <div className="hz-sec">프로젝트</div>
      {[120, 92].map((w, i) => (
        <div className="hz-item" key={i}>
          <span className="hz-ic"><Icon name="file" size={14} /></span>
          <span className="hz-item__t"><Bar w={60 + i * 14} h={7} tone={3} /><Bar w={w} h={6} tone={2} /></span>
        </div>
      ))}
    </div>
  )
}

export default function HeroScene() {
  const dark = useDark()
  return (
    <Stage
      className="dz hz"
      width={1000}
      height={600}
      compact={{ below: 600, width: 358, height: 560 }}
      fill
      theme={dark ? 'dark' : 'light'}
      initial={initial}
      poster={poster}
      script={script}
      play="loop"
      cursor={{ at: { wide: { x: 900, y: 470 }, compact: { x: 320, y: 470 } } }}
    >
      {(s, _rect, layout) => (
        <Window title="dotz" className="hz-win">
          <div className="hz-app">
            <div className="hz-nav">
              <span className="hz-brand"><AppMark size={20} />dotz</span>
              {(layout === 'wide' ? TABS : ['채팅']).map((t) => (
                <span key={t} className="hz-tab" data-on={t === '채팅' || undefined}>{t}</span>
              ))}
            </div>
            <div className="hz-main">
              {layout === 'wide' && <Sidebar />}
              <div className="hz-chat">
                <div className="hz-head">
                  <AppMark size={30} />
                  <span><b>dotz</b><span>대기 중</span></span>
                </div>
                <div className="hz-thread">
                  <div className="hz-me"><Bar w={210} h={36} r={18} tone={1} /></div>
                  <div className="hz-bot hz-past">
                    <Bar w={90} h={7} tone={2} />
                    <Bar w={380} h={8} tone={2} />
                    <Bar w={260} h={8} tone={2} />
                  </div>
                  <div className="hz-me">
                    <span className="hz-bubble"><P>{['새 메일이 오면', '요약하고 답장 초안 써 줘']}</P></span>
                    <span className="hz-time">오전 9:12</span>
                  </div>
                  <div className="hz-bot">
                    <span className="hz-meta"><b>dotz</b> · 오전 9:12</span>
                    <P className="hz-text">{['알겠어요.', '보내기 전에 꼭 보여 드릴게요.']}</P>
                  </div>
                  <Collapse open={s.mail} reveal="drop" from="below">
                    <div className="hz-notice">
                      <Icon name="mail" size={14} />
                      <span>새 메일 · 한지우 · 다음 주 촬영 일정</span>
                      <span className="hz-notice__time">오전 9:41</span>
                    </div>
                  </Collapse>
                  <Collapse open={s.summary} reveal="drop" from="below">
                    <div className="hz-bot">
                      <span className="hz-meta"><b>dotz</b> · 오전 9:41</span>
                      <P className="hz-text">{['한지우 님이', '다음 주 화요일 오후에', '촬영이 되는지 물어봤어요.']}</P>
                    </div>
                  </Collapse>
                  <Collapse open={s.draft} reveal="drop" from="below">
                    <div className="dz-draft hz-draft">
                      <div className="dz-draft__hd">
                        <Icon name="send" size={14} />
                        <span className="dz-draft__title">보낼 초안: 답장</span>
                        <span>메일</span>
                      </div>
                      <div className="dz-draft__to"><span>받는 사람</span><b>한지우</b></div>
                      <div className="dz-draft__body">
                        <P>{['화요일 오후 2시 좋아요.', '성수 스튜디오에서 뵐게요.']}</P>
                      </div>
                      <DraftActions send={s.send} at="오전 9:42" />
                    </div>
                  </Collapse>
                </div>
                <div className="hz-composer">
                  <span>메시지 보내기</span>
                  <span className="hz-composer__go"><Icon name="arrow" size={14} /></span>
                </div>
              </div>
            </div>
          </div>
        </Window>
      )}
    </Stage>
  )
}
