const encoder = new TextEncoder();

export function b64url(data: ArrayBuffer | Uint8Array | string): string {
	const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): string {
	return new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
}

export function randomToken(bytes = 24): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacHex(secret: string, message: string | ArrayBuffer): Promise<string> {
	const data = typeof message === "string" ? encoder.encode(message) : message;
	return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), data));
}

export function timingSafeEqual(a: string, b: string): boolean {
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	if (x.byteLength !== y.byteLength) return false;
	return crypto.subtle.timingSafeEqual(x, y);
}

/** Signed, expiring value for cookies: `<payload>.<hmac>`. */
export async function sign(secret: string, payload: object, ttlSeconds: number): Promise<string> {
	const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
	return `${body}.${await hmacHex(secret, body)}`;
}

export async function unsign<T>(secret: string, value: string | undefined): Promise<T | null> {
	if (!value) return null;
	const [body, mac] = value.split(".");
	if (!body || !mac || !timingSafeEqual(mac, await hmacHex(secret, body))) return null;
	try {
		const payload = JSON.parse(b64urlDecode(body)) as T & { exp: number };
		return payload.exp > Date.now() / 1000 ? payload : null;
	} catch {
		return null;
	}
}

function derLength(n: number): number[] {
	if (n < 0x80) return [n];
	const bytes: number[] = [];
	for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
	return [0x80 | bytes.length, ...bytes];
}

/**
 * GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto only
 * imports PKCS#8, so wrap the key in the PKCS#8 envelope.
 */
export function pemToPkcs8(pem: string): Uint8Array {
	const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
	if (!pem.includes("BEGIN RSA PRIVATE KEY")) return der;
	const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
	const octets = [0x04, ...derLength(der.length)];
	const inner = [0x02, 0x01, 0x00, ...rsaAlgorithm, ...octets];
	return Uint8Array.from([0x30, ...derLength(inner.length + der.length), ...inner, ...der]);
}

/** Short-lived RS256 JWT identifying the GitHub App itself. */
export async function appJwt(appId: string, pem: string): Promise<string> {
	const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
	return `${unsigned}.${b64url(signature)}`;
}
