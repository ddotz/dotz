const SSH_HOST = /ssh:\/\/([^/\s;,'"`#?\]]+)/g;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/;

const flag = (name: string, value: unknown): string => (typeof value === "string" && value ? `${name} ${value}` : "");
const texts = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

function githubCommand(fields: Record<string, unknown>): string | undefined {
	if (fields.op === "pr_create") {
		const quoted = (name: string, value: unknown) => (typeof value === "string" ? `${name} ${JSON.stringify(value)}` : "");
		return ["gh pr create", flag("--repo", fields.repo), flag("--base", fields.base), flag("--head", fields.head), fields.draft ? "--draft" : "", fields.fill ? "--fill" : "", quoted("--title", fields.title), quoted("--body", fields.body)].filter(Boolean).join(" ");
	}
	if (fields.op === "pr_push") return ["git push", fields.forceWithLease ? "--force-with-lease" : "", fields.branch ? `origin ${String(fields.branch)}` : ""].filter(Boolean).join(" ");
	return undefined;
}

function debugCommand(fields: Record<string, unknown>): string | undefined {
	if (fields.action === "launch") return [...texts(fields.program), ...texts(fields.args)].join(" ") || undefined;
	if (fields.action === "attach" && typeof fields.host === "string" && !LOCAL_HOST.test(fields.host)) return `ssh ${fields.host}`;
	return undefined;
}

/** The shell command line that an omp tool call outside the shell stands for, so the checks that read shell text (the owner's deny rules, the public-post scrub, the worker external-impact block) judge it as they judge the shell: the github tool's `pr_create` and `pr_push`, a `debug` launch or remote attach, and any path of `ssh://<host>/...` (a read, write, edit or search of a remote host). undefined for every other call, and for shell tools. */
export function channelCommand(tool: string, input: unknown): string | undefined {
	const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	if (tool === "github") return githubCommand(fields);
	if (tool === "debug") return debugCommand(fields);
	const named = [...texts(fields.path), ...texts(fields.file_path), ...texts(fields.paths), ...texts(fields.input).flatMap(text => text.split("\n").filter(line => /^(?:\[|\*\*\* |MV )/.test(line)))];
	const hosts = [...named.join("\n").matchAll(SSH_HOST)].map(match => (match[1] ?? "").replace(/^.*@/, "").replace(/:\d+$/, ""));
	return hosts.length ? hosts.map(host => `ssh ${host}`).join("; ") : undefined;
}
