// Web Push from a Cloudflare Worker (brief §14) — pure Web Crypto, no dependencies.
//
// Implements VAPID (RFC 8292) request authorization + aes128gcm payload encryption
// (RFC 8291 / RFC 8188). The whole feature is inert unless VAPID keys are configured
// (env.VAPID_JWK + env.VAPID_PUBLIC_KEY), so the app ships without it and lights up
// when the secrets are set. Generate keys with `node scripts/gen-vapid.js`.

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// HKDF-SHA256 (extract + expand in one go).
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Encrypt `payload` for a push subscription's keys, producing a single aes128gcm
// record (RFC 8188) with the RFC 8291 key derivation. `opts` lets tests inject a
// deterministic ephemeral key + salt.
export async function encryptPayload(payload, p256dhB64, authB64, opts = {}) {
  const uaPublicRaw = b64urlDecode(p256dhB64);     // 65-byte uncompressed point
  const authSecret = b64urlDecode(authB64);        // 16-byte auth secret
  const plaintext = typeof payload === "string" ? enc.encode(payload) : payload;

  const asKeys = opts.asKeyPair || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));

  const uaPublic = await crypto.subtle.importKey("raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublic }, asKeys.privateKey, 256));

  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291: IKM = HKDF(auth_secret, ecdh, "WebPush: info\0" || ua_pub || as_pub).
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

  // RFC 8188: content-encryption key + nonce from the record salt.
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // Single final record: plaintext followed by the 0x02 delimiter.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record));

  // Header: salt(16) | rs(4, uint32 BE) | idlen(1)=65 | keyid(as_public, 65).
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(asPublicRaw, 21);
  return concat(header, ct);
}

// VAPID ES256 JWT (RFC 8292). `jwk` is the EC private JWK; signature is raw r||s.
export async function createVapidJWT(jwk, audience, subject, now = Date.now()) {
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject,
  })));
  const data = `${head}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(data)));
  return `${data}.${b64urlEncode(sig)}`;
}

// Send one push. Returns the upstream Response (caller prunes on 404/410).
export async function sendWebPush(subscription, payload, env) {
  const url = new URL(subscription.endpoint);
  const jwt = await createVapidJWT(JSON.parse(env.VAPID_JWK), `${url.protocol}//${url.host}`, env.VAPID_SUBJECT || "mailto:admin@example.com");
  const body = await encryptPayload(JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
    },
    body,
  });
}
