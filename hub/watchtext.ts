// The words the owner reads for a watch event. The watch runner reports in short English reasons ("output changed"); the web,
// the bell and the chat show them as Korean, with the check output as a second line.

// The reason of one notify() call as a Korean phrase. Anything unknown (already Korean, or a new reason) passes through.
export function watchReasonKo(reason: string): string {
	const r = reason.trim();
	if (r === "output changed" || r === "change") return "결과가 바뀌었어요";
	if (r === "match" || r.startsWith("matched /")) return "찾던 내용이 나왔어요";
	if (r === "fail") return "점검에 실패했어요";
	if (r === "recovered") return "다시 정상이에요";
	const fails = /^failed (\d+) times in a row/.exec(r)?.[1];
	if (fails) return `${fails}번 연속 실패했어요`;
	if (r.startsWith("stopped after")) return "실패가 이어져 멈췄어요. 승인하면 다시 돌아요";
	if (r.startsWith("needs the owner")) return "승인이 필요해요";
	return r;
}

// "<감시 이름>: 결과가 바뀌었어요", then the output (when there is one) as the detail line.
export function watchLine(label: string, reason: string, output = ""): string {
	const detail = output.trim();
	return `${label}: ${watchReasonKo(reason)}${detail ? `\n${detail}` : ""}`;
}
