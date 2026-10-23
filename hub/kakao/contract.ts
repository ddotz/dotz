// Cross-machine contract of the KakaoTalk integration. The owner logs in on two Macs alternately; each gateway collects what its own
// KakaoTalk shows, and a later merge joins both views. Three rules make that safe:
// 1. Identity: messageId() is the same on every machine (KakaoTalk's chatId and logId come from the Kakao server), and every
//    message and send record names the machine that collected it (`collector`).
// 2. Union: mergeMessages() joins lists by id, idempotently (the same id twice is one message, the first collector is kept);
//    addOnce() records a send once per send id.
// 3. One door out: dispatchSend() is the only function a KakaoTalk send goes through, typed reply and confirmed draft alike.
//    Its optional `lease` hook says whether THIS machine may send into that chat right now (e.g. the other Mac holds it); a
//    refused lease is a failed send with that reason and kmsg is never run.
import { createHash } from "node:crypto";
import { sentAtMs } from "./db.ts";
import { type Draft, listDrafts, sendDraft, type SendDeps, type SendResult, sendText } from "./send.ts";

export type MessageKey = { chatId: string; logId?: string; authorId: string; sentAt: number; text: string };

export function messageId(m: MessageKey): string {
	if (m.logId) return `k:${m.chatId}:${m.logId}`;
	const digest = createHash("sha256").update(`${m.authorId}|${sentAtMs(m.sentAt)}|${m.text}`).digest("hex").slice(0, 16);
	return `h:${m.chatId}:${digest}`;
}

const logOrder = (a?: string, b?: string) => {
	if (a && b && /^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
	return (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
};

export function mergeMessages<T extends { id: string; sentAt: number; logId?: string }>(...lists: T[][]): T[] {
	const seen = new Map<string, T>();
	for (const list of lists) for (const m of list) if (!seen.has(m.id)) seen.set(m.id, m);
	return [...seen.values()].sort((a, b) => sentAtMs(a.sentAt) - sentAtMs(b.sentAt) || logOrder(a.logId, b.logId));
}

export const addOnce = <T extends { id: string }>(list: T[], item: T): T[] => (list.some(x => x.id === item.id) ? list : [...list, item]);

export type Lease = (chatId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
export type SendRequest = { kind: "text"; chatId: string; roomName: string; text: string } | { kind: "draft"; code: string; text?: string; ownerApproved?: boolean };
export type DispatchDeps = SendDeps & {
	roomNames?: () => Promise<{ chatId: string; name: string }[]>;
	latestIncoming?: (chatId: string) => Promise<string | undefined>;
	lease?: Lease;
};

export async function dispatchSend(req: SendRequest, deps: DispatchDeps): Promise<SendResult> {
	const refuse = (reason: string): SendResult => ({ ok: false, reason });
	let chatId: string;
	if (req.kind === "text") chatId = req.chatId;
	else {
		const draft: Draft | undefined = (await listDrafts(deps)).find(d => d.code === req.code);
		if (!draft) return refuse("그 초안을 찾지 못했어요");
		chatId = draft.chatId;
	}
	if (deps.lease) {
		let verdict: Awaited<ReturnType<Lease>>;
		try {
			verdict = await deps.lease(chatId);
		} catch {
			return refuse("이 컴퓨터가 지금 보내도 되는지 확인하지 못해서 보내지 않았어요");
		}
		if (!verdict.ok) return refuse(verdict.reason);
	}
	if (req.kind === "text") return sendText({ chatId, roomName: req.roomName, text: req.text }, deps);
	if (!deps.latestIncoming) return refuse("새 메시지가 왔는지 확인하지 못해서 보내지 않았어요");
	return sendDraft(req.code, { ...deps, latestIncoming: deps.latestIncoming, ownerApproved: req.ownerApproved, ...(req.text !== undefined ? { text: req.text } : {}) });
}
