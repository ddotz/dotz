// Real wiring of the comment routes inside the gateway (hub/routes.ts imports this). The watch itself is a dotz_watch script
// (features/comments/bin/watch.ts), so the gateway holds no timer and a quiet install costs nothing.
import { hostname } from "node:os";
import { cfg, DATA_DIR } from "../config.ts";
import { broadcast } from "../events.ts";
import { resolveName } from "../machine-name.ts";
import { realEngine } from "./real.ts";
import { createCommentsWeb } from "./web.ts";

const engine = realEngine(DATA_DIR, { broadcast, collector: resolveName(cfg.web?.machine_name, hostname()) });
const web = createCommentsWeb({ engine, broadcast });

export const commentsRoute = web.route;
// What waits per integration key ("youtube", "instagram", "site") and per source (`src:<key>`, the one-app-per-website-source entries of
// hub/integrations.ts), and whether a website source exists; read by GET /api/integrations.
export const commentNeeds = () => ({ ...engine.needs(), ...Object.fromEntries(Object.entries(engine.sourceNeeds()).map(([k, v]) => [`src:${k}`, v])) });
export const commentFlags = (): string[] => (Object.values(engine.store.config().sources).some(s => s.kind === "website") && engine.store.config().enabled ? ["comments-site"] : []);
