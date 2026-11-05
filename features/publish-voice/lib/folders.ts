// Listing the readable files of a folder without opening any of them. Symlinks are never followed, dot folders and node_modules are skipped.
// Files whose path below the chosen folder looks sensitive are left out unless the folder was added with --asked; this is the only place that decides it.
import { readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

export const TEXT_EXTENSIONS = [".md", ".txt", ".html", ".htm", ".docx", ".hwp", ".hwpx"] as const;
export const MAX_FILES = 5000;
const MAX_DEPTH = 8;

const SENSITIVE_DIR = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|Library|Keychains|\.config|\.dotz)(?:\/|$)|^\/(?:etc|System)(?:\/|$)/;
const SENSITIVE_NAME = /비밀|기밀|인사|급여|세금|병원|의료|통장|계좌|회사|업무|사내|password|secret|credential/i;

export const sensitiveReason = (path: string): string | undefined =>
	SENSITIVE_DIR.test(path) ? "시스템·인증 정보가 있을 수 있는 위치예요" : SENSITIVE_NAME.test(path) ? "이름에 민감한 말이 들어 있는 위치예요" : undefined;

export type Walk = { files: string[]; links: number; tooMany: boolean; sensitive: number };

export function walkFolder(dir: string, asked: boolean): Walk {
	const walk: Walk = { files: [], links: 0, tooMany: false, sensitive: 0 };
	let seen = 0;
	const visit = (folder: string, depth: number) => {
		for (const e of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (seen > MAX_FILES) return;
			if (e.isSymbolicLink()) walk.links++;
			else if (e.isDirectory() && depth < MAX_DEPTH && !e.name.startsWith(".") && e.name !== "node_modules") visit(join(folder, e.name), depth + 1);
			else if (e.isFile() && TEXT_EXTENSIONS.some(x => x === extname(e.name).toLowerCase())) {
				const file = join(folder, e.name);
				seen++;
				if (!asked && sensitiveReason(relative(dir, file).split(sep).join("/"))) walk.sensitive++;
				else walk.files.push(file);
			}
		}
	};
	visit(dir, 0);
	walk.tooMany = seen > MAX_FILES;
	walk.files.splice(MAX_FILES);
	return walk;
}
