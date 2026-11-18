---
name: statechart
disable-model-invocation: true
description: "Model a state-heavy flow (checkout, login with token refresh, offline sync, multi-step form, retry protocol) in TLA+, check it with TLC, and draw it as a Mermaid statechart with the shortest path to every state that breaks a rule. Entered from ulw before building a state-heavy flow, or when a bug looks like a bad path through states."
---

The chart is for the person who decides whether the behavior is right. It checks the model, not the app: every bug path found must be replayed against the real code.

Tool: vendored from pstack (MIT, `scripts/LICENSE-pstack`) with its test suite. Zero runtime npm dependencies; runs under bun. Tests: `bun run test:statechart` in `agent/harness`. The suite needs Node 23.6 or later (it checks Node behavior that `bun test` lacks); cases that run TLC skip unless `TLA2TOOLS` names tla2tools.jar and run for several minutes.

## Run

Work in a scratch folder outside the repo (`/tmp/sc-<slug>/`). Write `SPEC.tla`, `SPEC.cfg`, and a view module, then:

    TLA2TOOLS=~/.cache/statechart/tla2tools.jar JAVA=/opt/homebrew/bin/java \
      bun skill://statechart/scripts/statechart.ts SPEC.tla --config SPEC.cfg --view view.ts --out out-1

- `--out` must be a new folder each run. Exit 0 = every rule holds, 1 = a rule breaks (both write `chart.mmd` + report), 2 = error.
- Jar missing: download tla2tools.jar v1.7.4 from the tlaplus GitHub releases and check sha256 starts `936a262061c91469` before use.

## Spec

- Every rule the reader agrees to is an INVARIANT (a screen, a stored value, a message). Add a variable when the rule needs one. Never weaken a rule to make it hold.
- `Next` is a disjunction of named actions (`UserPays \/ PaymentFails \/ ...`), so arrows get real names.
- Correct end states need an explicit no-op action (`Done == phase \in {"paid","failed"} /\ UNCHANGED vars`), or TLC reports a deadlock.
- Keep constants small or add a CONSTRAINT: TLC continues past violations, so an unbounded model never ends.

## View module

- `export const state = (v) => ...`: string = flat chart, array = nested parents, object = parallel regions. Labels in the reader's words ("Paying", "Lease held, write pending"), never variable names.
- Optional `step(action, from, to)` returns the arrow label as the user sees it ("you press pay", "the charge times out"); a condition goes in brackets at the end, in the reader's words ("you press play [while the file loads]"). In a regions chart the command already writes the condition on the other regions on the arrow (`[when Offline]`), and your brackets replace it, so two arrows from one state can look the same: never write brackets for a condition on another region. When a value that no label shows decides where a step goes, name the result in the label ("the roster read fails"). Return `null` to hide a step only when every step of that arrow is hidden and every state stays reachable; list hidden steps in the hand-off.
- Optional `group(vars)`, `colors`, `title`. All functions must be pure.
- Aim for about 20 arrows: merge labels that act the same before hiding steps; never merge two states that break different rules.

## Read and hand off

- `breaks` = the state breaks a rule; `mayBreak` = some model states behind it do. Rules listed under "Rules not checked" are unknown, not passing.
- Above 500 states (counted by TLC on the config as written) only bug paths are drawn, and with no bug no `chart.mmd` is written; the report still gives the state count and each bug path.
- With a VIEW or SYMMETRY, TLC counts states it treats as the same as one, and the chart draws that one state: an arrow can lead to it rather than to the state the step reaches, and the report says so.
- TLC checks the rules in each state past a CONSTRAINT or ACTION_CONSTRAINT but does not explore it or check it for deadlock. When TLC's shortest path for a rule ends there, the chart draws that state (or step) and the report gives the path; the other states past the bound are not drawn, and a deadlock in them does not show.
- The command runs TLC on the config as written with one worker, then removes each rule that breaks and runs again until none breaks. After the first break each run stops at 100,000 distinct states. A rule that a bounded or failed run did not check is listed under "Rules not checked" and is not marked on the chart; it can hold or break. To check it, remove the broken rules from the config or make the model smaller. The bound adds a module that reorders TLC's variables, so a property can get a different counterexample.
- `tlc.out` is what TLC printed on the config as written. When the chart does not show a broken rule's bug path, `tlc-RULE.out` is what TLC printed for the run that found it.
- Show `chart.mmd` as a mermaid block. Render charts with Pele: when the user asks for an image, or a chart is too large to read as text, follow `references/render.md` (Pele is fetched on demand with `bunx`; use no other renderer unless asked).
- One line per bug: the rule, the reader's sentence for that rule, and the numbered path. Say what the model leaves out, and which steps the chart hides. Give the command that makes the files again, with a new `--out` folder.
- Replay each bug path against the real code (a test or a verify-skill drive, one step per action). A path that does not reproduce means the model is wrong until shown otherwise.
