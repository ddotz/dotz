import { isSubagent } from "./guard-config.ts";
import { dropLongTtl } from "./guard.ts";
import type { Host } from "./omp-host.ts";

export function shortCache(pi: Pick<Host, "on">, kind: "main" | "sub" = "main"): void {
	pi.on("before_provider_request", (event, ctx) => {
		const request = event as { payload?: unknown } | undefined;
		const wanted = kind === "main" ? (ctx as { agent?: { kind?: string } } | undefined)?.agent?.kind === "main" : isSubagent(ctx);
		if (!request?.payload || !wanted) return undefined;
		const payload = structuredClone(request.payload);
		return dropLongTtl(payload) ? payload : undefined;
	});
}
