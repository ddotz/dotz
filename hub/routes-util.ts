// Small helpers shared by the HTTP route modules. Split out of main.ts.


export const json = (data: unknown, status = 200) => Response.json(data, { status });
// A browser request from another site (Origin host differs from Host); no Origin header means a non-browser client.
export const sameOrigin = (req: Request): boolean => {
	const origin = req.headers.get("origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.get("host");
	} catch {
		return false;
	}
};
/** A request body that is not JSON: the route answers 400 with this message (hub/routes.ts). */
export class BodyError extends Error {}
// An empty body (or one already read) is no fields; a body that is there but not JSON throws BodyError.
export const body = async (req: Request) => {
	const text = await req.text().catch(() => "");
	if (!text.trim()) return {};
	try {
		return JSON.parse(text) as Record<string, any>;
	} catch {
		throw new BodyError("요청 내용을 읽지 못했어요. JSON 형식으로 보내 주세요");
	}
};
// Terminal sessions attached through POST /api/attach: one instance, read by /api/state and the harness graph.
export const terminals = new Map<string, { cwd?: string; at: string }>();
