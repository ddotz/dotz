// Records the README intro video (video.tsx) for every language: bun site/stageshow-src/record.ts
//
// The page runs on the kit's virtual clock (kit/clock.ts), installed before any page code, so time only
// moves when this script steps it by exactly one frame. Each frame is a screenshot of the stage; the page
// is sized to the stage, so the screenshot is the stage and nothing around it. Runs of identical frames
// become one frame with their summed duration, then img2webp writes the animated WebP. Frames are lossless:
// img2webp stores each frame as the changed rectangle blended over the last one, and lossy rectangles never
// fully cover what was there, so earlier titles and cards stayed behind as faint ghosts. After writing, every
// frame is decoded and compared with its screenshot (verify-video.ts); a frame that differs fails the build.
//
//   --lang ko,en     languages to record (default: all five)
//   --out dir        where the .webp files go (default: docs/assets)
//   --lossy          lossy frames instead, at --quality n (0-100, default 80); the comparison still has to pass
//   --frames dir     also keep every merged frame as a PNG, for looking at
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installVirtualClock } from './kit/clock'
import { inlineCss } from './inline-css'
import { BAD_DIFF, verifyVideo } from './verify-video'

const FPS = 25
const STAGE = { width: 960, height: 700 }
const MAX_FRAMES = FPS * 60
const FILES: Record<string, string> = { ko: 'hero', en: 'hero-en', ja: 'hero-ja', 'zh-CN': 'hero-zh-cn', es: 'hero-es' }

const here = import.meta.dir
const repo = resolve(here, '../..')
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const langs = opt('--lang', Object.keys(FILES).join(',')).split(',')
const outDir = resolve(opt('--out', join(repo, 'docs/assets')))
const quality = Number(opt('--quality', '80'))
const lossless = !flag('--lossy')
const framesDir = args.includes('--frames') ? resolve(opt('--frames', '')) : null
for (const l of langs) if (!FILES[l]) throw new Error(`unknown language ${l}; use ${Object.keys(FILES).join(', ')}`)

const work = mkdtempSync(join(tmpdir(), 'dotz-video-'))
const built = await Bun.build({
  entrypoints: [join(here, 'video.tsx')],
  outdir: work,
  naming: 'video.js',
  target: 'browser',
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [inlineCss],
})
if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}

// The video is always the light look, whatever the machine's scheme is: the dark block of the tokens never applies, and the scene's own dark check (matchMedia) answers no.
const css = (await Bun.file(join(repo, 'site/style.css')).text()).replace('color-scheme: light dark', 'color-scheme: light').replace('@media (prefers-color-scheme: dark)', '@media not all')
const light = `const mm=matchMedia.bind(window);window.matchMedia=(q)=>/prefers-color-scheme:\\s*dark/.test(q)?{matches:false,media:q,addEventListener(){},removeEventListener(){}}:mm(q);`
const page = (lang: string) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;background:var(--bg)}#root{width:${STAGE.width}px;height:${STAGE.height}px;overflow:hidden}</style>
<script>${light}window.__stageshow={theme:'light'};(${installVirtualClock.toString()})({fps:${FPS},epoch:${Date.UTC(2026, 0, 5, 9, 0)}})</script>
</head><body><div id="root"></div><script type="module" src="/video.js"></script></body></html>`

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/video.js') return new Response(Bun.file(join(work, 'video.js')), { headers: { 'content-type': 'text/javascript' } })
    return new Response(page(url.searchParams.get('lang') ?? 'en'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
})

const webContentKb = async () => {
  const ps = await Bun.$`ps -A -o rss=,command=`.quiet().text()
  return ps
    .split('\n')
    .filter((l) => /WebContent|WebKit/.test(l))
    .reduce((n, l) => n + (Number(l.trim().split(/\s+/)[0]) || 0), 0)
}

type Run = { file: string; ms: number }
let peakWebKb = 0
let peakRssKb = 0
let peakDisk = 0

async function record(lang: string) {
  const started = performance.now()
  const dir = join(work, lang)
  mkdirSync(dir)
  const view = new Bun.WebView({ width: STAGE.width, height: STAGE.height })
  try {
    await view.navigate(`http://localhost:${server.port}/?lang=${lang}`)
    const mark = () => view.evaluate("document.querySelector('.ss-stage')?.dataset.mark ?? ''") as Promise<string>
    for (let i = 0; (await mark()) !== 'start'; i++) {
      if (i > 200) throw new Error('the scene did not start')
      await Bun.sleep(50)
    }
    const rect = JSON.parse(await view.evaluate("JSON.stringify(document.querySelector('.ss-stage').getBoundingClientRect())")) as DOMRect
    if (Math.abs(rect.x) > 0.5 || Math.abs(rect.y) > 0.5 || Math.abs(rect.width - STAGE.width) > 0.5 || Math.abs(rect.height - STAGE.height) > 0.5) {
      throw new Error(`the stage is ${rect.width}x${rect.height} at ${rect.x},${rect.y}, not the page: ${JSON.stringify(rect)}`)
    }

    const runs: Run[] = []
    let last = ''
    let raw = 0
    let disk = 0
    for (; raw < MAX_FRAMES; raw++) {
      const png = new Uint8Array(await (await view.screenshot()).arrayBuffer())
      const hash = Bun.hash(png).toString(36)
      if (hash === last) runs[runs.length - 1].ms += 1000 / FPS
      else {
        const file = join(dir, `${String(runs.length).padStart(3, '0')}.png`)
        writeFileSync(file, png)
        disk += png.length
        runs.push({ file, ms: 1000 / FPS })
        last = hash
      }
      const m = (await view.evaluate("(async () => { await window.__stageshow.clock.step(1); return document.querySelector('.ss-stage').dataset.mark ?? '' })()")) as string
      if (m === 'end') break
      if (raw % 50 === 0) {
        peakWebKb = Math.max(peakWebKb, await webContentKb())
        peakRssKb = Math.max(peakRssKb, process.memoryUsage().rss / 1024)
      }
    }
    if (raw >= MAX_FRAMES) throw new Error('the scene never reached its end')
    // The frame stepped to the mark is the first frame again; the loop supplies it.
    peakDisk = Math.max(peakDisk, disk)

    if (framesDir) {
      mkdirSync(framesDir, { recursive: true })
      for (const [i, r] of runs.entries()) await Bun.write(join(framesDir, `${lang}-${String(i).padStart(3, '0')}-${r.ms}ms.png`), Bun.file(r.file))
    }

    const out = join(outDir, `${FILES[lang]}.webp`)
    const enc = lossless ? ['-lossless', '-m', '6'] : ['-lossy', '-q', String(quality), '-m', '6', '-sharp_yuv']
    const argv = ['img2webp', '-loop', '0', ...runs.flatMap((r) => [...enc, '-d', String(r.ms), r.file]), '-o', out]
    const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' })
    if ((await p.exited) !== 0) throw new Error('img2webp failed')
    const size = Bun.file(out).size
    const diff = await verifyVideo(out, runs)
    const { worst } = diff
    console.log(`${lang.padEnd(6)} ${raw} captured -> ${runs.length} frames, ${(raw * 1000) / FPS} ms, ${size} B, ${((performance.now() - started) / 1000).toFixed(1)} s -> ${out}`)
    console.log(`${lang.padEnd(6)} decoded vs screenshots: worst frame ${worst.frame}, ${worst.badPixels} pixels off by more than ${BAD_DIFF}, largest difference ${worst.maxDiff}, mean ${diff.meanDiff.toFixed(3)}`)
    if (worst.badPixels > 0) throw new Error(`${out}: frame ${worst.frame} does not match its screenshot (${worst.badPixels} pixels off)`)
  } finally {
    view.close()
  }
}

mkdirSync(outDir, { recursive: true })
const t0 = performance.now()
try {
  for (const lang of langs) await record(lang)
} finally {
  server.stop(true)
  rmSync(work, { recursive: true, force: true })
}
const mb = (n: number) => (n / 1048576).toFixed(0)
console.log(`all ${langs.length}: ${((performance.now() - t0) / 1000).toFixed(0)} s, recorder peak ${mb(peakRssKb * 1024)} MB, WebKit processes peak ${(peakWebKb / 1024).toFixed(0)} MB, frame PNGs up to ${mb(peakDisk)} MB in a temp dir that is removed`)
