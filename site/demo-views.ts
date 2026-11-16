import { readScreens } from "../hub/screens-read";

// The web app's view switch (05-command-palette.js) touches #v-<view> for every view in its list, so one section missing
// from the hand-written site/demo/index.html throws on every switch and blanks the demo. web/index.html has them all.
// Only the screens marked html: true in the SCREENS table (web/js/03-screens.js) have theirs there; the app builds the others itself.
export const assertDemoViews = (js: string, html: string) => {
  const rows = readScreens(js);
  if (!rows) throw new Error("site/build-demo.ts: no `const SCREENS = {...}` in the web JS, so the demo's sections cannot be checked");
  const missing = rows.filter(r => r.html && !html.includes(`id="v-${r.id}"`)).map(r => r.id);
  if (missing.length) throw new Error(`site/demo/index.html has no section for: ${missing.map(v => `#v-${v}`).join(", ")}. Copy it from web/index.html.`);
};
