// Generates web/icon.svg — the PWA / home-screen icon.
//   node scripts/gen-icon.js
//
// Concept: the app's signature CUT LINE as a rising amber diagonal that literally
// slices the "26" into a duotone (white above the line, amber below), with a football
// launching off the top of the line on a motion trail. Dynamic, on-brand, ties the
// USP (the moving cut line) straight into the mark. Key content stays in the maskable
// safe zone (centre ~80%); the diagonal can run to the edges (decorative).
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AMBER = "#FBB034";
const DARK = "#2A2597";

// rising cut-line endpoints (lower-left → upper-right)
const P1 = [54, 404], P2 = [462, 176];
const m = (P2[1] - P1[1]) / (P2[0] - P1[0]);
const b = P1[1] - m * P1[0];
const yAt = (x) => m * x + b;
// unit vector along the line, and its perpendicular
const dx = P2[0] - P1[0], dy = P2[1] - P1[1], L = Math.hypot(dx, dy);
const u = [dx / L, dy / L], p = [-u[1], u[0]];
const along = (bx, by, d) => [bx + u[0] * d, by + u[1] * d];
const fmt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;

// football: white ball, regular pentagon pattern
const ANG = [-90, -18, 54, 126, 198];
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
const pent = (cx, cy, r, s) => ANG.map((_, k) => fmt(pt(cx, cy, r, s + k * 72))).join(" ");
function ball(cx, cy, R) {
  const rim = ANG.map((a) => pt(cx, cy, R, a));
  const patches = rim.map((c, i) => `<polygon points="${pent(c[0], c[1], R * 0.24, ANG[i] + 180)}"/>`).join("");
  const seams = ANG.map((a) => `M ${fmt(pt(cx, cy, R * 0.42, a))} L ${fmt(pt(cx, cy, R * 0.8, a))}`).join(" ");
  return `<g>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="#FFFFFF"/>
    <clipPath id="bclip"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath>
    <g clip-path="url(#bclip)">
      <g fill="${DARK}"><polygon points="${pent(cx, cy, R * 0.42, -90)}"/>${patches}</g>
      <path d="${seams}" fill="none" stroke="${DARK}" stroke-width="${R * 0.12}" stroke-linecap="round"/>
    </g>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#16115E" stroke-opacity="0.14" stroke-width="2"/>
  </g>`;
}

// the ball sits just above the line, near its top end; trail streaks back down-left
const B = [410, yAt(410) - 30], R = 37;
const trail = [[46, 78, 0.9, 9], [40, 72, 0.55, 7], [40, 72, 0.55, 7]].map((t, i) => {
  const off = i === 0 ? 0 : (i === 1 ? 15 : -15);
  const s = along(B[0] + p[0] * off, B[1] + p[1] * off, -t[0]);
  const e = along(B[0] + p[0] * off, B[1] + p[1] * off, -t[1] - 26);
  return `<line x1="${s[0].toFixed(1)}" y1="${s[1].toFixed(1)}" x2="${e[0].toFixed(1)}" y2="${e[1].toFixed(1)}"
     stroke="${AMBER}" stroke-width="${t[3]}" stroke-linecap="round" opacity="${t[2]}"/>`;
}).join("\n  ");

// clip region = everything BELOW the cut line (turns the lower part of "26" amber)
const below = `${fmt([0, yAt(0)])} ${fmt([512, yAt(512)])} 512,512 0,512`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#2A2597"/><stop offset="0.55" stop-color="#4B45E0"/><stop offset="1" stop-color="#6F69FF"/>
    </linearGradient>
    <radialGradient id="spark" cx="0.78" cy="0.32" r="0.6">
      <stop offset="0" stop-color="#FBB034" stop-opacity="0.45"/><stop offset="1" stop-color="#FBB034" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="${AMBER}" flood-opacity="0.6"/>
    </filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="7" stdDeviation="9" flood-color="#140F58" flood-opacity="0.5"/>
    </filter>
    <clipPath id="belowLine"><polygon points="${below}"/></clipPath>
  </defs>

  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <rect width="512" height="512" rx="116" fill="url(#spark)"/>

  <!-- signature: the rising amber cut line, glowing -->
  <line x1="${P1[0]}" y1="${P1[1]}" x2="${P2[0]}" y2="${P2[1]}" stroke="${AMBER}" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="2 24" filter="url(#glow)"/>

  <!-- 26: white above the cut line, amber below it (the line slices the score) -->
  <g filter="url(#soft)">
    <text x="208" y="352" text-anchor="middle" fill="#FFFFFF"
          font-family="'Bricolage Grotesque','Archivo','Helvetica Neue',Arial,sans-serif"
          font-weight="800" font-size="250" letter-spacing="-14">26</text>
  </g>
  <g clip-path="url(#belowLine)">
    <text x="208" y="352" text-anchor="middle" fill="${AMBER}"
          font-family="'Bricolage Grotesque','Archivo','Helvetica Neue',Arial,sans-serif"
          font-weight="800" font-size="250" letter-spacing="-14">26</text>
  </g>

  <!-- football launching off the top of the line, with a motion trail -->
  ${trail}
  <ellipse cx="${B[0]}" cy="${(B[1] + R + 7).toFixed(1)}" rx="${R * 0.8}" ry="${R * 0.18}" fill="#140F58" opacity="0.4"/>
  ${ball(B[0], B[1], R)}
</svg>
`;

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../web/icon.svg");
writeFileSync(out, svg);
console.log(`Wrote ${out}`);
