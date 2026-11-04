// The public site never names the owner's private messenger (site/AGENTS.md). Everything under site/ deploys, this file and
// its test included, so the words are written in escapes here: the Korean name, its short form, and the English name.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const WORDS = "\\uCE74\\uCE74\\uC624\\s*\\uD1A1|\\uCE74\\uD1A1|kakao[\\s_-]*talk";
const banned = () => new RegExp(WORDS, "giu");

// The real app's bundles name it and web/ must keep doing so for real users, so only the demo's copy changes: a list item
// goes with its separator, any other mention (labels and code comments alike) becomes a neutral word.
export const scrubBundle = (text: string) => text
  .replace(new RegExp(` · (?:${WORDS})`, "giu"), "")
  .replace(banned(), m => /^[a-z]/i.test(m) ? "Messenger" : "메신저");

// site/AGENTS.md is the one tracked file left out of the deployed copy (site/README.md); node_modules is never tracked.
const deployed = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile() && !join(e.parentPath, e.name).split("/").includes("node_modules"))
  .map(e => join(e.parentPath, e.name))
  .filter(p => relative(dir, p) !== "AGENTS.md");

export const assertNoBannedWords = (dir: string) => {
  const hits = deployed(dir).flatMap(p => {
    const rel = relative(dir, p);
    if (banned().test(rel)) return [`${rel} (file name)`];
    return readFileSync(p, "utf8").split("\n").flatMap((l, i) => banned().test(l) ? [`${rel}:${i + 1}`] : []);
  });
  if (hits.length) throw new Error(`site/build-demo.ts: a word the public site must never show is in ${hits.length} place(s) (site/AGENTS.md). Remove it from:\n  ${hits.slice(0, 20).join("\n  ")}`);
};
