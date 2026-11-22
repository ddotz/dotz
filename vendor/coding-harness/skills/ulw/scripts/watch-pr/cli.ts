import { setTimeout as delay } from "node:timers/promises";
import { parseArgs as parseFlags } from "node:util";
import {
  GhGitHubReader,
  WatcherQueryError,
  discoverStack,
  resolveContext,
} from "./github.ts";
import {
  runQueued,
  runSimple,
  statusQueryVerdict,
  verdictFactory,
  type WatchClock,
} from "./policy.ts";
import { renderJson, renderPretty } from "./render.ts";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";

const EX_USAGE = 64;

export const HELP = `Usage: watch-pr [options]

Watch one pull request, a connected stack, or an immutable queued stack.
JSON (NDJSON while polling) is the default; --pretty renders human text.

Options:
  --owner <owner>             GitHub repository owner
  --repo <repo>               GitHub repository name
  --pr <number>               pull request number
  --stack                     watch the connected open stack
  --queued-stack              watch the captured stack until all PRs merge
  --stack-prs <n,...>         frozen bottom-to-top queue (queued mode only)
  --interval <seconds>        poll interval (default: 60)
  --sweep-interval <seconds>  whole-stack sweep interval (default: 300)
  --timeout <seconds>         deadline; 0 disables it (default: 0)
  --max-query-errors <count>  consecutive query-error budget (default: 5)
  --status-only               print one status table and exit 0
  --allow-draft               do not treat a draft as a merge gate
  --pretty                    render human text instead of JSON
  -h, --help                  display help for command
`;

export interface CliOptions {
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
  readonly mode: T.WatchMode;
  readonly stackPrs: readonly T.PrNumber[];
  readonly statusOnly: boolean;
  readonly pretty: boolean;
  readonly polling: T.PollingOptions;
}
export type ParsedArgs =
  | { readonly kind: "run"; readonly options: CliOptions }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string };
class UsageError extends Error {}
function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new UsageError("must be greater than zero");
  return parsed;
}
function nonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new UsageError("must be zero or greater");
  return parsed;
}
function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new UsageError("must be a positive integer");
  return parsed;
}
function prNumber(value: string): T.PrNumber {
  try {
    return parsePrNumber(Number(value.replace(/^#/, "")));
  } catch {
    throw new UsageError("must be a positive integer");
  }
}
function stackPrList(value: string): T.NonEmpty<T.PrNumber> {
  const numbers = value.split(",").map((part) => prNumber(part.trim()));
  if (new Set(numbers).size !== numbers.length)
    throw new UsageError("contains a duplicate PR");
  const parsed = nonEmpty(numbers);
  if (parsed === null) throw new UsageError("cannot be empty");
  return parsed;
}
function optionValue<V>(
  raw: string | undefined,
  flag: string,
  parse: (value: string) => V
): V | undefined {
  if (raw === undefined) return undefined;
  try {
    return parse(raw);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(
      `option '${flag}' argument '${raw}' is invalid. ${error.message}`
    );
  }
}
function usageMessage(error: unknown): string | null {
  if (error instanceof UsageError) return error.message;
  const parseFlagsFailure =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_");
  return parseFlagsFailure ? error.message : null;
}
function readOptions(argv: readonly string[]): CliOptions | "help" {
  const { values } = parseFlags({
    args: [...argv],
    options: {
      owner: { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
      stack: { type: "boolean" },
      "queued-stack": { type: "boolean" },
      "stack-prs": { type: "string" },
      interval: { type: "string" },
      "sweep-interval": { type: "string" },
      timeout: { type: "string" },
      "max-query-errors": { type: "string" },
      "status-only": { type: "boolean" },
      "allow-draft": { type: "boolean" },
      pretty: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  const queued = values["queued-stack"] ?? false;
  if (values.stack && queued)
    throw new UsageError(
      "option '--stack' cannot be used with option '--queued-stack'"
    );
  const stackPrs = optionValue(
    values["stack-prs"],
    "--stack-prs <n,...>",
    stackPrList
  );
  if (stackPrs !== undefined && !queued)
    throw new UsageError("--stack-prs requires --queued-stack");
  return {
    owner: values.owner ?? null,
    repo: values.repo ?? null,
    pr: optionValue(values.pr, "--pr <number>", prNumber) ?? null,
    mode: queued ? "queued-stack" : values.stack ? "stack" : "single",
    stackPrs: stackPrs ?? [],
    statusOnly: values["status-only"] ?? false,
    pretty: values.pretty ?? false,
    polling: {
      interval:
        optionValue(
          values.interval,
          "--interval <seconds>",
          positiveNumber
        ) ?? 60,
      sweepInterval:
        optionValue(
          values["sweep-interval"],
          "--sweep-interval <seconds>",
          positiveNumber
        ) ?? 300,
      timeout:
        optionValue(
          values.timeout,
          "--timeout <seconds>",
          nonNegativeNumber
        ) ?? 0,
      maxQueryErrors:
        optionValue(
          values["max-query-errors"],
          "--max-query-errors <count>",
          positiveInteger
        ) ?? 5,
      allowDraft: values["allow-draft"] ?? false,
    },
  };
}
export function parseArgs(argv: readonly string[]): ParsedArgs {
  try {
    const options = readOptions(argv);
    return options === "help" ? { kind: "help" } : { kind: "run", options };
  } catch (error) {
    const message = usageMessage(error);
    if (message === null) throw error;
    return { kind: "usage-error", message };
  }
}
export interface CliRuntime {
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}
function realRuntime(): CliRuntime {
  return {
    reader: new GhGitHubReader(),
    clock: {
      now: () => performance.now() / 1_000,
      observedAt: () => new Date().toISOString(),
      sleep: async (seconds) => {
        await delay(seconds * 1_000);
      },
    },
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}
export async function main(
  argv: readonly string[],
  runtime: CliRuntime = realRuntime()
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    runtime.stdout(HELP);
    return 0;
  }
  if (parsed.kind === "usage-error") {
    runtime.stderr(`error: ${parsed.message}\n`);
    return EX_USAGE;
  }
  const { options } = parsed;
  const render = options.pretty ? renderPretty : renderJson;
  const emit = (verdict: T.ProgressVerdict): void =>
    runtime.stdout(render(verdict));
  let contexts: T.NonEmpty<T.PrContext>;
  try {
    const seed = await resolveContext({
      reader: runtime.reader,
      owner: options.owner,
      repo: options.repo,
      pr: options.pr ?? options.stackPrs[0] ?? null,
    });
    contexts =
      nonEmpty(options.stackPrs.map((number) => ({ ...seed, number }))) ??
      (options.mode === "single"
        ? [seed]
        : await discoverStack(runtime.reader, seed));
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;
    const verdict = statusQueryVerdict(
      verdictFactory(runtime.clock, options.mode),
      1,
      error.failure
    );
    runtime.stdout(render(verdict));
    return verdict.exitCode;
  }
  const dependencies = { reader: runtime.reader, clock: runtime.clock, emit };
  const verdict =
    options.mode === "queued-stack" && !options.statusOnly
      ? await runQueued({ dependencies, contexts, options: options.polling })
      : await runSimple({
          dependencies,
          contexts,
          mode: options.mode,
          statusOnly: options.statusOnly,
          options: options.polling,
        });
  runtime.stdout(render(verdict));
  return verdict.exitCode;
}
