import { expect, test } from "bun:test";
import { OmoProcess } from "./omo.ts";

const frames = (call: (p: OmoProcess) => void): Record<string, unknown>[] => {
	const written: string[] = [];
	const proc = { stdin: { write: (s: string) => written.push(s), flush: () => 0 }, exited: Promise.resolve(0) };
	call(new OmoProcess(proc as unknown as ConstructorParameters<typeof OmoProcess>[0], "o"));
	return written.map(line => JSON.parse(line));
};

test("the owner's stop reaches OmO as an abort that also clears its queue; an abort the hub sends by itself stays plain", () => {
	expect(frames(p => p.abort(true))[0]).toMatchObject({ type: "abort", clearQueue: true });
	const plain = frames(p => p.abort())[0]!;
	expect(plain.type).toBe("abort");
	expect(plain).not.toHaveProperty("clearQueue");
});
