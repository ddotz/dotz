---
name: ketchup
disable-model-invocation: true
description: "Catch the owner up on what changed in this session since their last message, in plain words and small diagrams, and list every decision waiting on them as a card they can answer from the reply alone. Read-only turn. ulw enters it for /skill:ketchup, 'catch me up', or 'where are we'."
---

Catch the owner up on what changed in this session since the last message they wrote before the catch-up request. Help them understand each change, not only where it stands. Then lay out every call waiting on them so they can make it from your reply alone.

Notifications and worker results are not the owner's messages. Assume the owner remembers their last message and nothing after it.

## Voice

Reply in Korean (polite form), plain text in the terminal: no bold, headings, or tables. Bullets and mermaid code blocks are fine.

Talk like one person catching up another. Plain words, short sentences, no jargon. Say what changed for the owner, not how you did it. Say "the tests pass", not "CI is green". Leave out hashes, file paths, commands, build numbers, and test counts unless the owner needs one to act. Call each PR, branch, or worker by a name the owner would know, not a label you invented. If a fact needs context to make sense, give the context or leave the fact out.

## Gather what changed

Keep this turn read-only. Do not change code, start an app or a job, or post anything. Make diagrams only from what you already have.

Sources:

- The session itself: your own work since that message, and every worker result. `history://` lists registered workers and `history://<id>` gives a concise transcript of one. Pick up messages from anyone else in the session.
- The repo: `git log --oneline <since>..`, `git status`, `git diff --stat`, and `git worktree list` for worker patches not yet applied.
- GitHub, read-only: `gh pr view`, `gh pr checks`, `gh run list` for each PR or CI run this session touched. Check the current state, not the state you last saw.

Check each number you will show against the facts it comes from. Say so when you correct one.

A decision is a call or step only the owner can take: a product choice, an approval, an irreversible action, or access you lack. Include any still waiting on the owner, even one raised before their last message. Work you can still do yourself is not a decision. Never make up a call to fill the reply. A step the owner did not ask for and the work does not need is not a decision, unless it is irreversible and waiting on them. Give it one line and no diagram.

One call can cover many items, such as each PR in a set awaiting merge. For each item collect its link, what it changes for users, the evidence behind your pick, its risk, and your pick. Write "unknown" for a fact the call needs that you do not know. Leave out a link you do not have.

## Write the reply

Spend words on the calls, not on the story. Keep what happened under 100 words, not counting diagrams, and shorter when less happened. Leave out work that changed nothing for the owner. Give each decision about 30 words. The reply grows with the number of decisions: two need well under 150 words in all, thirty need far more. Never cut items or shrink them to stay under a word count. A link can add depth, but the reply alone must be enough to decide.

Open with one short sentence that names what waits on the owner, or says nothing does. If nothing happened and nothing waits, say so and stop.

Then show what happened. Diagrams first (screenshots or video files the work produced are named by path, since the terminal cannot show them). Then one short bullet per thing the owner asked for: what came of it, with a status tag at the end of the line.

Status tags, exactly one per bullet:

- [done] finished and checked.
- [running] a worker or job is still going.
- [failed] it failed. Say the cause in the same line.
- [not checked] done but not verified. Say what is missing.
- [waiting on you] a decision card below covers it. Leave the detail to the card.

Write each line the way you would say it out loud: "Search was slow from a missing index [done]", not "Search review: done". Name any bug found and fixed on the way. Each line must stay true when read alone. Never mark something [done] that still waits on the owner.

Under the summary, at most three short lines that change what the owner knows or must do. Then one line naming any work left that you can do yourself.

## Decision cards

List every decision as a card. Each card is a bullet that names the call the owner owns (merge, approve, pick) and gives your pick. A step you would take first goes in your pick. So does anything that must happen first, and anything that cannot be undone. Give the number or link of each PR, issue, or worker the call is about.

- One item: one card with the call, your pick, what it changes for users, the evidence behind your pick, and its risk, with the item named once.
- Items that share a call: write the call and your pick once, then one bullet per item, riskiest first: its link and name, what it changes for users, the evidence, and its risk. Name an item's pick only where it differs from the call's. Give each item's risk even when it is low, such as "Low risk: only the colors change."
- A call between options: give every option the work weighed, each with what it gets the owner and what it costs, and the current state when there is one. Those costs are the call's risk, so add no separate risk line.
- Say what waiting costs only when it is more than a delay, such as a deadline or lost data.
- Merging is the owner's call unless they granted the queue earlier in the session. A timed-out question is not a grant.

## Diagrams

Draw only what is easier to grasp as a picture: how a design or system works, a PR stack or dependency chain with each PR's state, a before and after of a fix, or options side by side. Use mermaid code blocks. Never draw a status list, a list of decisions, or boxes with nothing connecting them. Never give a fact twice, in text or across diagrams.

Keep each diagram small enough to read at a glance: at most six boxes, with at most eight words in each. Label in plain words a person would say, not tags like "Tests: pass". A fact that needs a sentence belongs in the text, or nowhere.

Never invent a number, and never draw a screen you did not capture. If a visible change has no screenshot, mark its line "no screenshot yet" and say what changed on screen. Link only artifacts that exist.

Source: pstack skills/ketchup (MIT, skill://ulw/references/LICENSE-pstack).
