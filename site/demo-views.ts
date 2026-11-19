import { readScreens } from "../hub/screens-read";

const DEMO_LEAVES_OUT_WITH_REASON: Record<string, string> = {};

const VOID_TAG: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, source: true, track: true, wbr: true };
export function idsInViewSections(html: string): string[] {
  const out: string[] = [], inView: boolean[] = [];
  for (const [, close, tag, attrs] of html.replace(/<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    if (close) { inView.pop(); continue; }
    const id = /\sid="([^"]+)"/.exec(attrs!)?.[1], here = (inView.at(-1) ?? false) || !!id?.startsWith("v-");
    if (here && id) out.push(id);
    if (!VOID_TAG[tag!.toLowerCase()] && !attrs!.endsWith("/")) inView.push(here);
  }
  return out;
}

// The web app's view switch (05-command-palette.js) touches #v-<view> for every view in its list, so one section missing
// from the hand-written site/demo/index.html throws on every switch and blanks the demo. web/index.html has them all.
// Only the screens marked html: true in the SCREENS table (web/js/03-screens.js) have theirs there; the app builds the others itself.
export const assertDemoViews = (js: string, html: string, webHtml: string) => {
  const rows = readScreens(js);
  if (!rows) throw new Error("site/build-demo.ts: no `const SCREENS = {...}` in the web JS, so the demo's sections cannot be checked");
  const missing = rows.filter(r => r.html && !html.includes(`id="v-${r.id}"`)).map(r => r.id);
  if (missing.length) throw new Error(`site/demo/index.html has no section for: ${missing.map(v => `#v-${v}`).join(", ")}. Copy it from web/index.html.`);
  const demoIds = new Set(html.match(/\sid="[^"]+"/g)?.map(a => a.slice(5, -1)));
  const lost = idsInViewSections(webHtml).filter(id => !demoIds.has(id) && !(id in DEMO_LEAVES_OUT_WITH_REASON));
  if (lost.length) throw new Error(`site/demo/index.html has none of these elements web/index.html has in its views: ${lost.map(id => `#${id}`).join(", ")}. Copy them from web/index.html.`);
};
