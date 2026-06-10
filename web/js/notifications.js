// Push notifications UI (brief §14) — browse-only app, NO login/identity. The push
// subscription endpoint IS the per-device key; prefs ride along with it. Three quiet
// toggles, no toggle-soup. The whole section hides if the browser can't do push or the
// server has no VAPID keys configured.

const LS_KEY = "wc26-push-prefs";
const DEFAULT_PREFS = { results: true, today: true, qual: true };

export function pushSupported() {
  return typeof navigator !== "undefined" && typeof window !== "undefined"
    && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch {} }

function urlB64ToBytes(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
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

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enablePush(prefs) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Permission denied");
  const key = await serverVapidKey();
  if (!key) throw new Error("Push isn't configured on the server");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) });
  await fetch("/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), prefs }),
  });
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

  // Hide the whole feature if the server has no VAPID keys.
  if (!(await serverVapidKey())) {
    card.innerHTML = `<div class="lrow"><span class="nm muted" style="font-weight:500">Notifications aren't available right now.</span></div>`;
    return;
  }

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
    try {
      if (on) { await disablePush(); on = false; }
      else { await enablePush(loadPrefs()); on = true; }
    } catch (e) {
      window.dispatchEvent(new CustomEvent("wc-toast", { detail: e.message || "Couldn't change notifications" }));
    } finally { toggleBtn.disabled = false; paint(); }
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
