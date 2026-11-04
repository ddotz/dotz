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
export const body = async (req: Request) => {
	try {
		return (await req.json()) as Record<string, any>;
	} catch {
		return {};
	}
};
// Terminal sessions attached through POST /api/attach: one instance, read by /api/state and the harness graph.
export const terminals = new Map<string, { cwd?: string; at: string }>();
