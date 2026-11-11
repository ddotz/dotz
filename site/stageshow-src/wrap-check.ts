// Line-break check for the README video, run in the page before recording. Every text box of the four scenes
// (captions on the left, the chat on the phone) is laid out at start, closed ones included, so each one's lines
// can be read from character boxes. A box fails when its last line is shorter than LAST_LINE_MIN of its longest
// line: one word ("week", "reply?") left on a line of its own. It also fails when a line after the first starts with a
// separator dot or punctuation that belongs to the end of the line before ("· 1 reply waiting", "、", "。", "」").

export const LAST_LINE_MIN = 0.4

export const BAD_LINE_START = /^[·・,.;:!?)\]}、。，．；：！？）」』】〉》]/u

export const TEXT_BOXES = ['.vd-tag', '.vd-cap__t', '.vd-cap__s', '.vd .hz-text', '.vd .hz-q__body', '.vd .hz-dock__t', '.vd .hz-bub', '.vd-task__hd b', '.vd .cz-nt__b > *']

export type BoxLines = { box: string; lines: string[]; widths: number[]; ratio: number; badStart: boolean }

export function measureLines(selectors: string[], badStart: string): BoxLines[] {
  const bad = new RegExp(badStart, 'u')
  const out: BoxLines[] = []
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el, n) => {
      const lines: { top: number; left: number; right: number; text: string }[] = []
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const s = t.textContent ?? ''
        for (let i = 0; i < s.length; i++) {
          const r = document.createRange()
          r.setStart(t, i)
          r.setEnd(t, i + 1)
          const b = r.getBoundingClientRect()
          if (!b.width && !b.height) continue
          const line = lines.find((l) => Math.abs(l.top - b.top) < b.height / 2)
          if (!line) lines.push({ top: b.top, left: b.left, right: b.right, text: s[i] })
          else if (/\s/.test(s[i])) line.text += s[i]
          else {
            line.left = Math.min(line.left, b.left)
            line.right = Math.max(line.right, b.right)
            line.text += s[i]
          }
        }
      }
      if (!lines.length) return
      lines.sort((a, b) => a.top - b.top)
      const widths = lines.map((l) => Math.round(l.right - l.left))
      out.push({ box: `${sel}#${n}`, lines: lines.map((l) => l.text.trim()), widths, ratio: widths.length > 1 ? widths[widths.length - 1] / Math.max(...widths) : 1, badStart: lines.slice(1).some((l) => bad.test(l.text.replace(/^[\s\u200b-\u200d\u2060\ufeff]+/u, ''))) })
    })
  }
  return out
}
