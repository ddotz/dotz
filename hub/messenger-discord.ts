import * as discord from "./discord.ts";
import type { Adapter, AdapterStatus } from "./messenger.ts";

// Discord stays on its own send path (hub/outbound.ts); this adapter only shows it in the messenger list, so the fan-out skips it.
export const discordAdapter: Adapter = {
	id: "discord",
	label: "Discord",
	native: true,
	canEdit: true,
	canButtons: true,
	enabled: () => discord.status.enabled,
	// The bot token, server and owner id are all there.
	configured: () => discord.status.enabled,
	get status(): AdapterStatus {
		const { enabled, connected, error } = discord.status;
		if (!enabled) return { state: "off", ...(error ? { error } : {}) };
		if (connected) return { state: "ok" };
		return error ? { state: "error", error } : { state: "connecting" };
	},
	set status(_: AdapterStatus) {},
	start() {},
	stop() {},
	deliver: msg => discord.send(msg.target, msg.text, msg.replyTo),
	edit: (target, id, text) => discord.edit(target, id, text),
	// Read-only: the bot token, server and switches live on the Discord settings screen.
	settings: () => {
		const { enabled, connected, error, user } = discord.status as { enabled: boolean; connected: boolean; error?: string; user?: string };
		return {
			enabled,
			help: ["Discord 연결은 설정 → Discord에서 바꾸어요. 여기서는 상태만 보여줘요."],
			fields: [
				{ key: "state", label: "상태", type: "readonly", value: !enabled ? "설정 안 됨" : connected ? "연결됨" : error ? "연결 안 됨" : "연결 중" },
				...(user ? [{ key: "user", label: "봇", type: "readonly" as const, value: user }] : []),
				...(error ? [{ key: "error", label: "오류", type: "readonly" as const, value: error }] : []),
			],
			projects: [],
			link: { label: "Discord 설정 열기", view: "discord" },
		};
	},
};
