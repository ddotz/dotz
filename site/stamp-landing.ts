// Stamps the landing page's asset addresses with a hash of what they hold. The page is never cached but these files are, for hours:
// without a version in the address a returning browser pairs the new page with the old styles and script, and the layout breaks.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = import.meta.dir, assets = ["style.css", "app.js", "js/stageshow.js"];
const stamp = assets.reduce((h, f) => h.update(readFileSync(join(SITE, f))), createHash("sha1")).digest("hex").slice(0, 12);
const page = join(SITE, "index.html");
writeFileSync(page, readFileSync(page, "utf8").replace(/"(style\.css|app\.js|js\/stageshow\.js)(?:\?v=\w+)?"/g, `"$1?v=${stamp}"`));
console.log(`landing assets stamped ${stamp}`);

// The prototype page has the same problem. Each file gets its own hash, and the list is whatever local css and js the page names, so a new file needs no edit here.
const PROTO = join(SITE, "prototype"), protoPage = join(PROTO, "index.html");
let stamped = 0;
writeFileSync(protoPage, readFileSync(protoPage, "utf8").replace(/\b(href|src)="([\w-]+\.(?:css|js))(?:\?v=\w+)?"/g, (_, attr, file) => {
  stamped++;
  return `${attr}="${file}?v=${createHash("sha1").update(readFileSync(join(PROTO, file))).digest("hex").slice(0, 12)}"`;
}));
console.log(`prototype assets stamped ${stamped}`);
