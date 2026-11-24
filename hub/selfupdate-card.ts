import type { AutoUpdateFacts } from "./card-text.ts";
import { cardBlock } from "./choices.ts";
import { msg } from "./i18n.ts";

/** The alert of a refused or failed dotz auto-update (hub/selfupdate.ts autoApply): a lead, then the card `dotz 업데이트 · 원인을 확인할까요?`, posted with the id SELF_UPDATE_CARD_ID.
 *  It lives apart from hub/update.ts so the updater CLI imports no runtime code (hub/install-e2e.test.ts runs it from a release without the extension folder). */
export const autoAlert = (u: AutoUpdateFacts, t = msg().selfUpdate): string =>
	`${t.lead(u.failed)}\n${cardBlock({ subject: t.subject, question: t.question, evidence: t.evidence(u), options: [{ name: t.check, result: t.checkResult }, { name: t.off, result: t.offResult }] })}`;
