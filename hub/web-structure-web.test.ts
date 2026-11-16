import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const AREAS = new Set(["core", "chat", "home", "reply", "projects", "settings", "harness", "monitoring", "mail", "kakao", "comments", "notices", "peers", "panes", "shell", "boot"]);

test("hub/web-areas.json names every web/js file once and registers the pending ones", () => {
  const { pending, ...map } = JSON.parse(readFileSync(join(ROOT, "hub/web-areas.json"), "utf8")) as { pending: string[] } & Record<string, string>;
  const onDisk = readdirSync(join(ROOT, "web/js")).filter((f) => f.endsWith(".js"));
  expect(Object.keys(map).sort()).toEqual([...onDisk, ...pending].sort());
  for (const f of pending) expect(existsSync(join(ROOT, "web/js", f)), f + " is pending but exists").toBe(false);
  for (const [f, a] of Object.entries(map)) expect(AREAS.has(a), f + " has unknown area " + a).toBe(true);
});
