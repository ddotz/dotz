Settle an observable design fork by building throwaway variants and looking at them; the work routine is `skill://prototype`, this playbook adds the pstack steps around it.

The prototype is an instrument, not the build. Speed over polish, no planning, and code quality does not matter; the rigor is in picking the right design cheaply. Propose variants the owner did not ask for, throw an approach away and try another.

1. Scope the decision the prototype exists to make (layout, interaction, density, or for an empirical fork a behavior, timing, or approach). No decision means no prototype: route to `playbooks/feature.md`.
2. Moodboard when the design space is open: search for prior art, summarize themes, palettes, and layouts, and let the owner pick directions before building. Skip with `skip: direction is set` when it is.
3. Run `skill://prototype`: build throwaway in a scratch folder outside the repo, the lightest stack that shows the difference, no tests or abstractions.
4. Compare alternatives behind one labeled switcher with the same content in each (`skill://principle-exhaust-the-design-space` made cheap).
5. Observe on the matching surface: screenshot each variant and drive the interaction (`skill://verify`, `skill://visual-diff` for pixel comparison); for a behavioral or timing decision, print the timings or outputs. The observation is the test.
6. Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, never shippable code. The decision hands to `playbooks/feature.md` (or `skill://architect` for the shape) for the real build, which starts from the decision and copies no prototype code.

When the owner's taste decides rather than an observable fact, show the screenshots and ask one question with the variants as options.

Reply: the variants explored, the evidence per variant (screenshot path or observed numbers), tradeoffs, your recommendation, and the scratch path, in Korean plain text. Say plainly that the prototype is throwaway.

Source: pstack skills/poteto-mode/playbooks/prototype.md (MIT, skill://ulw/references/LICENSE-pstack).
