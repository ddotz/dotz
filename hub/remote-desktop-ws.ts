// The websocket half of the remote desktop (hub/remote-desktop.ts): one browser socket bridged to voxl's through a raw TCP client.
import { createHash, randomBytes } from "node:crypto";
import type { ServerWebSocket, Socket } from "bun";
import type { Clock, DeskHost, DeskWsData } from "./remote-desktop.ts";

export const HOLD = 1 << 20; // most bytes kept for a slow peer in either direction
const MSG_MAX = 64 << 20; // largest websocket message (voxl's own limit)

const cat = (a: Uint8Array, b: Uint8Array) => {
	const o = new Uint8Array(a.length + b.length);
	o.set(a);
	o.set(b, a.length);
	return o;
};
// A masked client frame (RFC 6455): browsers' frames are re-framed here for voxl.
function frameOf(op: number, body: Uint8Array): Uint8Array {
	const n = body.length;
	const head = n < 126 ? [0x80 | op, 0x80 | n] : n < 65536 ? [0x80 | op, 0x80 | 126, n >> 8, n & 255] : [0x80 | op, 0x80 | 127, 0, 0, 0, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
	const mask = crypto.getRandomValues(new Uint8Array(4));
	const out = new Uint8Array(head.length + 4 + n);
	out.set(head);
	out.set(mask, head.length);
	for (let i = 0; i < n; i++) out[head.length + 4 + i] = body[i]! ^ mask[i & 3]!;
	return out;
}

/** One browser websocket bridged to voxl's: a raw TCP client so the reading can be paused (new WebSocket() cannot). */
// A code the browser side may not be sent would throw in ws.close and leave the viewer connected to nothing.
const sendableClose = (code: number) => (code >= 1000 && code < 5000 && ![1005, 1006, 1015].includes(code) ? code : 1011);

export class Bridge {
	private sock?: Socket;
	private shaken = false;
	private head = new Uint8Array(0);
	private hd = new Uint8Array(0);
	private fr?: { op: number; fin: boolean; len: number; got: number; buf: Uint8Array };
	private msg?: { op: number; parts: Uint8Array[]; size: number };
	private out: Uint8Array[] = [];
	private paused = 0; // when the reading stopped (clock ms), 0 = reading
	private slow = false;
	private key = randomBytes(16).toString("base64");
	constructor(private ws: ServerWebSocket<DeskWsData>, private host: DeskHost, private clock: Clock, search: string) {
		void Bun.connect({
			hostname: "127.0.0.1",
			port: host.port,
			socket: {
				open: s => {
					this.sock = s;
					s.write(`GET /ws${search} HTTP/1.1\r\nHost: 127.0.0.1:${host.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${host.password}\r\n\r\n`);
				},
				data: (_s, chunk) => this.onData(chunk.slice()),
				drain: () => this.flush(),
				close: () => void (this.sock && this.fail(1011, "closed")), // gone unasked; our own terminate() clears sock first
				error: () => this.fail(1011, "error"),
			},
		}).catch(() => this.fail(1011, "connect"));
	}

	send(msg: string | Uint8Array): void {
		const f = frameOf(typeof msg === "string" ? 1 : 2, typeof msg === "string" ? new TextEncoder().encode(msg) : msg);
		// One message may be big (a pasted image); only a queue behind a stalled voxl is a reason to give up.
		const queued = this.out.reduce((n, x) => n + x.length, 0);
		if (queued && queued + f.length > HOLD) return this.fail(1011, "slow upstream");
		this.out.push(f);
		this.flush();
	}
	private flush(): void {
		while (this.shaken && this.sock && this.out.length) {
			const f = this.out[0]!;
			const n = this.sock.write(f);
			if (n < f.length) return void (this.out[0] = f.subarray(Math.max(n, 0)));
			this.out.shift();
		}
	}
	/** The browser's send buffer drained: read from voxl again. */
	resume(): void {
		if (!this.paused) return;
		this.host.relay.paused_ms += this.clock.now() - this.paused;
		this.paused = 0;
		this.sock?.resume();
	}
	close(): void {
		const s = this.sock;
		this.sock = undefined;
		s?.terminate();
	}
	private fail(code: number, why: string): void {
		this.close();
		try {
			this.ws.close(code, why);
		} catch {}
	}

	private onData(c: Uint8Array): void {
		this.host.relay.bytes += c.length;
		if (!this.shaken) {
			this.head = cat(this.head, c);
			const end = this.head.findIndex((_, i, a) => a[i] === 13 && a[i + 1] === 10 && a[i + 2] === 13 && a[i + 3] === 10);
			if (end < 0) return;
			const text = new TextDecoder().decode(this.head.subarray(0, end));
			const accept = createHash("sha1").update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
			if (!/^HTTP\/1\.1 101/.test(text) || !text.includes(accept)) return this.fail(1011, "handshake");
			this.shaken = true;
			c = this.head.subarray(end + 4);
			this.head = new Uint8Array(0);
			this.flush();
		}
		this.slow = false;
		this.feed(c);
		this.host.relay.max_buffered = Math.max(this.host.relay.max_buffered, this.ws.getBufferedAmount());
		if ((this.slow || this.ws.getBufferedAmount() > HOLD) && this.sock && !this.paused) {
			this.paused = this.clock.now() || 1;
			this.host.relay.pauses++;
			this.sock.pause();
		}
	}
	// Server frames are unmasked; a frame may span reads, a message may span frames.
	private feed(c: Uint8Array): void {
		while (c.length) {
			if (this.fr) {
				const f = this.fr;
				const n = Math.min(c.length, f.len - f.got);
				f.buf.set(c.subarray(0, n), f.got);
				f.got += n;
				c = c.subarray(n);
				if (f.got === f.len) this.finish(f);
				continue;
			}
			const h = (this.hd = this.hd.length ? cat(this.hd, c) : c);
			if (h.length < 2) return void (this.hd = h.slice());
			const l7 = h[1]! & 0x7f;
			const hl = 2 + (l7 === 126 ? 2 : l7 === 127 ? 8 : 0);
			if (h.length < hl) return void (this.hd = h.slice());
			const len = l7 === 126 ? (h[2]! << 8) | h[3]! : l7 === 127 ? Number(new DataView(h.buffer, h.byteOffset).getBigUint64(2)) : l7;
			if (h[1]! & 0x80 || len > MSG_MAX) return this.fail(1002, "bad frame");
			this.fr = { op: h[0]! & 15, fin: !!(h[0]! & 128), len, got: 0, buf: new Uint8Array(len) };
			c = h.subarray(hl);
			this.hd = new Uint8Array(0);
			if (!len) this.finish(this.fr);
		}
	}
	private finish(f: NonNullable<Bridge["fr"]>): void {
		this.fr = undefined;
		switch (f.op) {
			case 0:
			case 1:
			case 2: {
				if (f.op) this.msg = { op: f.op, parts: [], size: 0 };
				const m = this.msg;
				if (!m) return this.fail(1002, "bad fragment");
				m.parts.push(f.buf);
				m.size += f.len;
				if (m.size > MSG_MAX) return this.fail(1009, "too big");
				if (!f.fin) return;
				this.msg = undefined;
				const body = m.parts.length === 1 ? m.parts[0]! : m.parts.reduce(cat);
				const r = this.ws.send(m.op === 1 ? new TextDecoder().decode(body) : body);
				if (r === 0) this.fail(1011, "dropped");
				else if (r === -1) this.slow = true;
				return;
			}
			case 8:
				return this.fail(sendableClose(f.len >= 2 ? (f.buf[0]! << 8) | f.buf[1]! : 1000), "voxl closed");
			case 9:
				this.out.push(frameOf(10, f.buf)); // out[0] may be half written
				return this.flush();
			case 10:
				return;
			default:
				return this.fail(1002, "bad opcode");
		}
	}
}
