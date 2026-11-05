// A multipart body read as it arrives, for POST /api/upload: req.formData() keeps the whole body in memory, then each file again, until the last
// byte is in. Here the memory is one network read plus the length of the boundary, and a body that stops early surfaces as an error at once.
export type PartHead = { field: string; filename?: string; type: string };
export type PartSink = { write(bytes: Uint8Array): Promise<void>; end(): Promise<void> };

const HEAD_MAX = 16 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");
const DASH = 45;

// Browsers write `"` in a file name as %22 and line breaks as %0D / %0A; other senders escape the quote with a backslash.
const fileName = (raw: string) => raw.replace(/\\"/g, '"').replace(/%22/g, '"').replace(/%0D/gi, "\r").replace(/%0A/gi, "\n");

function parseHead(text: string): PartHead {
	const disp = /^content-disposition:(.*)$/im.exec(text)?.[1] ?? "";
	const filename = /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(disp)?.[1];
	return { field: /\bname="([^"]*)"/i.exec(disp)?.[1] ?? "", ...(filename === undefined ? {} : { filename: fileName(filename) }), type: /^content-type:\s*(.*?)\s*$/im.exec(text)?.[1] ?? "" };
}

// open answers each part with where its bytes go, or nothing to skip it. A body that ends before the closing boundary throws.
export async function readMultipart(body: ReadableStream<Uint8Array>, boundary: string, open: (head: PartHead) => Promise<PartSink | undefined>): Promise<void> {
	const delim = Buffer.from(`\r\n--${boundary}`), reader = body.getReader();
	let buf: Buffer = Buffer.from("\r\n");
	const more = async () => {
		const r = await reader.read();
		if (r.done) throw new Error("multipart body ended early");
		buf = buf.length ? Buffer.concat([buf, r.value]) : Buffer.from(r.value);
	};
	// Everything up to the next boundary goes to the sink; the last bytes wait for the next read, since a boundary can straddle two.
	const pour = async (sink?: PartSink) => {
		for (;;) {
			const at = buf.indexOf(delim);
			const safe = at >= 0 ? at : buf.length - delim.length + 1;
			if (safe > 0) await sink?.write(buf.subarray(0, safe));
			if (at >= 0) { buf = buf.subarray(at + delim.length); return; }
			if (safe > 0) buf = buf.subarray(safe);
			await more();
		}
	};
	try {
		await pour();
		for (;;) {
			while (buf.length < 2) await more();
			if (buf[0] === DASH && buf[1] === DASH) break;
			let end = buf.indexOf(HEAD_END);
			while (end < 0) {
				if (buf.length > HEAD_MAX) throw new Error("multipart part head too long");
				await more();
				end = buf.indexOf(HEAD_END);
			}
			const head = parseHead(buf.subarray(0, end).toString("utf8"));
			buf = buf.subarray(end + HEAD_END.length);
			const sink = await open(head);
			await pour(sink);
			await sink?.end();
		}
		while (!(await reader.read()).done);
	} finally {
		await reader.cancel().catch(() => { /* the body already failed or ended: nothing left to release */ });
	}
}
