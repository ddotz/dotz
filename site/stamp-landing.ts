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
