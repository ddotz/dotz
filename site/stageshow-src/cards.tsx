import type { ReactNode } from 'react'
import { Stage } from './kit/stage'
import { Phone } from './kit/phone'
import { Collapse } from './kit/motion/Collapse'
import { Spinner } from './kit/parts/Spinner'
import type { Act } from './kit/act'
import { AppMark, P, useDark } from './shared'
import { strings } from './strings'
import './cards.css'

// Two looping examples for the page's second section, each one beat of the product: a phone message comes
// back with its answer, a watched price drops and a notice lands. No cursor: the system acts on its own.
// Every script closes what it opened (newest first), so a loop seams on initial.

function CardStage<S extends object>({ name, initial, poster, script, bare, children }: {
  name: string
  initial: S
  poster: S
  script: (a: Act<S>) => Promise<void>
  bare?: boolean
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
      play="loop"
      fill
    >
      {(s) => <div className={`cz-panel${bare ? ' cz-panel--bare' : ''}`}>{children(s)}</div>}
    </Stage>
  )
}

type Ask = { ask: boolean; busy: boolean; reply: boolean; rows: number }

export function PhoneScene() {
  const dark = useDark()
  const t = strings().phone
  const DAY = t.events
  return (
    <CardStage<Ask>
      name="phone"
      bare
      initial={{ ask: false, busy: false, reply: false, rows: 0 }}
      poster={{ ask: true, busy: false, reply: true, rows: 2 }}
      script={async (a) => {
        await a.wait(500)
        a.put({ ask: true })
        await a.wait(700)
        a.put({ busy: true })
        await a.wait(1300)
        a.put({ busy: false, reply: true })
        await a.wait(500)
        for (let i = 1; i <= DAY.length; i++) {
          a.put({ rows: i })
          await a.wait(260)
        }
        await a.wait(3000)
        a.put({ rows: 0 })
        await a.wait(70)
        a.put({ reply: false })
        await a.wait(70)
        a.put({ ask: false })
        await a.wait(600)
      }}
    >
      {(s) => (
        <Phone width={304} frame="bezel" time={t.time} dark={dark} wallpaper="var(--surface)" className="cz-phone">
          <div className="cz-chat">
            <div className="cz-chat__hd"><AppMark size={18} /><b>dotz</b></div>
            <Collapse open={s.ask} reveal="drop" from="below">
              <div className="cz-me"><span>{t.ask}</span></div>
            </Collapse>
            <Collapse open={s.busy}>
              <div className="cz-busy"><Spinner size={12} />{t.busy}</div>
            </Collapse>
            <Collapse open={s.reply} reveal="drop" from="below">
              <P className="cz-text">{[t.reply]}</P>
            </Collapse>
            <div className="cz-list">
              {DAY.map(([t, title], i) => (
                <Collapse key={t} open={s.rows > i}>
                  <div className="cz-ev">
                    <span className="cz-ev__t">{t}</span>
                    <span className="cz-ev__title">{title}</span>
                  </div>
                </Collapse>
              ))}
            </div>
          </div>
        </Phone>
      )}
    </CardStage>
  )
}

type Watch = { drop: boolean; alert: boolean }

export function WatchScene() {
  const t = strings().watch
  return (
    <CardStage<Watch>
      name="watch"
      bare
      initial={{ drop: false, alert: false }}
      poster={{ drop: true, alert: true }}
      script={async (a) => {
        await a.wait(1100)
        a.put({ drop: true })
        await a.wait(1100)
        a.put({ alert: true })
        await a.wait(3400)
        a.put({ alert: false })
        await a.wait(200)
        a.put({ drop: false })
        await a.wait(600)
      }}
    >
      {(s) => (
        <>
          <div className="cz-watch">
            <span className="cz-nt__b">
              <b>{t.item}</b>
              <span>{t.watching}</span>
            </span>
            <span className="cz-amt">
              <span className="dz-swap">
                <span data-off={s.drop || undefined}>{t.before}</span>
                <em data-off={!s.drop || undefined}>{t.after}</em>
              </span>
            </span>
          </div>
          <div className="cz-title">{t.notices}</div>
          <div className="cz-nts">
            <Collapse open={s.alert} reveal="drop">
              <div className="cz-nt" data-unread>
                <span className="cz-nt__dot" />
                <span className="cz-nt__b">
                  <b>{t.changed}</b>
                  <span className="cz-price">{t.item} <s>{t.before}</s> → <em>{t.after}</em></span>
                </span>
                <span className="cz-nt__time">{t.now}</span>
              </div>
            </Collapse>
            <div className="cz-nt">
              <span className="cz-nt__dot" />
              <span className="cz-nt__b">
                <b>{t.keep}</b>
                <span>{t.keepNote}</span>
              </span>
              <span className="cz-nt__time">{t.keepAt}</span>
            </div>
          </div>
        </>
      )}
    </CardStage>
  )
}
