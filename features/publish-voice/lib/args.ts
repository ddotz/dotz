export type Args = { pos: string[]; flags: Map<string, string> };

const SWITCHES = new Set(["--asked", "--json", "--help", "-h"]);

export function parseArgs(argv: readonly string[]): Args {
	const args: Args = { pos: [], flags: new Map() };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (SWITCHES.has(a)) args.flags.set(a, "true");
		else if (a.startsWith("--")) args.flags.set(a, argv[++i] ?? "");
		else args.pos.push(a);
	}
	return args;
}
