import { inlineCss } from './inline-css'

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
