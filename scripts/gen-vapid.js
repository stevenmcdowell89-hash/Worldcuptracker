// One-off: generate a VAPID key pair for web push (brief §14).
//   node scripts/gen-vapid.js
// Then set these on the Worker (Settings → Variables and Secrets):
//   VAPID_JWK         (Secret)  — the private key JWK printed below
//   VAPID_PUBLIC_KEY  (Variable) — the base64url public key (also used by the browser)
//   VAPID_SUBJECT     (Variable) — a mailto: or https: contact, e.g. mailto:you@example.com
import { webcrypto as crypto } from "node:crypto";

const enc = (b) => Buffer.from(b).toString("base64url");

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)); // 65-byte point

// The same key must be importable for ECDSA signing in the Worker; keep only the EC bits.
const privateJwk = { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y };

console.log("VAPID_PUBLIC_KEY =", enc(rawPublic));
console.log("VAPID_JWK        =", JSON.stringify(privateJwk));
console.log("VAPID_SUBJECT    = mailto:you@example.com   (edit me)");
