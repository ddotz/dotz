import { parsePrNumber } from "./types.ts";
import type {
  CiClean,
  GitHubMergeAllowed,
  PrContext,
  ReadyPr,
  TerminalVerdict,
} from "./types.ts";

type ReadyVerdict = Extract<TerminalVerdict, { readonly kind: "READY" }>;
type Rejects<Target, Value> = [Value] extends [Target] ? false : true;
type Proof<Holds extends true> = Holds;

const context = {
  owner: "octocat",
  repo: "hello-world",
  number: parsePrNumber(123),
} satisfies PrContext;
const cleanCi = {
  kind: "ci-clean",
  source: "gh-pr-checks",
  all: [
    {
      kind: "passed",
      name: "ci",
      reportedState: "SUCCESS",
      description: "",
      link: "",
      workflow: "",
    },
  ],
  failed: [],
  pending: [],
  hadPreviousPassingCi: false,
  github: {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: "CLEAN",
    headRollupState: "SUCCESS",
  },
} satisfies CiClean;
const readyPr = {
  kind: "ready-pr",
  context,
  proof: {
    mergeability: "clear",
    threads: [],
    ci: cleanCi,
    gate: {
      state: "OPEN",
      reviewDecision: "APPROVED",
      draft: "not-draft",
    },
  },
} satisfies ReadyPr;
const ready = {
  schemaVersion: 1,
  sequence: 1,
  observedAt: "2026-07-26T00:00:00.000Z",
  mode: "single",
  kind: "READY",
  terminal: true,
  exitCode: 0,
  scope: { kind: "single", pr: readyPr },
} satisfies ReadyVerdict;

const refused = {
  kind: "allowed",
  basis: "rollup",
  mergeStateStatus: "BLOCKED",
  headRollupState: "FAILURE",
} as const;
const cleanWithRefusal = { ...cleanCi, github: refused };
const readyWithBlockerExit = { ...ready, exitCode: 4 } as const;
const unprovenPr = { kind: "ready-pr", context } as const;

export type CompileProofs = [
  Proof<Rejects<GitHubMergeAllowed, typeof refused>>,
  Proof<Rejects<CiClean, typeof cleanWithRefusal>>,
  Proof<Rejects<ReadyVerdict, typeof readyWithBlockerExit>>,
  Proof<Rejects<ReadyPr, typeof unprovenPr>>,
];
