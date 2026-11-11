import type { BunPlugin } from 'bun'

// One self-contained file: every CSS import becomes a <style> the bundle adds itself.
export const inlineCss: BunPlugin = {
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
