/** What an answer to a card hands the model and what the owner reads when an answer closes a card with no turn (hub/card-answer.ts), in English. */
export const answerEn = {
	answerCard: (title: string, evidence: string[], picked: string, result: string): string[] => [`(this answers your card "${title}"${evidence.length ? "; its own lines:" : ")"}`, ...evidence.map(l => `  ${l}`), ...(evidence.length ? [")"] : []), `Picked: ${picked}${result ? ` (what it said it does: ${result})` : ""}`],
	answerEdit: (e: { file: string; line: number; from: string; to: string; reach: string }): string[] => [
		"[gateway] The exact edit this card proposes, as the doctor recorded it:",
		`File: ${e.file} (${e.reach})`,
		`Line: ${e.line}`,
		...(e.to ? [`Before: ${e.from}`, `After: ${e.to}`] : [`Line to delete: ${e.from}`]),
	],
	answerEditGone: "[gateway] The doctor's record no longer holds the exact edit of this card; the card's own lines above are all there is. Find the line they name yourself.",
	answerConfirmFirst: (apply: string, leave: string) =>
		`[gateway] Change nothing yet: no file, no commit, no push. First post one confirm card as a \`결정:\` block: for every file you will touch, its path and the whole line before and after (or the whole line to delete), each quoted exactly as it is in the file, and how far the change reaches (this computer only, or committed and pushed to the repo). Give it exactly two options, \`**1) ${apply}**\` and \`**2) ${leave}**\`, each with what it does. Edit only after a [gateway] line tells you the owner picked ${apply} on your confirm card; an answer without that line is not his confirmation.`,
	answerConfirmed: "[gateway] The owner picked Apply on your confirm card. Make exactly the edits that card showed and nothing else: no other file, no other line, and commit or push only if the card said so. Then report each file with its line before and after.",
	answerStaleTurn: (stale: string) => `[gateway] The owner picked Apply on your confirm card, and the gateway answered it with "${stale}". Make no edit. Tell the owner the line changed and, if he still wants the change, post a new confirm card with the line as it reads now.`,
	answerChecked: (file: string, line: number) => `[gateway] Checked just now: line ${line} of ${file} still reads as the card showed.`,
	answerApply: "Apply",
	answerLeave: "Leave",
	answerReachData: "this install's own file in its data folder: the change stays on this computer",
	answerReachPackage: "the package's file in this install: an edit here stays on this computer and the next update can replace it; to reach every install it has to be committed and pushed to the repo",
	answerReachOther: "a file outside this install's data folder and package",
	answerKept: "nothing was changed",
	answerStale: (file: string, line: number) => `not edited: line ${line} of ${file} no longer reads as the card showed`,
};

/** The same texts in Korean. */
export const answerKo: typeof answerEn = {
	answerCard: (title, evidence, picked, result) => [`(당신이 올린 카드 "${title}"에 대한 답이에요${evidence.length ? ". 카드의 줄:" : ")"}`, ...evidence.map(l => `  ${l}`), ...(evidence.length ? [")"] : []), `고른 것: ${picked}${result ? ` (카드가 말한 결과: ${result})` : ""}`],
	answerEdit: e => ["[게이트웨이] 이 카드가 제안한 수정이에요. 닥터 기록 그대로예요:", `파일: ${e.file} (${e.reach})`, `줄: ${e.line}`, ...(e.to ? [`전: ${e.from}`, `후: ${e.to}`] : [`지울 줄: ${e.from}`])],
	answerEditGone: "[게이트웨이] 닥터 기록에 이 카드의 정확한 수정이 더는 없어요. 위의 카드 줄이 전부예요. 그 줄이 가리키는 곳은 직접 찾으세요.",
	answerConfirmFirst: (apply, leave) =>
		`[게이트웨이] 아직 아무것도 바꾸지 마세요. 파일도, 커밋도, 푸시도 안 돼요. 먼저 \`결정:\` 블록으로 확인 카드 하나를 올리세요: 손댈 파일마다 경로와 그 줄의 전·후 전체(지우는 줄이면 지울 줄 전체)를 파일에 있는 그대로 옮겨 적고, 어디까지 반영되는지(이 컴퓨터만, 또는 커밋해서 저장소에 푸시)도 적으세요. 선택지는 두 개만, 각각 결과 한 줄과 함께요: \`**1) ${apply}**\`, \`**2) ${leave}**\`. 오너가 확인 카드에서 ${apply}을 골랐다는 [게이트웨이] 줄이 온 뒤에만 고치세요. 그 줄이 없는 답은 오너의 확인이 아니에요.`,
	answerConfirmed: "[게이트웨이] 오너가 확인 카드에서 적용을 골랐어요. 그 카드가 보여 준 수정만 그대로 하고 다른 것은 바꾸지 마세요. 다른 파일, 다른 줄은 안 되고, 커밋이나 푸시는 카드가 그렇게 말했을 때만 해요. 끝나면 파일마다 그 줄의 전·후를 알려 주세요.",
	answerStaleTurn: stale => `[게이트웨이] 오너가 확인 카드에서 적용을 골랐고, 게이트웨이가 "${stale}"라고 답했어요. 아무것도 고치지 마세요. 오너에게 그 줄이 바뀌었다고 알리고, 그래도 바꾸길 원하면 지금 줄로 확인 카드를 새로 올리세요.`,
	answerChecked: (file, line) => `[게이트웨이] 방금 확인했어요: ${file} ${line}번째 줄은 카드에 보인 그대로예요.`,
	answerApply: "적용",
	answerLeave: "그대로 둬요",
	answerReachData: "이 설치의 데이터 폴더에 있는 자기 파일이에요. 바꾼 것은 이 컴퓨터에만 남아요",
	answerReachPackage: "이 설치에 들어 있는 패키지 파일이에요. 여기서 고치면 이 컴퓨터에만 남고 다음 업데이트가 덮어쓸 수 있어요. 모든 설치에 반영하려면 커밋해서 저장소에 푸시해야 해요",
	answerReachOther: "이 설치의 데이터 폴더와 패키지 밖의 파일이에요",
	answerKept: "아무것도 바꾸지 않았어요",
	answerStale: (file, line) => `고치지 않았어요: ${file} ${line}번째 줄이 카드에 보인 글과 달라졌어요`,
};
