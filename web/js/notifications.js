// Push notifications UI (brief §14) — browse-only app, NO login/identity. The push
// subscription endpoint IS the per-device key; prefs ride along with it. Three quiet
// toggles, no toggle-soup. The whole section hides if the browser can't do push or the
// server has no VAPID keys configured.
//
// Enabling push talks to two parties: OUR worker (key fetch + storing the sub) and
// the BROWSER's push service (FCM on Android, Apple Push on iOS). The second one is
// flaky in well-documented ways, so enablePush() is built to self-heal: typed error
// handling, a service-worker reset mid-retry (clears a corrupted push registration),
// stale-key replacement, and a diagnostics readout so failures are reportable.

const LS_KEY = "wc26-push-prefs";
const LS_ERR = "wc26-push-lasterr";
const DEFAULT_PREFS = { results: true, today: true, qual: true };

export function pushSupported() {
  return typeof navigator !== "undefined" && typeof window !== "undefined"
    && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
export function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch {} }
const isAndroid = () => typeof navigator !== "undefined" && /android/i.test(navigator.userAgent || "");
function recordError(e) {
  try { localStorage.setItem(LS_ERR, `${new Date().toISOString().slice(0, 16)} ${e?.name || "Error"}: ${e?.message || e}`); } catch {}
}

function urlB64ToBytes(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
// A VAPID public key is an uncompressed P-256 point: 65 bytes, 0x04 prefix. Checking
// it client-side separates "our config is broken" from "the push service is down".
function keyValid(key) {
  try { const b = urlB64ToBytes(key); return b.length === 65 && b[0] === 4; } catch { return false; }
}

export async function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js"); } catch { return null; }
}

async function serverVapidKey() {
  try {
    const r = await fetch("/push/vapidPublicKey");
    if (!r.ok) return null;
    const j = await r.json();
    return j.enabled ? j.key : null;
  } catch { return null; }
}

export async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// navigator.serviceWorker.ready never REJECTS — a broken/missing registration would
// hang the enable flow forever. Race it against a timeout and re-register once.
const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
async function swReady() {
  let reg = await withTimeout(navigator.serviceWorker.ready, 5000);
  if (!reg) { await registerServiceWorker(); reg = await withTimeout(navigator.serviceWorker.ready, 5000); }
  if (!reg) throw new Error("The app's background worker isn't ready — reload the page, then try again.");
  return reg;
}

// pushManager.subscribe() fails in distinct, recoverable ways. Handle each by type
// instead of asking the user to keep tapping:
//   • NotAllowedError    — permission is the problem; retrying is pointless.
//   • InvalidStateError  — an old subscription (different server key) blocks the new
//                          one; unsubscribe it and go again immediately.
//   • InvalidAccessError — OUR key is malformed; that's config, not the device.
//   • AbortError (etc.)  — the push service is unreachable; back off and retry, and
//                          half-way through reset the service-worker registration,
//                          which clears a corrupted push registration on Chrome.
async function subscribeWithRetry(reg, key, onStatus, attempts = 5) {
  const appKey = urlB64ToBytes(key);
  for (let i = 0; i < attempts; i++) {
    try {
      return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    } catch (e) {
      recordError(e);
      if (e?.name === "NotAllowedError")
        throw new Error("Notifications are blocked for this site — allow them in your browser's site settings, then try again.");
      if (e?.name === "InvalidStateError") {
        try {
          const old = await reg.pushManager.getSubscription();
          if (old) { await old.unsubscribe(); continue; }   // stale sub cleared — retry now
        } catch {}
        throw new Error("A stale subscription is blocking this device — clear this site's data, reload, and try again.");
      }
      if (e?.name === "InvalidAccessError" || e?.name === "InvalidCharacterError")
        throw new Error("The server's push key looks invalid — this is a site configuration problem, not your device.");
      if (i === 2) {
        // mid-retry reset: the programmatic version of "clear site data"
        if (onStatus) onStatus("Resetting and retrying…");
        try { await reg.unregister(); await registerServiceWorker(); reg = await withTimeout(navigator.serviceWorker.ready, 5000) || reg; } catch {}
      } else if (onStatus && i < attempts - 1) {
        onStatus(`Reaching the push service… (attempt ${i + 2} of ${attempts})`);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));   // 0.5s → 4s
    }
  }
  throw new Error(isAndroid()
    ? "Couldn't reach Google's push service. Update Google Play Services, switch off any VPN or Private DNS, make sure the clock is set automatically — a reboot often clears it. Then try again."
    : "Couldn't reach the push service. Close and reopen the app; if it keeps failing, restart the device and try again.");
}

// An existing subscription minted under a DIFFERENT server key can never be delivered
// to (the send would 403) — replace it rather than storing it as if it were fine.
function subMatchesKey(sub, key) {
  try {
    const cur = sub.options?.applicationServerKey;
    if (!cur) return true;                              // browser won't say — assume ok
    const a = new Uint8Array(cur), b = urlB64ToBytes(key);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  } catch { return true; }
}

export async function enablePush(prefs, onStatus) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked — allow them in the browser prompt, then try again.");
  const key = await serverVapidKey();
  if (!key) throw new Error("Push isn't configured on the server");
  if (!keyValid(key)) throw new Error("The server's push key is malformed — push can't work until it's fixed.");
  if (onStatus) onStatus("Setting up…");
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !subMatchesKey(sub, key)) { try { await sub.unsubscribe(); } catch {} sub = null; }
  if (!sub) sub = await subscribeWithRetry(reg, key, onStatus);
  await fetch("/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), prefs }),
  });
  try { localStorage.removeItem(LS_ERR); } catch {}     // healthy again — clear the stored failure
  return sub;
}
async function syncPrefs(prefs) {
  const sub = await currentSubscription();
  if (!sub) return;
  await fetch("/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), prefs }),
  });
}
async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    try { await fetch("/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch {}
    try { await sub.unsubscribe(); } catch {}
  }
}

// ── diagnostics: everything needed to tell WHY enabling failed, in one readout ──
export async function pushDiagnostics() {
  const d = [];
  const put = (k, v) => d.push([k, v]);
  put("Push support", pushSupported() ? "yes" : "no");
  try { put("Permission", Notification.permission); } catch { put("Permission", "n/a"); }
  try { put("Installed app", matchMedia("(display-mode: standalone)").matches ? "yes" : "no — browser tab"); } catch {}
  let reg = null;
  try { reg = await withTimeout(navigator.serviceWorker.getRegistration(), 3000); } catch {}
  put("Service worker", reg ? (reg.active ? "active" : "installing") : "not registered");
  try {
    const key = await serverVapidKey();
    put("Server key", key ? (keyValid(key) ? "ok" : "MALFORMED") : "missing/disabled");
  } catch { put("Server key", "fetch failed"); }
  try { if (reg) put("Push permission", await reg.pushManager.permissionState({ userVisibleOnly: true })); } catch {}
  try {
    const sub = reg && await reg.pushManager.getSubscription();
    put("Subscription", sub ? `yes (${new URL(sub.endpoint).host})` : "none");
  } catch { put("Subscription", "error"); }
  try { const e = localStorage.getItem(LS_ERR); if (e) put("Last error", e); } catch {}
  return d;
}

const TOGGLES = [
  { k: "results", t: "Last night's results", d: "A morning digest (~8am)" },
  { k: "today", t: "Today's matches", d: "A midday heads-up" },
  { k: "qual", t: "Qualification moments", d: "When a team goes through or out" },
];

// The settings card markup (rendered inside More). State is filled in by the mount.
export function notificationsCardHTML() {
  if (!pushSupported()) {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const ios = /iphone|ipad|ipod/i.test(ua);
    return `<div class="sec-head"><h2>Notifications</h2></div><div class="block"><div class="lrow">
      <span class="nm muted" style="font-weight:500">${ios
        ? "Add WC26 to your Home Screen first (Share → Add to Home Screen), then notifications can be enabled here."
        : "This browser doesn't support push notifications."}</span></div></div>`;
  }
  const prefs = loadPrefs();
  const toggles = TOGGLES.map((x) => `
    <label class="lrow toggle-row" data-toggle="${x.k}">
      <span class="nm">${x.t}<div class="sub">${x.d}</div></span>
      <input type="checkbox" class="sw" data-pref="${x.k}" ${prefs[x.k] ? "checked" : ""} />
    </label>`).join("");
  return `<div class="sec-head"><h2>Notifications</h2></div>
    <div class="block" id="notif-card">
      <div class="lrow" id="notif-cta">
        <span class="nm">Push notifications<div class="sub" id="notif-status">Off — quiet by default</div></span>
        <button class="btn-pill" id="notif-toggle">Enable</button>
      </div>
      <div id="notif-toggles" hidden>${toggles}</div>
      <div class="lrow" id="notif-diag-row"><button type="button" class="diaglink" id="notif-diag-btn">Having trouble? Run diagnostics</button></div>
      <div id="notif-diag" class="diagbox" hidden></div>
    </div>
    <div class="updated">No accounts, no tracking — the toggles live on this device only.</div>`;
}

// Wire the card up after it's in the DOM (called from screens' renderMore mount).
export async function mountNotifications(root) {
  if (!pushSupported()) return;
  const card = root.querySelector("#notif-card");
  if (!card) return;
  const statusEl = card.querySelector("#notif-status");
  const toggleBtn = card.querySelector("#notif-toggle");
  const togglesEl = card.querySelector("#notif-toggles");
  const diagBtn = card.querySelector("#notif-diag-btn");
  const diagEl = card.querySelector("#notif-diag");

  // Hide the whole feature if the server has no VAPID keys.
  if (!(await serverVapidKey())) {
    card.innerHTML = `<div class="lrow"><span class="nm muted" style="font-weight:500">Notifications aren't available right now.</span></div>`;
    return;
  }

  const showDiag = async () => {
    diagEl.hidden = false;
    diagEl.innerHTML = `<div class="diagrow"><span>Running checks…</span></div>`;
    const rows = await pushDiagnostics();
    diagEl.innerHTML = rows.map(([k, v]) => `<div class="diagrow"><span>${k}</span><b>${v}</b></div>`).join("");
  };
  diagBtn.addEventListener("click", () => (diagEl.hidden ? showDiag() : (diagEl.hidden = true)));

  const sub = await currentSubscription().catch(() => null);
  let on = !!sub && Notification.permission === "granted";
  const paint = () => {
    statusEl.textContent = on ? "On" : "Off — quiet by default";
    toggleBtn.textContent = on ? "Turn off" : "Enable";
    toggleBtn.classList.toggle("on", on);
    togglesEl.hidden = !on;
  };
  paint();

  toggleBtn.addEventListener("click", async () => {
    toggleBtn.disabled = true;
    const setStatus = (t) => { statusEl.textContent = t; };
    try {
      if (on) { await disablePush(); on = false; diagEl.hidden = true; }
      else { toggleBtn.textContent = "Setting up…"; await enablePush(loadPrefs(), setStatus); on = true; diagEl.hidden = true; }
      paint();
    } catch (e) {
      window.dispatchEvent(new CustomEvent("wc-toast", { detail: e.message || "Couldn't change notifications" }));
      paint();
      statusEl.textContent = "Failed — details below";
      await showDiag();                       // a failure always leaves something reportable
    } finally { toggleBtn.disabled = false; }
  });

  togglesEl.querySelectorAll("input[data-pref]").forEach((el) => {
    el.addEventListener("change", async () => {
      const prefs = loadPrefs();
      prefs[el.dataset.pref] = el.checked;
      savePrefs(prefs);
      try { await syncPrefs(prefs); } catch {}
    });
  });
}
