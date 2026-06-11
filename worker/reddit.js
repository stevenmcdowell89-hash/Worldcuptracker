// Reddit r/soccer live match-thread reactions — an ALTERNATIVE commentary feed.
//
// r/soccer auto-posts a "Match Thread" for every game; the comments are a torrent of
// fan reactions during the match. This module finds that thread and pulls the
// top-voted comments so the app can offer them ALONGSIDE the Guardian minute-by-minute
// (the user picks — it never replaces the MBM). They are reactions/banter, NOT
// timed commentary, and are labelled as such in the UI (brief §8 honesty).
//
// Read-only "userless" OAuth (client-credentials) — no Reddit account, no posting.
// Gated on REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET; best-effort everywhere (every call
// is wrapped by the caller) so a Reddit hiccup never breaks the snapshot. Note: Reddit
// can rate-limit datacenter IPs, so treat a miss as normal, not an error.

const OAUTH = "https://oauth.reddit.com";
const WWW = "https://www.reddit.com";

export const redditEnabled = (env) => !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);

// Reddit requires a descriptive, unique User-Agent or it throttles/blocks aggressively.
const ua = (env) => env.REDDIT_USER_AGENT || "web:wc26-tracker:1.0 (live match-thread reactions)";

// Userless app-only token (lasts ~1h). Cached in KV so we authenticate once per hour,
// not once per poll. KV is optional — without it we just re-auth each time.
export async function getRedditToken(env) {
  try {
    const cached = env.SNAPSHOT ? await env.SNAPSHOT.get("reddit-token", "json") : null;
    if (cached?.token && cached.exp > Date.now() + 60e3) return cached.token;
  } catch { /* fall through to a fresh token */ }
  const auth = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
  const r = await fetch(`${WWW}/api/v1/access_token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded", "user-agent": ua(env) },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!r.ok) throw new Error(`reddit token ${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error("reddit token missing");
  const ttl = j.expires_in || 3600;
  try { if (env.SNAPSHOT) await env.SNAPSHOT.put("reddit-token", JSON.stringify({ token: j.access_token, exp: Date.now() + ttl * 1000 }), { expirationTtl: ttl }); } catch {}
  return j.access_token;
}

async function api(env, token, path, params = {}) {
  const url = new URL(OAUTH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "user-agent": ua(env) } });
  if (!r.ok) throw new Error(`reddit ${path} ${r.status}`);
  return r.json();
}

// Find the r/soccer match thread for a fixture. Score candidates by created-time vs
// kickoff + team-name hits — the same approach as the Guardian liveblog discovery.
// Only a confident match counts (both teams named, or within ~4h of kickoff).
export async function findMatchThread(env, token, home, away, kickoffIso) {
  const koMs = Date.parse(kickoffIso || "");
  const lower = (s) => (s || "").toLowerCase();
  const tokens = [home, away].filter(Boolean).map((n) => lower(n).split(/\s+/).pop()).filter((t) => t.length > 2);
  const q = ["Match Thread", home, away].filter(Boolean).join(" ");
  const j = await api(env, token, "/r/soccer/search", { q, restrict_sr: "1", sort: "new", t: "week", limit: "25" });
  // Keep only true match threads (exclude Pre-/Post-Match and other discussion).
  const posts = (j?.data?.children || []).map((c) => c.data)
    .filter((d) => /match thread/i.test(d?.title || "") && !/post.?match|pre.?match/i.test(d.title));
  if (!posts.length) return null;

  const bothNamed = (t) => tokens.length >= 2 && tokens.every((tok) => lower(t).includes(tok));
  const someNamed = (t) => tokens.some((tok) => lower(t).includes(tok));
  let best = null, bestScore = Infinity;
  for (const p of posts) {
    const created = (p.created_utc || 0) * 1000;
    let score = (isNaN(created) || isNaN(koMs)) ? 6 * 36e5 : Math.abs(created - koMs);   // closeness to kickoff
    if (bothNamed(p.title)) score -= 6 * 36e5;          // strong: both teams in the title
    else if (someNamed(p.title)) score -= 2 * 36e5;     // mild: one team
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best && (bestScore < 4 * 36e5 || bothNamed(best.title))
    ? { id: best.id, url: WWW + best.permalink }
    : null;
}

// Pull the top-voted comments from a match thread → commentary blocks. Match-thread
// comments are fan REACTIONS, so we surface the most-upvoted top-level ones (sorted by
// score) and skip the noise (bot posts, removed/deleted, one-word spam, walls of text).
export async function fetchThreadComments(env, token, threadId, cap = 30) {
  const j = await api(env, token, `/r/soccer/comments/${threadId}`, { sort: "top", limit: "100", depth: "1", threaded: "false" });
  const listing = Array.isArray(j) ? j[1] : null;       // reddit returns [post, comments]
  const children = listing?.data?.children || [];
  const out = [];
  for (const c of children) {
    if (c.kind !== "t1") continue;                       // skip "load more" stubs
    const d = c.data || {};
    const text = (d.body || "").trim();
    if (!text || text === "[removed]" || text === "[deleted]") continue;
    if (d.author === "[deleted]" || d.author === "AutoModerator") continue;
    if (d.stickied) continue;                            // pinned bot/mod boilerplate
    if (text.length < 4 || text.length > 700) continue;  // skip one-word spam + essays
    out.push({
      at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : "",
      title: `▲ ${d.score ?? 0} · u/${d.author}`,
      text,
      key: (d.score ?? 0) >= 250,                        // heavily-upvoted reactions get the accent
      _score: d.score ?? 0,
    });
  }
  out.sort((a, b) => b._score - a._score);               // most-upvoted first
  return out.slice(0, cap).map(({ _score, ...b }) => b);
}
