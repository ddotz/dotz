import { expect, test } from "bun:test";
import { formatBits, qrMatrix, qrPath, reedSolomon, versionBits } from "./qr.ts";

// Published values of the standard and its worked examples, so a slip in the arithmetic cannot agree with itself.
test("Reed-Solomon matches the worked example for HELLO WORLD at 1-M", () => {
	const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
	expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format and version bits match the standard's tables", () => {
	expect(formatBits(0)).toBe(0b101010000010010);
	expect(formatBits(5)).toBe(0b100000011001110);
	expect(versionBits(7)).toBe(0x07c94);
	expect(versionBits(10)).toBe(0x0a4d3);
});

const finderAt = (m: boolean[][], cx: number, cy: number): boolean => {
	for (let y = -3; y <= 3; y++) {
		for (let x = -3; x <= 3; x++) {
			const d = Math.max(Math.abs(x), Math.abs(y));
			if (m[cy + y]![cx + x] !== (d !== 2)) return false;
		}
	}
	return true;
};

test("the size follows the text, the three finders and the timing lines are in place, and too much text has no code", () => {
	for (const [length, size] of [[10, 21], [40, 29], [106, 41], [107, 45], [213, 57]] as const) {
		const m = qrMatrix("x".repeat(length))!;
		expect([length, m.length]).toEqual([length, size]);
		const n = m.length;
		expect([finderAt(m, 3, 3), finderAt(m, n - 4, 3), finderAt(m, 3, n - 4)]).toEqual([true, true, true]);
		for (let i = 8; i < n - 8; i++) expect([i, m[6]![i], m[i]![6]]).toEqual([i, i % 2 === 0, i % 2 === 0]);
		expect(m[n - 8]![8]).toBe(true);
	}
	expect(qrMatrix("x".repeat(214))).toBeUndefined();
});

test("the path draws exactly the dark modules", () => {
	const m = qrMatrix("https://dotz.example.com/pair#code=482913")!;
	const q = qrPath("https://dotz.example.com/pair#code=482913")!;
	const drawn = m.map(row => row.map(() => false));
	for (const [, x, y, w] of q.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) for (let i = 0; i < Number(w); i++) drawn[Number(y)]![Number(x) + i] = true;
	expect([q.size, drawn]).toEqual([m.length, m]);
});
