// A stand-in for the gateway (hub/remote-desktop.test.ts kills it to see voxl go down with it): it starts a desk whose voxl is fake-voxl.ts and
// prints "READY <voxl pid>". A file of the repo for the same reason as fake-voxl.ts: a script under a crowded os.tmpdir() starts slowly.
import { join } from "node:path";
import { createDesk, defaultDeps } from "../remote-desktop.ts";
const [dir, notify] = process.argv.slice(2);
let voxl = 0;
const desk = createDesk({ ...defaultDeps(), dataDir: dir, platform: "darwin", featureOn: () => true,
	spawn: (argv, env) => { const c = Bun.spawn([process.execPath, join(import.meta.dir, "fake-voxl.ts"), ...argv.slice(1)], { env: { ...env, FAKE_NOTIFY: notify }, stdin: "ignore", stdout: "ignore", stderr: "pipe" }); voxl = c.pid; return c; } });
console.log((await desk.host.ensure()) === "ok" ? "READY " + voxl : "FAILED");
setInterval(() => {}, 1 << 30);
