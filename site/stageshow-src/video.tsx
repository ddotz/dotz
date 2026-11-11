import { ArrowUp, Bell, ChevronLeft, Plus, Search } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Stage } from './kit/stage'
import { Phone } from './kit/phone'
import { Collapse } from './kit/motion/Collapse'
import { Icon } from './kit/parts/Icon'
import type { Act } from './kit/act'
import { AppMark, DraftActions, P, useDark, type Send } from './shared'
import { strings } from './strings'
import './look.css'
import './hero.css'
import './cards.css'
import './video.css'

// The README's intro video. Only the recorder (record.ts) opens it; the landing never loads it.
// One phone, the web app's own screens, and four short scenes in one loop:
//   0  a request is handed to a session and its report comes back
//   1  a mail is summed up, its reply waits on a decision card until Send is pressed
//   2  a watch fires and lands as a notice on the home screen
//   3  the worklog card opens under it and keeps all of it
// The left column says what dotz is the whole time (the first five seconds are scene 0) and
// names the scene. Every beat closes what it opened, so the loop ends on the frame it began with.

type V = {
  cap: number
  view: 'chat' | 'home'
  ask: boolean
  ack: boolean
  task: 0 | 1 | 2
  report: boolean
  mail: boolean
  summary: boolean
  draft: boolean
  dock: boolean
  send: Send
  notices: boolean
  watch: boolean
  log: boolean
  rows: number
}

const initial: V = { cap: 0, view: 'chat', ask: false, ack: false, task: 0, report: false, mail: false, summary: false, draft: false, dock: false, send: 'idle', notices: false, watch: false, log: false, rows: 0 }
const poster: V = { ...initial, ask: true, ack: true, task: 2, report: true }

async function script(a: Act<V>) {
  a.mark('start')
  // 0: hand a task over, the report comes back
  await a.wait(600)
  a.put({ ask: true })
  await a.wait(900)
  a.put({ ack: true })
  await a.wait(1000)
  a.put({ task: 1 })
  await a.wait(1600)
  a.put({ task: 2 })
  await a.wait(900)
  a.put({ report: true })
  await a.wait(2600)
  a.put({ cap: 1, report: false })
  await a.wait(70)
  a.put({ task: 0 })
  await a.wait(70)
  a.put({ ack: false })
  await a.wait(70)
  a.put({ ask: false })
  await a.wait(700)
  // 1: a mail, its summary, a draft waiting for Send
  a.put({ mail: true })
  await a.wait(1000)
  a.put({ summary: true })
  await a.wait(1200)
  a.put({ draft: true, dock: true })
  await a.wait(1400)
  await a.click({ at: 'send', x: 0.55, y: 0.6 })
  a.put({ send: 'busy' })
  await a.wait(800)
  a.put({ send: 'done' })
  await a.wait(900)
  a.put({ dock: false })
  await a.wait(1300)
  a.put({ draft: false })
  await a.wait(70)
  a.put({ summary: false })
  await a.wait(70)
  a.put({ mail: false })
  await a.wait(500)
  a.put({ send: 'idle' })
  // 2: a watch fires, a notice lands
  a.put({ cap: 2, view: 'home', notices: true })
  await a.wait(1100)
  a.put({ watch: true })
  await a.wait(2500)
  // 3: the worklog
  a.put({ cap: 3, watch: false, notices: false })
  await a.wait(700)
  a.put({ log: true })
  await a.wait(500)
  for (let i = 1; i <= 4; i++) {
    a.put({ rows: i })
    await a.wait(300)
  }
  await a.wait(2400)
  a.put({ cap: 0, view: 'chat' })
  await a.wait(500)
  a.put({ notices: false, log: false, rows: 0 })
  await a.wait(600)
  a.mark('end')
  await a.wait(60)
}

const STAGE = { width: 960, height: 700 }
const TIMES = ['9:20', '9:41', '9:44', '9:45']

function Lines({ children, className }: { children: string[]; className?: string }) {
  const { sep } = strings()
  return (
    <div className={className}>
      {children.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && sep}
          <span className="vd-ln">{l}</span>
        </Fragment>
      ))}
    </div>
  )
}

// A separator dot stays at the end of the line before it: the character in front of it and the dot are one unbreakable
// piece (a no-break space alone still lets a line break after a Chinese character). Each piece between dots is a
// vd-seg, which Japanese and Chinese keep whole (video.css), so their lines break after a dot, not inside a word.
function keepSep(s: string): ReactNode {
  const parts = s.split(/\s+·\s*/)
  if (parts.length === 1) return s
  return parts.map((p, i) =>
    i === parts.length - 1 ? (
      <span key={i} className="vd-seg">{p}</span>
    ) : (
      <Fragment key={i}>
        <span className="vd-seg">
          {p.slice(0, -1)}
          <span className="vd-nb">{p.slice(-1)} ·</span>
        </span>{' '}
      </Fragment>
    ),
  )
}

function Row({ title, note, time, unread, last, children }: { title: string; note?: string; time: string; unread?: boolean; last?: boolean; children?: ReactNode }) {
  return (
    <div className="cz-nt" data-unread={unread || undefined} data-last={last || undefined}>
      <span className="cz-nt__dot" />
      <span className="cz-nt__b">
        <b>{keepSep(title)}</b>
        {note && <span>{keepSep(note)}</span>}
        {children}
      </span>
      <span className="cz-nt__time">{time}</span>
    </div>
  )
}

export function VideoScene() {
  const dark = useDark()
  const { video: v, hero: h, tags, watch: w } = strings()
  return (
    <Stage
      className="dz vd"
      width={STAGE.width}
      height={STAGE.height}
      theme={dark ? 'dark' : 'light'}
      initial={initial}
      poster={poster}
      script={script}
      play="loop"
      cursor={{ at: { x: 840, y: 610 }, style: 'touch' }}
    >
      {(s) => (
        <>
          <div className="vd-copy">
            <div className="vd-brand"><AppMark size={34} /><b>dotz</b></div>
            <Lines className="vd-tag">{v.tagline}</Lines>
            <div className="vd-caps">
              {v.scenes.map((c, i) => (
                <div key={i} className="vd-cap" data-on={s.cap === i || undefined}>
                  <Lines className="vd-cap__t">{c.title}</Lines>
                  <Lines className="vd-cap__s">{c.sub}</Lines>
                </div>
              ))}
            </div>
            <div className="vd-steps" aria-hidden>
              {v.scenes.map((_, i) => <i key={i} data-on={s.cap === i || undefined} />)}
            </div>
          </div>
          <Phone width={300} frame="pro" time={TIMES[s.cap]} dark={dark} wallpaper="var(--bg)" className="hz-phone vd-phone">
            <div className="hz-app">
              <div className="hz-bar">
                <ChevronLeft className="hz-back" size={20} aria-hidden />
                <h2>dotz</h2>
                <Search size={17} strokeWidth={1.75} aria-hidden />
                <span className="hz-bell"><Bell size={18} strokeWidth={1.75} aria-hidden /><span className="hz-bd">1</span></span>
              </div>
              <div className="vd-views">
                <div className="vd-view" data-off={s.view !== 'chat' || undefined}>
                  <div className="hz-cv">
                    <div className="hz-thread">
                      <Collapse open={s.ask} reveal="drop" from="below">
                        <div className="hz-msg hz-me">
                          <span className="hz-bub"><P>{v.hand.ask}</P></span>
                        </div>
                      </Collapse>
                      <Collapse open={s.ack} reveal="drop" from="below">
                        <div className="hz-msg">
                          <span className="hz-mm"><b>dotz</b> · {v.hand.ackAt}</span>
                          <P className="hz-text">{v.hand.ack}</P>
                        </div>
                      </Collapse>
                      <Collapse open={s.task > 0} reveal="drop" from="below">
                        <div className="vd-task">
                          <div className="vd-task__hd">
                            <i className="vd-st" data-done={s.task === 2 || undefined} />
                            <b>{v.hand.task}</b>
                            <span className="dz-swap">
                              <span className="dz-tag dz-tag--pri" data-off={s.task === 2 || undefined}>{v.hand.running}</span>
                              <span className="dz-tag dz-tag--ok" data-off={s.task !== 2 || undefined}>{v.hand.done}</span>
                            </span>
                          </div>
                          <Collapse open={s.task === 2}>
                            <span className="vd-chip"><Icon name="file" size={13} />{v.hand.file}</span>
                          </Collapse>
                        </div>
                      </Collapse>
                      <Collapse open={s.report} reveal="drop" from="below">
                        <div className="hz-msg">
                          <span className="hz-mm"><b>dotz</b> · {v.hand.reportAt}</span>
                          <P className="hz-text">{v.hand.report}</P>
                        </div>
                      </Collapse>
                      <Collapse open={s.mail} reveal="drop" from="below">
                        <div className="hz-sys">
                          <Icon name="mail" size={13} />
                          <span>{v.mail.chip}</span>
                        </div>
                      </Collapse>
                      <Collapse open={s.summary} reveal="drop" from="below">
                        <div className="hz-msg">
                          <span className="hz-mm"><b>dotz</b> · {v.mail.summaryAt}</span>
                          <P className="hz-text">{v.mail.summary}</P>
                        </div>
                      </Collapse>
                      <Collapse open={s.draft} reveal="drop" from="below">
                        <div className="hz-q">
                          <div className="hz-q__hd">
                            <span className="hz-mm">{v.mail.draftFor}</span>
                            <span className="dz-swap">
                              <span className="dz-tag dz-tag--warn" data-off={s.send === 'done' || undefined}>{tags.review}</span>
                              <span className="dz-tag dz-tag--ok" data-off={s.send !== 'done' || undefined}>{tags.sent}</span>
                            </span>
                          </div>
                          <P className="hz-q__body">{v.mail.draftBody}</P>
                        </div>
                      </Collapse>
                    </div>
                    <Collapse open={s.dock} reveal="drop" from="below">
                      <div className="hz-dock">
                        <div className="hz-dock__q">
                          <span className="dz-tag dz-tag--warn">{tags.review}</span>
                          <P className="hz-dock__t">{v.mail.dock}</P>
                        </div>
                        <DraftActions send={s.send} at={v.mail.sentAt} />
                      </div>
                    </Collapse>
                    <div className="hz-cmp">
                      <div className="hz-box">
                        <Plus size={18} strokeWidth={1.75} aria-hidden />
                        <span className="hz-ph">{h.composer}</span>
                        <span className="hz-send"><ArrowUp size={16} strokeWidth={2} aria-hidden /></span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="vd-view" data-off={s.view !== 'home' || undefined}>
                  <div className="vd-home">
                    <Collapse open={s.notices} reveal="drop">
                      <div className="vd-slot">
                        <div className="vd-card">
                          <h3 className="vd-card__t">{w.notices}</h3>
                          <div className="vd-list">
                            <Collapse open={s.watch} reveal="drop">
                              <Row title={w.changed} time={w.now} unread>
                                <span className="cz-price">{w.item} <s>{w.before}</s> → <em>{w.after}</em></span>
                              </Row>
                            </Collapse>
                            <Row title={w.keep} note={w.keepNote} time={w.keepAt} />
                            <Row title={v.brief.title} note={v.brief.note} time={v.brief.at} />
                          </div>
                        </div>
                      </div>
                    </Collapse>
                    <Collapse open={s.log} reveal="drop">
                      <div className="vd-slot">
                        <div className="vd-card vd-wl">
                          <h3 className="vd-card__t">{v.worklog.title}</h3>
                          <div className="vd-list">
                            {v.worklog.rows.map(([title, time, chip], i) => (
                              <Collapse key={i} open={s.rows > i}>
                                <Row title={title} time={time}>
                                  {chip && <span className="vd-chip"><Icon name="file" size={13} />{chip}</span>}
                                </Row>
                              </Collapse>
                            ))}
                          </div>
                        </div>
                      </div>
                    </Collapse>
                  </div>
                </div>
              </div>
            </div>
          </Phone>
        </>
      )}
    </Stage>
  )
}

createRoot(document.getElementById('root')!).render(<VideoScene />)
