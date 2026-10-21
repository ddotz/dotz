# Custom plugins

Per-install code that is not part of the product lives in `<DATA_DIR>/custom/plugins/*.ts` (or `*.js`). The gateway, the agent extension and the Claude deny hook import every such file once when they start (`*.test.ts` and `*.d.ts` next to a plugin are ignored), in file-name order. There is no hot reload: restart the gateway after changing a plugin. Types and loader: `hub/plugins.ts`.

A plugin default-exports an object; every hook is optional:

```ts
import type { Plugin } from "<dotz repo>/hub/plugins.ts"; // type only, erased at runtime

export default {
	name: "example",
	start(ctx) {},                       // hub, once, after the watches are armed
	claim(channelId) {},                 // Discord channel outside the bot's categories
	thread({ thread, text }) {},         // owner message in a thread
	deny(command, dataDir) {},           // shell command about to run
} satisfies Plugin;
```

- `start(ctx)`: `ctx` has `dataDir`, `log`, `postTo(channelId, text)`, `ack(channelId, messageId)`, `ensureWatch(spec)` (a dotz watch; same name and command is kept, another command replaces it) and `approveWatch(name)`.
- `claim(channelId)`: return `{ raw: (m) => void }` to take the owner's messages in that channel yourself, or `{ thread, parent }` to deliver them as a thread named `thread` under channel `parent`; `undefined` leaves the channel alone.
- `thread({ thread, text })`: runs for each owner message in a thread; may do side effects and return `{ note, parentName }`: `note` is appended to the orchestrator's inbox turn for that message, `parentName` replaces the parent's name.
- `deny(command, dataDir)`: return a reason to block the command (agent sessions and Claude), `undefined` to let it pass.

Claim and thread hooks can run before `start`; keep what they need at module level. The extension and the Claude hook run in separate processes and call only `deny`.

A plugin that fails to load, whose `start` throws (it is dropped for the run), or whose hook throws is logged (`plugin <name>: ...`) and skipped; the hub keeps running. With no plugin installed the hooks return at once, and nothing is added to prompts.

A plugin may also serve as a watch check: `ensureWatch({ command: "bun '<plugin file>' check" })` with `if (import.meta.main)` in the file.
