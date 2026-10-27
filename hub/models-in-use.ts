// 실제로 쓰는 모델 (the top of 모델·폴백, owner 2026-10-27): every place a model runs, with the model it runs on now (a fallback the
// process moved to included) and where that is changed. `modelsInUse` is pure over a snapshot; `liveModelsInUse` reads the hub.
import { appOn, dataDir as installDir, loadSettings } from "../features/reply-drafts/lib/settings.ts";
import { fieldsOf } from "./app-settings.ts";
import { lanesModel, orchestratorModel, parseSelector, selectorOf, workerModel } from "./config.ts";
import { appEntries } from "./integrations.ts";
import { laneWorkerModel, lanes } from "./lanestate.ts";
import { orch } from "./orchestrator.ts";
import { outlangModel } from "./outlang.ts";
import { pickReplyModel, replyDefault } from "./reply-model.ts";
import { LOOKUP_MODEL } from "./runtime/omo.ts";

// Where a row is changed: a card of 모델·폴백 (`models`, the card's data-target), an app's settings screen (`app`), or nowhere in the app (`none`, the reason).
export type Change = { models: string } | { app: string } | { none: string };
export type InUseRow = { key: string; label: string; model: string; sub?: string; configured?: string; fallback?: true; change: Change };
export type InUseSnapshot = {
	orchestrator: { configured: string; active?: string };
	lanesDefault: string;
	workers: string;
	lanes: Array<{ name: string; title?: string; configured: string; active?: string; worker: string; activeWorker?: string }>;
	replyDefault: string;
	replies: Array<{ key: string; label: string; model: string }>;
	outlang: string;
};

// The model a process runs, compared without its effort and with an API-key provider ("anthropic-apikey/...") as its own model.
const runBase = (sel: string) => parseSelector(sel).model.replace(/^([^/]+)-apikey\//, "$1/");
const live = (configured: string, active?: string) => ({ model: active || configured, ...(active && runBase(active) !== runBase(configured) ? { configured, fallback: true as const } : {}) });

export function modelsInUse(s: InUseSnapshot): InUseRow[] {
	const main = live(s.orchestrator.configured, s.orchestrator.active);
	// Lookups run on the subscription's Sonnet; on an API-key entry they follow the orchestrator (hub/runtime/omo.ts writeOrchestratorProfile).
	const keyed = /^[^/]+-apikey\//.test(main.model);
	return [
		{ key: "main", label: "메인 어시스턴트", ...main, change: { models: "orchestrator" } },
		{ key: "background", label: "대화 백그라운드 작업", sub: "대화에서 맡긴 일 · 메인과 같아요", model: main.model, change: { models: "orchestrator" } },
		{ key: "lookups", label: "조회 작업", sub: "빠른 작업 · 탐색 · 자료 찾기", model: keyed ? main.model : LOOKUP_MODEL, change: { none: "조회 작업은 가벼운 모델로 고정돼 있어요" } },
		{ key: "lanes", label: "세션", sub: "새로 시작하는 세션", model: s.lanesDefault, change: { models: "lanes" } },
		...s.lanes.map(l => ({ key: `lane:${l.name}`, label: `세션 · ${l.title || l.name}`, ...live(l.configured, l.active), change: { models: `lane:${l.name}` } })),
		{ key: "workers", label: "세션 서브에이전트", sub: "세션이 맡기는 구현·테스트", model: s.workers, change: { models: "workers" } },
		...s.lanes.filter(l => l.activeWorker && runBase(l.activeWorker) !== runBase(l.worker)).map(l => ({ key: `workers:${l.name}`, label: `세션 서브에이전트 · ${l.title || l.name}`, model: l.activeWorker!, configured: l.worker, fallback: true as const, change: { models: "workers" } })),
		{ key: "replies", label: "답장 기본값", sub: "앱마다 따로 고르지 않은 답장", model: s.replyDefault, change: { models: "replies" } },
		...s.replies.map(r => ({ key: `reply:${r.key}`, label: `${r.label} 답장`, model: r.model, change: { app: r.key } })),
		{ key: "outlang", label: "출력 언어 · 요약", sub: "답을 사용자 언어로 고치고 카드를 요약해요", model: s.outlang, change: { none: "설정 파일의 output_language에서 바꿔요" } },
	];
}

export function liveModelsInUse(): InUseRow[] {
	const s = loadSettings();
	const running = [...lanes.values()].filter(l => l.proc);
	const replies = appEntries(installDir())
		.filter(e => !e.gone && fieldsOf(e.key).some(f => f.key === "reply_model") && (appOn(s, e.app) || Boolean(s.models?.[e.key])))
		.map(e => ({ key: e.key, label: e.label, model: pickReplyModel(s, e.key) }));
	return modelsInUse({
		orchestrator: { configured: selectorOf(orchestratorModel()), active: orch.status === "stopped" ? undefined : orch.activeModel || undefined },
		lanesDefault: selectorOf(lanesModel()),
		workers: workerModel(),
		lanes: running.map(l => ({ name: l.name, title: l.title, configured: l.model, active: l.activeModel, worker: laneWorkerModel(l), activeWorker: l.activeWorkerModel })),
		replyDefault: replyDefault(s),
		replies,
		outlang: outlangModel(),
	});
}
