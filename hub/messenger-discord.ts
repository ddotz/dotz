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
};
