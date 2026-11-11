import { ArrowUp, Bell, ChevronLeft, Plus, Search } from 'lucide-react'
import { Stage } from './kit/stage'
import { Phone } from './kit/phone'
import { Collapse } from './kit/motion/Collapse'
import { Icon } from './kit/parts/Icon'
import type { Act } from './kit/act'
import { DraftActions, P, useDark, type Send } from './shared'
import { strings } from './strings'
import './hero.css'

// The moment the page is about: away from the desk, phone in hand. The chat
// screen of the web app as a phone shows it. Beats: a new mail lands in the
// dotz chat, dotz posts a summary with the reply draft, and a thin decision
// card docks above the composer. A finger presses 보내기, the card says 보냈어요
// on itself and leaves, and the draft's tag turns to 보냈어요 in place. The
// three added items leave together (newest first) and the loop begins on the
// same finished chat it opened on.

type S = { mail: boolean; summary: boolean; draft: boolean; dock: boolean; send: Send }

const initial: S = { mail: false, summary: false, draft: false, dock: false, send: 'idle' }
const poster: S = { mail: true, summary: true, draft: true, dock: false, send: 'done' }

async function script(a: Act<S>) {
  await a.wait(700)
  a.put({ mail: true })
  await a.wait(1100)
  a.put({ summary: true })
  await a.wait(1300)
  a.put({ draft: true, dock: true })
  await a.wait(1500)
  await a.click({ at: 'send', x: 0.55, y: 0.6 })
  a.put({ send: 'busy' })
  await a.wait(800)
  a.put({ send: 'done' })
  await a.wait(900)
  a.put({ dock: false })
  await a.wait(2000)
  a.put({ draft: false })
  await a.wait(70)
  a.put({ summary: false })
  await a.wait(70)
  a.put({ mail: false })
  await a.wait(700)
  a.put({ send: 'idle' })
}

// The stage is the phone plus room for its shadow. The phone's screen is drawn in iPhone points
// and scaled down (kit/phone.tsx); hero.css zooms the chat back up so its type renders near its own size.
const STAGE = { width: 340, height: 676 }
const PHONE = 300
// A phone is too narrow for a whole "kind · who · subject" line: the chip keeps kind and sender (the summary under it says the subject), the draft's header keeps the kind (the card under it names the person).
const lead = (line: string, parts: number) => line.split(' · ').slice(0, parts).join(' · ')

export default function HeroScene() {
  const dark = useDark()
  const { hero: t, tags } = strings()
  return (
    <Stage
      className="dz hz"
      width={STAGE.width}
      height={STAGE.height}
      fill
      theme={dark ? 'dark' : 'light'}
      initial={initial}
      poster={poster}
      script={script}
      play="loop"
      cursor={{ at: { x: 250, y: 560 }, style: 'touch' }}
    >
      {(s) => (
        <Phone width={PHONE} frame="pro" time="9:41" dark={dark} wallpaper="var(--bg)" className="hz-phone">
          <div className="hz-app">
            <div className="hz-bar">
              <ChevronLeft className="hz-back" size={20} aria-hidden />
              <h2>dotz</h2>
              <Search size={17} strokeWidth={1.75} aria-hidden />
              <span className="hz-bell"><Bell size={18} strokeWidth={1.75} aria-hidden /><span className="hz-bd">1</span></span>
            </div>
            <div className="hz-cv">
              <div className="hz-thread">
                <div className="hz-msg hz-me">
                  <span className="hz-bub"><P>{t.ask}</P></span>
                </div>
                <div className="hz-msg">
                  <span className="hz-mm"><b>dotz</b> · {t.ackAt}</span>
                  <P className="hz-text">{t.ack}</P>
                </div>
                <Collapse open={s.mail} reveal="drop" from="below">
                  <div className="hz-sys">
                    <Icon name="mail" size={13} />
                    <span>{lead(t.mail, 2)}</span>
                  </div>
                </Collapse>
                <Collapse open={s.summary} reveal="drop" from="below">
                  <div className="hz-msg">
                    <span className="hz-mm"><b>dotz</b> · {t.summaryAt}</span>
                    <P className="hz-text">{t.summary}</P>
                  </div>
                </Collapse>
                <Collapse open={s.draft} reveal="drop" from="below">
                  <div className="hz-q">
                    <div className="hz-q__hd">
                      <span className="hz-mm">{lead(t.draftFor, 1)}</span>
                      <span className="dz-swap">
                        <span className="dz-tag dz-tag--warn" data-off={s.send === 'done' || undefined}>{tags.review}</span>
                        <span className="dz-tag dz-tag--ok" data-off={s.send !== 'done' || undefined}>{tags.sent}</span>
                      </span>
                    </div>
                    <P className="hz-q__body">{t.draftBody}</P>
                  </div>
                </Collapse>
              </div>
              <Collapse open={s.dock} reveal="drop" from="below">
                <div className="hz-dock">
                  <div className="hz-dock__q">
                    <span className="dz-tag dz-tag--warn">{tags.review}</span>
                    <P className="hz-dock__t">{t.dock}</P>
                  </div>
                  <DraftActions send={s.send} at={t.sentAt} />
                </div>
              </Collapse>
              <div className="hz-cmp">
                <div className="hz-box">
                  <Plus size={18} strokeWidth={1.75} aria-hidden />
                  <span className="hz-ph">{t.composer}</span>
                  <span className="hz-send"><ArrowUp size={16} strokeWidth={2} aria-hidden /></span>
                </div>
              </div>
            </div>
          </div>
        </Phone>
      )}
    </Stage>
  )
}
