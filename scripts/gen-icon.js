// Generates web/icon.svg — the PWA / home-screen icon.
//   node scripts/gen-icon.js
//
// Concept: a lean "26" on the indigo brand field, with the app's signature amber
// dashed CUT LINE slashing through behind the numerals, and a football resting on the
// line to the right (the cut line as the ball's trajectory). Ties brand + USP + sport.
// All content sits inside Android's maskable safe zone (centre ~80%).
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AMBER = "#F7A52B";
const DARK = "#2A2597";          // pentagon patches (deep indigo, reads on the white ball)

// ── football: white ball with a regular pentagon pattern, clipped to its circle ──
const ANGLES = [-90, -18, 54, 126, 198];
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
const fmt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
const pentagon = (cx, cy, r, start) => ANGLES.map((_, k) => fmt(pt(cx, cy, r, start + k * 72))).join(" ");

function ball(cx, cy, R, id) {
  const rim = ANGLES.map((a) => pt(cx, cy, R, a));
  const central = pentagon(cx, cy, R * 0.42, -90);
  const patches = rim.map((c, i) => `<polygon points="${pentagon(c[0], c[1], R * 0.24, ANGLES[i] + 180)}"/>`).join("");
  const seams = ANGLES.map((a) => `M ${fmt(pt(cx, cy, R * 0.42, a))} L ${fmt(pt(cx, cy, R * 0.78, a))}`).join(" ");
  const ring = `M ${rim.map(fmt).join(" L ")} Z`;
  return `
  <g>
    <ellipse cx="${cx}" cy="${cy + R + 10}" rx="${R * 0.85}" ry="${R * 0.2}" fill="#16115E" opacity="0.45"/>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="#FFFFFF"/>
    <clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath>
    <g clip-path="url(#${id})">
      <g fill="${DARK}"><polygon points="${central}"/>${patches}</g>
      <g fill="none" stroke="${DARK}" stroke-width="${R * 0.13}" stroke-linecap="round" stroke-linejoin="round">
        <path d="${seams}"/><path d="${ring}" stroke-width="${R * 0.1}"/>
      </g>
    </g>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#16115E" stroke-opacity="0.12" stroke-width="2"/>
  </g>`;
}

const CUT_Y = 296;               // the cut line crosses the lower third of the numerals
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5650F0"/><stop offset="1" stop-color="#322CB0"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-60%" width="140%" height="220%">
      <feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="${AMBER}" flood-opacity="0.55"/>
    </filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#15116A" flood-opacity="0.45"/>
    </filter>
  </defs>

  <rect width="512" height="512" rx="116" fill="url(#bg)"/>

  <!-- signature: amber dashed cut line, behind the numerals -->
  <line x1="70" y1="${CUT_Y}" x2="442" y2="${CUT_Y}" stroke="${AMBER}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="2 26" filter="url(#glow)"/>

  <!-- the lean 26, drawn over the cut line so the line reads as passing behind it -->
  <g filter="url(#soft)">
    <text x="224" y="350" text-anchor="middle" fill="#FFFFFF"
          font-family="'Bricolage Grotesque','Archivo','Helvetica Neue',Arial,sans-serif"
          font-weight="700" font-size="240" letter-spacing="-12">26</text>
  </g>

  <!-- football resting on the cut line, to the right -->
  ${ball(392, CUT_Y, 38, "b1")}
</svg>
`;

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../web/icon.svg");
writeFileSync(out, svg);
console.log(`Wrote ${out}`);
