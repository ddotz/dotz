// The files /api/file may serve from the data dir: the ones the gateway itself put in a message, a project's list or on a result chip.
import { sentFiles } from "./events.ts";
import { fileRoute } from "./files.ts";
import { noticeFilePaths } from "./notices-store.ts";
import { projectFiles } from "./projectinfo.ts";

type Rows = () => { files?: { path: string }[] }[];

// The cheap sets first; building the work rows is costly, so only an answer of 403 builds them and asks once more.
export async function listedFileRoute(req: Request, url: URL, roots: string[], work: Rows): Promise<Response> {
	const cheap = new Set([...sentFiles(), ...projectFiles(), ...noticeFilePaths()]);
	const first = await fileRoute(req, url, roots, cheap);
	if (first.status !== 403) return first;
	for (const w of work()) for (const f of w.files ?? []) cheap.add(f.path);
	return fileRoute(req, url, roots, cheap);
}
