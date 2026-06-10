// Web-push crypto tests (worker/push.js). We can't hit a real push service offline,
// so we validate correctness end-to-end: encrypt as the server, then DECRYPT as the
// user agent and assert the plaintext round-trips. This exercises ECDH + HKDF +
// AES-GCM + the RFC 8188 record framing exactly as a real push endpoint would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptPayload, createVapidJWT, b64urlEncode, b64urlDecode } from "../worker/push.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out;
}
async function hkdf(salt, ikm, info, len) {
  const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

test("b64url round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
  assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
});

test("encryptPayload produces a body the subscriber can decrypt", async () => {
  // UA (subscriber) keypair + auth secret, as a browser's PushManager would create.
  const ua = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPublicRaw = new Uint8Array(await subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64urlEncode(uaPublicRaw);
  const authB64 = b64urlEncode(auth);

  const message = "Australia are through — Switzerland eliminated.";
  const body = await encryptPayload(message, p256dh, authB64);

  // ── decrypt as the user agent ──
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublicRaw = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);

  const asPublic = await subtle.importKey("raw", asPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asPublic }, ua.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc.encode("WebPush: info\0"), uaPublicRaw, asPublicRaw), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const record = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ct));
  assert.equal(record[record.length - 1], 2, "record must end with the 0x02 delimiter");
  assert.equal(dec.decode(record.slice(0, -1)), message);
});

test("createVapidJWT emits a verifiable ES256 token with the right claims", async () => {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const jwt = await createVapidJWT(jwk, "https://fcm.googleapis.com", "mailto:a@b.c", 1_700_000_000_000);

  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(dec.decode(b64urlDecode(h)));
  const claims = JSON.parse(dec.decode(b64urlDecode(p)));
  assert.equal(header.alg, "ES256");
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:a@b.c");
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);

  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, b64urlDecode(s), enc.encode(`${h}.${p}`));
  assert.ok(ok, "VAPID JWT signature must verify against the public key");
});
