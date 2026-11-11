import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoBannedWords, scrubBundle } from "./banned-words";

const SHORT = "\uCE74\uD1A1", LONG = "\uCE74\uCE74\uC624\uD1A1", ENGLISH = "Kakao" + "Talk";
let dir = "";
const site = () => (dir = mkdtempSync(join(tmpdir(), "dotz-site-")));
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

test.each([SHORT, LONG, ENGLISH, ENGLISH.toUpperCase()])("a planted word in a nested file fails the check: %s", word => {
  const root = site();
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "fixtures.js"), `const a = 1;\n// ${word}\n`);
  expect(() => assertNoBannedWords(root)).toThrow("demo/fixtures.js:2");
});

test("the rules file that names the word stays out of the deployed set", () => {
  const root = site();
  writeFileSync(join(root, "AGENTS.md"), LONG);
  expect(() => assertNoBannedWords(root)).not.toThrow();
});

test("the bundle loses every form, and a list item its separator", () => {
  const out = scrubBundle(`"메일 · ${LONG}" "메일 · ${SHORT} · 댓글" kind: "${LONG}" // ${ENGLISH}-style ${ENGLISH.toLowerCase()}`);
  expect(out).toBe('"메일" "메일 · 댓글" kind: "메신저" // Messenger-style Messenger');
});

// Copies site/ and web/ and runs a real build in a child bun; minutes of CPU contention on a shared machine make the 5 s default too tight.
test("build-demo exits non-zero on a planted word and names the file", async () => {
  const root = site(), repo = join(import.meta.dir, "..");
  const skip = (src: string) => !src.includes("node_modules");
  cpSync(join(repo, "site"), join(root, "site"), { recursive: true, filter: skip });
  cpSync(join(repo, "web"), join(root, "web"), { recursive: true, filter: skip });
  writeFileSync(join(root, "site", "planted.txt"), LONG);
  // The copy is no git checkout, so build-demo's `git show` per web file fails anyway (about 140 spawns, over 1 s): with git out of reach it reads the files at once.
  const run = Bun.spawn([process.execPath, join(root, "site", "build-demo.ts")], { cwd: root, env: { ...process.env, PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  expect(code).not.toBe(0);
  expect(err).toContain("planted.txt:1");
}, 30_000);
