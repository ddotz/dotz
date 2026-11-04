// Builds the static demo under site/demo/ from the real web app in web/.
//   bun site/build-demo.ts
// web/css/*.css and web/js/*.js are joined in file-name order, exactly as hub/webapp.ts serves /app.css and /app.js
// (one classic script keeps the single global scope; "use strict" stays the first statement). Nothing else is copied:
// the demo's fixtures and fake transport are hand-written files beside the output.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertNoBannedWords, scrubBundle } from "./banned-words";
import { assertDemoViews } from "./demo-views";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "web");
const OUT = join(import.meta.dir, "demo");

// The gateway serves the committed web/ (hub/web-committed.ts), not a worker's half-edited checkout, and the demo is
// built from the same tree. Outside a git checkout (or without git) the files on disk are used.
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const source = (rel: string) => {
  try { return git("show", `HEAD:web/${rel}`); } catch { return readFileSync(join(WEB, rel), "utf8"); }
};
const files = (kind: "js" | "css") => readdirSync(join(WEB, kind)).filter(f => f.endsWith(`.${kind}`)).sort();
const joined = (kind: "js" | "css") => files(kind).map(f => source(`${kind}/${f}`)).join("\n");

// The page names no server asset: /custom.js (appended by 99-boot.js) becomes the demo's own empty layer beside app.js.
// Absolute /app.css and /app.js never appear in the sources; /demo/app.* are what demo/index.html loads.
const rewrite = (text: string) => scrubBundle(text.replaceAll('"/custom.js"', '"/demo/custom.js"'));

const css = rewrite(joined("css"));
// The joined text is served by the gateway verbatim, so the demo needs no other surgery on it than rewrite: the same bundles run here.
let js = rewrite(joined("js"));
assertDemoViews(js, readFileSync(join(OUT, "index.html"), "utf8"));   // before anything is written: a failed build leaves the demo as it was
const build = createHash("sha1").update(js).update(css).digest("hex").slice(0, 12);
// WEB_BUILD goes after the "use strict" directive, which must stay the first statement (hub/webapp.ts does the same).
js = js.replace('"use strict";', m => `${m}\nconst WEB_BUILD = "${build}";`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "app.css"), css);
writeFileSync(join(OUT, "app.js"), js);
// No custom layer in the demo: the app appends this script on load, so it must exist (or the page logs a 404).
writeFileSync(join(OUT, "custom.js"), "/* dotz demo: no custom layer */\n");

// The page is never cached but these files are, for hours: without a version in their address a returning browser pairs the new page with the old
// script and styles, and the layout breaks. The page names them with a hash of what they hold, so one deploy changes them together.
const assets = ["app.css", "fixtures.js", "demo-api.js", "app.js"];
const stamp = assets.reduce((h, f) => h.update(readFileSync(join(OUT, f))), createHash("sha1")).digest("hex").slice(0, 12);
const page = join(OUT, "index.html");
writeFileSync(page, readFileSync(page, "utf8").replace(/"\/demo\/(app\.css|fixtures\.js|demo-api\.js|app\.js)(?:\?v=\w+)?"/g, `"/demo/$1?v=${stamp}"`));

await import("./stamp-landing.ts");

assertNoBannedWords(import.meta.dir);   // last: covers every file that deploys, hand-written and generated alike

const kb = (s: string) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`site/demo/app.css  ${kb(css)}  (${files("css").length} files)`);
console.log(`site/demo/app.js   ${kb(js)}  (${files("js").length} files, build ${build})`);
