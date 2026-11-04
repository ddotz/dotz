// The web app's view switch (05-command-palette.js) touches #v-<view> for every view in its list, so one section missing
// from the hand-written site/demo/index.html throws on every switch and blanks the demo. web/index.html has them all.
export const assertDemoViews = (js: string, html: string) => {
  const list = /\bconst views = \[([^\]]*)\]/.exec(js);
  if (!list) throw new Error("site/build-demo.ts: no `const views = [...]` in the web JS, so the demo's sections cannot be checked");
  const views = [...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const missing = views.filter(v => !html.includes(`id="v-${v}"`) && !js.includes(`id: "v-${v}"`));   // a view may build its own section (04-state.js, cardform)
  if (missing.length) throw new Error(`site/demo/index.html has no section for: ${missing.map(v => `#v-${v}`).join(", ")}. Copy it from web/index.html.`);
};
