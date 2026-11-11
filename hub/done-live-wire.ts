// Binds hub/done-live.ts to this gateway: its boot commit (selfupdate.ts), its install folder and the lane folders it knows. Call sites use withDoneLive only.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./config.ts";
import { appendDoneLive, gitResolver } from "./done-live.ts";
import { msg } from "./i18n.ts";
import { lanes } from "./lanestate.ts";
import { bootCommit } from "./selfupdate.ts";

const resolve = gitResolver({
	boot: bootCommit,
	installDir: join(import.meta.dir, ".."),
	devDirs: () => [...new Set([...lanes.values()].flatMap(l => [l.worktree?.repo, l.worktree?.path, l.cwd]).filter((d): d is string => !!d && existsSync(d)))],
});

export const withDoneLive = (text: string): string => appendDoneLive(text, resolve, msg().doneNotLive, log);
