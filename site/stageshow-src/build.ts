import type { BunPlugin } from 'bun'

// One self-contained file: every CSS import becomes a <style> the bundle adds itself.
const inlineCss: BunPlugin = {
  name: 'inline-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      const css = (await Bun.file(path).text()).replace(/^@import .*;$/gm, '')
      return {
        loader: 'js',
        contents: `const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);`,
      }
    })
  },
}

const out = await Bun.build({
  entrypoints: [`${import.meta.dir}/main.tsx`],
  outdir: `${import.meta.dir}/../js`,
  naming: 'stageshow.js',
  target: 'browser',
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [inlineCss],
})

if (!out.success) {
  for (const log of out.logs) console.error(log)
  process.exit(1)
}
for (const o of out.outputs) console.log(o.path, `${(o.size / 1024).toFixed(1)} KB`)
