// Real wiring of the comment routes inside the gateway (hub/routes.ts imports this). The watch itself is a dotz_watch script
// (features/comments/bin/watch.ts), so the gateway holds no timer and a quiet install costs nothing.
import { hostname } from "node:os";
import { cfg, DATA_DIR } from "../config.ts";
import { broadcast } from "../events.ts";
import { resolveName } from "../machine-name.ts";
import { triggerFollowup } from "../followup.ts";
import { commentOriginal } from "./original.ts";
import { realEngine } from "./real.ts";
import { createCommentsWeb } from "./web.ts";

// An approved reply that was posted starts the app's 이어서 할 일 check (hub/followup.ts), once per send record.
const engine = realEngine(DATA_DIR, {
	broadcast,
	collector: resolveName(cfg.web?.machine_name, hostname()),
	sent: (app, r) => triggerFollowup({ app, kind: "comment", key: r.id, ids: { comment: r.commentId, source: r.source, thread: r.thread.replace(/\s+/g, "_"), draft: r.draft } }),
});
const web = createCommentsWeb({ engine, broadcast });

export const commentsRoute = web.route;
// The comment a draft of the comment engine answers (hub/draft-attach.ts: GET /api/drafts/<code>/original).
export const commentOriginalOf = (code: string) => commentOriginal(engine.store, code);
// What waits per integration key ("youtube", "instagram", "site") and whether a website source exists; read by GET /api/integrations.
export const commentNeeds = () => engine.needs();
export const commentFlags = (): string[] => (Object.values(engine.store.config().sources).some(s => s.kind === "website") && engine.store.config().enabled ? ["comments-site"] : []);
