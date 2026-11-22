Answer a read-only question with a cited explanation or a recommendation; no code changes.

1. List the evidence sources the answer needs: code (lsp, ast-grep), history (`git log -S`, blame, PR text), runtime output. For a motivation question ("why is it like this"), start from history and route through `skill://why` before reading the code.
2. Read the sources and trace the code the question is about; run what can be run instead of inferring it. Fan out to `scout` workers only for independent sub-questions.
3. Write the output as plain paragraphs in this order: overview, key concepts, how it works, where things live, gotchas, with no headings in the terminal. For a decision between alternatives, give a recommendation instead. A tradeoffs table appears only in an artifact (doc, PR body, plan file), never in the terminal reply.
4. Every claim carries its source (`file:line`, commit, run output) or a High/Medium/Low label. Apply `skill://unslop` to the reply.
5. Throughput checkpoint is one line: `throughput checkpoint: n/a, read-only investigation`. No edits, no PR, no `skill://architect` unless the investigation precedes a code change.
6. When the answer leads to a code change, stop and hand back to the owner; re-route to the Bug fix or Feature playbook instead of starting the change here.

Reply: the investigation output in Korean, plain text, no bold, headings, or tables. For "are we sure?" questions, give your real judgment with reasons and push back when the premise is wrong.

Source: pstack skills/poteto-mode/playbooks/investigation.md (MIT, skill://ulw/references/LICENSE-pstack).
