---
name: ketchup-video
disable-model-invocation: true
description: "Catch the owner up like ketchup, with a short subtitled video of slides for what happened and the waiting decisions as text under it. Needs ffmpeg. ulw enters it for /skill:ketchup-video or 'catch me up with a video'."
---

## Check the tool first

Run `command -v ffmpeg`. If it prints nothing, tell the owner in one line that video rendering is "not available here" and give the install command, `brew install ffmpeg`. Stop there. Do not fall back to a text catch-up unless the owner asks for one, and do not install anything yourself.

If it prints a path, continue.

## What this is

Follow `skill://ketchup`, but show what happened in a short subtitled video instead of its diagrams and summary. The window starts at the last message the owner wrote before this request, not before any earlier catch-up. Writing and rendering the video, outside the repo (for example under `/tmp/ketchup-video/`), is the one exception to ketchup's read-only rule.

The reply, in Korean plain text as ketchup defines it, is: ketchup's opening sentence, the path of the video file (the terminal cannot play it inline), one line naming any work left that you can do yourself, and the decision cards. When the video shows a call's options, call each option by the name the video gives it. If the render fails, say so in one line and give only the decision cards.

## Slides

Use the screenshots, recordings, diffs, and data the work produced, not the session's prose about them. Before you draw, write the one sentence the owner should leave with and one line per slide. Drop each slide that does not change what the owner knows. Use at most 10 slides, and fewer is better. Neither note goes in the reply.

Each slide makes one point. Build the slides on one picture and change it from slide to slide, rather than cut to an unrelated one. A color or shape means the same thing on every slide. Show the work in pictures: how a system works, a PR stack with each PR's state, a before and after of a fix, options side by side. Point at what changed with arrows, highlights, and motion. A slide is never a bullet list, a status list, a table, or boxes with nothing connecting them.

Keep text to the minimum. Put each label on the thing it names, in plain words a person would say, not tags like "Tests: pass". Never caption what a picture shows, and never give a fact twice, across slides or in the text under them.

Show what came of each thing the owner asked for, and whether it is done, still running, failed, or not checked. Never show something done that still waits on the owner. Show any bug found and fixed on the way. If a visible change has no screenshot, say so on its slide and name what changed on screen. Draw only from facts you have. Never invent a number, and never draw a screen you did not capture.

## Subtitles

Give each slide one short subtitle line, about ten words, that says its point the way you would tell the owner, from only what that slide shows. Say what the picture means rather than read out its labels. Put the subtitle in a strip below the slide, the same height on every slide and empty except for the subtitle, so it never covers the slide. Set it small, but readable when the video plays at chat size. Write the subtitles in Korean, matching the reply.

## Render

Render one silent landscape video, such as an mp4, with motion between slides. Every frame is the slide itself, edge to edge, above its subtitle strip. Make the frames from the slides, never by recording a screen: draw them with a script (an image library, or HTML rendered to PNG) and assemble them with ffmpeg. Burn each subtitle into its slide's frames so it stays on screen for the slide's whole hold. The hold is the time a slide is fully on screen, not counting the motion into or out of it. Hold each slide long enough to read the words it adds, at least one second for each three words. A slide adds its subtitle and each word that was not on the slide before it, including a label it changes. The first slide adds all its words. Words inside a screenshot do not count.

## Check the file

Before you report the video, check the rendered file.

- Extract one frame from each slide with `ffmpeg -ss <t> -i out.mp4 -frames:v 1 frame.png` and read it at chat size. Check that its subtitle is readable and covers nothing.
- Measure each hold by matching the file's frames to the slide, for example by hashing frames with `ffmpeg -i out.mp4 -f framemd5 -`. Do not use a still-frame detector: it counts the faint ends of a fade as still.
- Count the words each slide adds against its measured hold. Fix any slide you cannot read in that time, render again, and check again.

Source: pstack skills/ketchup-video (MIT, skill://ulw/references/LICENSE-pstack).
