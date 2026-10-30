// dotz_peer refuses to send text that carries a secret to another computer: the local hub token, the peer token, or a well-known credential shape.
const SHAPES = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/;
const MIN_SECRET = 16;   // a shorter value is too likely to be a plain word to match on

// The reason the text must not leave this computer, or undefined when it is clean. `known` = secret values this gateway holds (undefined entries are skipped).
export function secretIn(text: string, known: Array<string | undefined>): string | undefined {
	if (known.some(v => v && v.length >= MIN_SECRET && text.includes(v))) return "contains a dotz token";
	if (SHAPES.test(text)) return "looks like a secret (key, token or password)";
	return undefined;
}
