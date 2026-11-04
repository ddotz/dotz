// A QR code for a short text (ISO/IEC 18004, byte mode, error correction level M, versions 1-10: up to 213 bytes), drawn by the web app as an SVG path.
// The project keeps no runtime dependencies, and this is all the app needs of QR: the device pairing screen (hub/devices.ts).

// Level M per version: EC codewords per block, then [blocks, data codewords per block] of the two block groups.
const BLOCKS: [number, [number, number], [number, number]?][] = [
	[10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
	[16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
];
// The second alignment coordinate per version (0 = none); version 7 up also has one in between, on the middle of the two.
const ALIGN = [0, 18, 22, 26, 30, 34, 38, 42, 46, 50];

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
	EXP[i] = EXP[i + 255] = x;
	LOG[x] = i;
	x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

/** The Reed-Solomon error correction codewords of a data block. */
export function reedSolomon(data: number[], ecLen: number): number[] {
	let gen = [1];
	for (let i = 0; i < ecLen; i++) {
		const next = new Array<number>(gen.length + 1).fill(0);
		gen.forEach((c, j) => {
			next[j] = next[j]! ^ c;
			next[j + 1] = next[j + 1]! ^ mul(c, EXP[i]!);
		});
		gen = next;
	}
	const ec = new Array<number>(ecLen).fill(0);
	for (const d of data) {
		const factor = d ^ ec.shift()!;
		ec.push(0);
		for (let i = 0; i < ecLen; i++) ec[i] = ec[i]! ^ mul(gen[i + 1]!, factor);
	}
	return ec;
}

const bch = (data: number, bits: number, poly: number): number => {
	let rem = data;
	for (let i = 0; i < bits; i++) rem = (rem << 1) ^ ((rem >>> (bits - 1)) * poly);
	return (data << bits) | rem;
};
/** The 15 format bits of level M with this mask. */
export const formatBits = (mask: number): number => bch(mask, 10, 0x537) ^ 0x5412;
/** The 18 version bits, drawn from version 7 up. */
export const versionBits = (version: number): number => bch(version, 12, 0x1f25);

function codewords(bytes: Uint8Array, version: number): number[] | undefined {
	const [ecLen, one, two] = BLOCKS[version - 1]!;
	const capacity = one[0] * one[1] + (two ? two[0] * two[1] : 0);
	const countBits = version < 10 ? 8 : 16;
	if (4 + countBits + bytes.length * 8 > capacity * 8) return undefined;
	const bits: number[] = [];
	const put = (value: number, n: number): void => {
		for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	put(4, 4);
	put(bytes.length, countBits);
	for (const b of bytes) put(b, 8);
	put(0, Math.min(4, capacity * 8 - bits.length));
	put(0, -bits.length & 7);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
	while (data.length < capacity) data.push(data.length % 2 === bits.length / 8 % 2 ? 0xec : 0x11);

	const blocks: number[][] = [];
	let at = 0;
	for (const [count, len] of two ? [one, two] : [one]) for (let i = 0; i < count; i++) blocks.push(data.slice(at, (at += len)));
	const ecs = blocks.map(b => reedSolomon(b, ecLen));
	const out: number[] = [];
	for (let i = 0; i < blocks.at(-1)!.length; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
	for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]!);
	return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
	(x, y) => (x + y) % 2 === 0,
	(_, y) => y % 2 === 0,
	x => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** How badly a finished symbol scans (the standard's four penalty rules); the lowest of the eight masks wins. */
function penalty(m: boolean[][]): number {
	const n = m.length;
	let score = 0;
	const line = (at: (i: number) => boolean): void => {
		let run = 0;
		let bits = 0;
		for (let i = 0; i < n; i++) {
			run = i > 0 && at(i) === at(i - 1) ? run + 1 : 1;
			if (run === 5) score += 3;
			else if (run > 5) score += 1;
			bits = ((bits << 1) | (at(i) ? 1 : 0)) & 0x7ff;
			if (i >= 10 && (bits === 0b10111010000 || bits === 0b00001011101)) score += 40;
		}
	};
	let dark = 0;
	for (let i = 0; i < n; i++) {
		line(x => m[i]![x]!);
		line(y => m[y]![i]!);
		for (let x = 0; x < n; x++) {
			if (m[i]![x]) dark++;
			if (i < n - 1 && x < n - 1 && m[i]![x] === m[i]![x + 1] && m[i]![x] === m[i + 1]![x] && m[i]![x] === m[i + 1]![x + 1]) score += 3;
		}
	}
	return score + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
}

/** The symbol as rows of modules (true = dark), or undefined when the text does not fit version 10. */
export function qrMatrix(text: string): boolean[][] | undefined {
	const bytes = new TextEncoder().encode(text);
	let version = 1;
	let words: number[] | undefined;
	for (; version <= BLOCKS.length && !(words = codewords(bytes, version)); version++);
	if (!words) return undefined;

	const size = 17 + version * 4;
	const base = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const set = (x: number, y: number, dark: boolean): void => {
		if (x < 0 || y < 0 || x >= size || y >= size) return;
		base[y]![x] = dark;
		fixed[y]![x] = true;
	};
	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	const square = (cx: number, cy: number, reach: number, dark: (d: number) => boolean): void => {
		for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) set(cx + x, cy + y, dark(Math.max(Math.abs(x), Math.abs(y))));
	};
	const finder = (d: number): boolean => d !== 2 && d !== 4;
	square(3, 3, 4, finder);
	square(size - 4, 3, 4, finder);
	square(3, size - 4, 4, finder);
	const last = ALIGN[version - 1]!;
	const centers = last === 0 ? [] : version < 7 ? [6, last] : [6, (6 + last) / 2, last];
	for (const cy of centers) for (const cx of centers) if (!((cx === 6 && (cy === 6 || cy === last)) || (cy === 6 && cx === last))) square(cx, cy, 2, d => d !== 1);

	const drawFormat = (m: boolean[][], mask: number): void => {
		const f = formatBits(mask);
		const bit = (i: number): boolean => ((f >>> i) & 1) === 1;
		const at = (x: number, y: number, dark: boolean): void => {
			m[y]![x] = dark;
			fixed[y]![x] = true;
		};
		for (let i = 0; i <= 5; i++) at(8, i, bit(i));
		at(8, 7, bit(6));
		at(8, 8, bit(7));
		at(7, 8, bit(8));
		for (let i = 9; i < 15; i++) at(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) at(size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) at(8, size - 15 + i, bit(i));
		at(8, size - 8, true);
	};
	drawFormat(base, 0); // reserves those modules before the data goes in
	if (version >= 7) {
		const v = versionBits(version);
		for (let i = 0; i < 18; i++) {
			const dark = ((v >>> i) & 1) === 1;
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			set(a, b, dark);
			set(b, a, dark);
		}
	}

	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let step = 0; step < size; step++) {
			const y = (right + 1) & 2 ? step : size - 1 - step;
			for (const x of [right, right - 1]) {
				if (fixed[y]![x]) continue;
				base[y]![x] = i < words.length * 8 && ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
				i++;
			}
		}
	}

	let best: boolean[][] | undefined;
	let lowest = Infinity;
	MASKS.forEach((flip, mask) => {
		const m = base.map((row, y) => row.map((dark, x) => (fixed[y]![x] ? dark : dark !== flip(x, y))));
		drawFormat(m, mask);
		const score = penalty(m);
		if (score < lowest) {
			lowest = score;
			best = m;
		}
	});
	return best;
}

/** The dark modules as one SVG path, one module = one unit; the caller draws it with a quiet zone of 4 on a light background. */
export function qrPath(text: string): { size: number; path: string } | undefined {
	const m = qrMatrix(text);
	if (!m) return undefined;
	let path = "";
	m.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			if (!row[x]) continue;
			const from = x;
			while (row[x + 1]) x++;
			path += `M${from} ${y}h${x - from + 1}v1h-${x - from + 1}z`;
		}
	});
	return { size: m.length, path };
}
