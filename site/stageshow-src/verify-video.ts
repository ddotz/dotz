// Decodes an animated WebP frame by frame the way a viewer does (each frame's rectangle drawn over the canvas
// left by the frames before it) and compares every composed frame with the screenshot it was made from.
// Uses only the libwebp tools the recorder already needs (webpmux, dwebp, cwebp); record.ts runs it after each encode.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `frame` is the index of the source screenshot. */
export type FrameDiff = { frame: number; maxDiff: number; badPixels: number }
export type VideoDiff = { frames: number; worst: FrameDiff; meanDiff: number }

/** A pixel counts as wrong when one of its channels is off by more than this. */
export const BAD_DIFF = 16

const run = async (argv: string[]) => {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${err.trim()}`)
  return out
}

const readPam = async (file: string) => {
  const buf = new Uint8Array(await Bun.file(file).arrayBuffer())
  const head = new TextDecoder().decode(buf.subarray(0, 200))
  const end = head.indexOf('ENDHDR\n') + 7
  const width = Number(/WIDTH (\d+)/.exec(head)![1])
  const height = Number(/HEIGHT (\d+)/.exec(head)![1])
  if (!/DEPTH 4/.test(head)) throw new Error(`${file}: expected RGBA`)
  return { width, height, data: buf.subarray(end, end + width * height * 4) }
}

type Rect = { width: number; height: number; x: number; y: number; ms: number; blend: boolean; dispose: boolean }

const frameRects = async (webp: string): Promise<Rect[]> =>
  (await run(['webpmux', '-info', webp]))
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => /^\d+:$/.test(c[0] ?? ''))
    .map((c) => ({ width: +c[1], height: +c[2], x: +c[4], y: +c[5], ms: +c[6], dispose: c[7] === 'background', blend: c[8] === 'yes' }))

/**
 * Compares `webp` with the screenshots it was encoded from (`sources`, in order, each with how long it shows).
 * Matched by time, since an encoder may merge frames it finds alike: every source is checked against the frame on screen when it starts.
 */
export async function verifyVideo(webp: string, sources: { file: string; ms: number }[]): Promise<VideoDiff> {
  const rects = await frameRects(webp)
  const total = (xs: { ms: number }[]) => xs.reduce((n, x) => n + x.ms, 0)
  if (Math.abs(total(rects) - total(sources)) > 1) throw new Error(`${webp}: ${total(rects)} ms, but the sources last ${total(sources)} ms`)
  let next = 0
  let sourceAt = 0
  let frameAt = 0
  const dir = mkdtempSync(join(tmpdir(), 'dotz-verify-'))
  try {
    const first = rects[0]
    const W = first.width
    const H = first.height
    const canvas = new Uint8Array(W * H * 4)
    let worst: FrameDiff = { frame: 0, maxDiff: -1, badPixels: 0 }
    let sum = 0
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]
      const part = join(dir, 'part.webp')
      await run(['webpmux', '-get', 'frame', String(i + 1), webp, '-o', part])
      await run(['dwebp', part, '-pam', '-o', join(dir, 'part.pam')])
      const px = await readPam(join(dir, 'part.pam'))
      for (let y = 0; y < r.height; y++) {
        for (let x = 0; x < r.width; x++) {
          const s = (y * r.width + x) * 4
          const d = ((r.y + y) * W + r.x + x) * 4
          const a = px.data[s + 3] / 255
          if (!r.blend || a === 1) {
            canvas.set(px.data.subarray(s, s + 4), d)
          } else if (a > 0) {
            for (let c = 0; c < 3; c++) canvas[d + c] = Math.round(px.data[s + c] * a + canvas[d + c] * (1 - a))
            canvas[d + 3] = 255
          }
        }
      }
      frameAt += r.ms
      for (; next < sources.length && sourceAt < frameAt - 0.5; sourceAt += sources[next++].ms) {
        // The source screenshot, through a lossless WebP so dwebp can hand back its exact pixels
        await run(['cwebp', '-quiet', '-lossless', '-exact', sources[next].file, '-o', join(dir, 'src.webp')])
        await run(['dwebp', join(dir, 'src.webp'), '-pam', '-o', join(dir, 'src.pam')])
        const src = await readPam(join(dir, 'src.pam'))
        if (src.width !== W || src.height !== H) throw new Error(`${sources[next].file} is ${src.width}x${src.height}, the video ${W}x${H}`)
        let maxDiff = 0
        let badPixels = 0
        let frameSum = 0
        for (let p = 0; p < W * H * 4; p += 4) {
          let m = 0
          for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(canvas[p + c] - src.data[p + c]))
          frameSum += m
          if (m > maxDiff) maxDiff = m
          if (m > BAD_DIFF) badPixels++
        }
        sum += frameSum / (W * H)
        if (badPixels > worst.badPixels || (badPixels === worst.badPixels && maxDiff > worst.maxDiff)) worst = { frame: next, maxDiff, badPixels }
      }
      // A frame that clears its rectangle after showing (dispose background) leaves transparency behind it
      if (r.dispose) for (let y = 0; y < r.height; y++) canvas.fill(0, ((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.width) * 4)
    }
    return { frames: sources.length, worst, meanDiff: sum / sources.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
