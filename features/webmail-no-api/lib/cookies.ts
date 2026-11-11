// Live cookie source: build a Cookie header for a site's hosts out of the owner's own Aside browser cookie store, the same
// login they use in the browser. Reads a throwaway copy of the Chromium cookie DB and decrypts with the per-app keychain
// key (Chromium v10 scheme: PBKDF2-SHA1 of the keychain secret, AES-128-CBC, 0x20 IV). Never prints a cookie value; the
// header it returns is passed straight to fetch and never logged. Only the live scripts use this; tests inject a fake
// cookieHeader instead, so no test touches the keychain, the DB or the network.
import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SiteSpec } from "./spec.ts";

const COOKIES_DB = join(homedir(), "Library", "Application Support", "Aside", "Default", "Cookies");

let cachedKey: Buffer | null = null;
async function keychainKey(): Promise<Buffer | null> {
	if (cachedKey) return cachedKey;
	const r = await Bun.$`/usr/bin/security find-generic-password -w -s ${"Aside Safe Storage"} -a Aside`.quiet().nothrow();
	if (r.exitCode !== 0) return null;
	cachedKey = pbkdf2Sync(r.stdout.toString().trim(), "saltysalt", 1003, 16, "sha1");
	return cachedKey;
}

function hostClause(hosts: string[]): { sql: string; params: string[] } {
	const placeholders = hosts.map(() => "?").join(", ");
	return { sql: `select name, encrypted_value from cookies where host_key in (${placeholders})`, params: hosts };
}

export async function cookieHeaderFromAside(spec: SiteSpec): Promise<string> {
	const key = await keychainKey();
	if (!key) throw new Error("Aside 키체인 키를 읽지 못했어요 (Aside가 설치/로그인돼 있나요?)");
	if (!existsSync(COOKIES_DB)) throw new Error("Aside 쿠키 저장소를 찾지 못했어요");
	const dir = mkdtempSync("/tmp/wm-ck-");
	try {
		for (const ext of ["", "-wal", "-journal"]) if (existsSync(COOKIES_DB + ext)) copyFileSync(COOKIES_DB + ext, join(dir, `Cookies${ext}`));
		const db = new Database(join(dir, "Cookies"), { readonly: true });
		const version = Number((db.query("select value from meta where key='version'").get() as any)?.value ?? 0);
		const { sql, params } = hostClause(spec.cookieHosts);
		const rows = db.query(sql).all(...params) as { name: string; encrypted_value: Uint8Array }[];
		db.close();
		return rows
			.map(({ name, encrypted_value }) => {
				const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
				let plain = Buffer.concat([d.update(Buffer.from(encrypted_value).subarray(3)), d.final()]);
				if (version >= 24) plain = plain.subarray(32);
				return `${name}=${plain.toString("utf8")}`;
			})
			.join("; ");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
