import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appJwt, b64urlDecode, hmacHex, sign, unsign } from "../src/crypto.ts";

test("appJwt signs with the PKCS#1 key format GitHub hands out", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	assert.match(privateKey, /BEGIN RSA PRIVATE KEY/);

	const jwt = await appJwt("12345", privateKey);
	const [header, payload, signature] = jwt.split(".");
	assert.equal(JSON.parse(b64urlDecode(payload)).iss, "12345");
	assert.ok(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url"));
});

test("webhook signatures match GitHub's documented example", async () => {
	// https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
	assert.equal(await hmacHex("It's a Secret to Everybody", "Hello, World!"), "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
});

test("signed cookies reject tampering and expiry", async (t) => {
	// Workers-only API, polyfilled for Node.
	(crypto.subtle as any).timingSafeEqual ??= (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

	const value = await sign("secret", { login: "octocat" }, 60);
	assert.equal((await unsign<{ login: string }>("secret", value))?.login, "octocat");
	assert.equal(await unsign("other-secret", value), null);
	assert.equal(await unsign("secret", value.replace(/^./, "x")), null);
	assert.equal(await unsign("secret", await sign("secret", { login: "octocat" }, -1)), null);
});
