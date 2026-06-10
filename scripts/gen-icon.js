// Generates web/icon.svg — the PWA / home-screen icon.
//   node scripts/gen-icon.js
//
// USA-host flag motif, split on the diagonal: a blue field with a white star on one
// half, red/white stripes on the other, a bold seam line through, the football top
// right, and a heavy angled "26". Bold and flat like a real app icon. The flag bleeds
// to the corners (safe to crop); the 26 / ball / star stay inside the mask safe zone.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BLUE = "#2B2D8E", RED = "#C8102E", NAVY = "#16164F";

// 5-point star, pointing up
function star(cx, cy, Ro) {
  const Ri = Ro * 0.382, pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? Ri : Ro, a = (-90 + i * 36) * Math.PI / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

// football
const ANG = [-90, -18, 54, 126, 198];
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
const fmt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
const pent = (cx, cy, r, s) => ANG.map((_, k) => fmt(pt(cx, cy, r, s + k * 72))).join(" ");
function ball(cx, cy, R) {
  const rim = ANG.map((a) => pt(cx, cy, R, a));
  const patches = rim.map((c, i) => `<polygon points="${pent(c[0], c[1], R * 0.24, ANG[i] + 180)}"/>`).join("");
  const seams = ANG.map((a) => `M ${fmt(pt(cx, cy, R * 0.42, a))} L ${fmt(pt(cx, cy, R * 0.8, a))}`).join(" ");
  return `<g>
    <ellipse cx="${cx}" cy="${cy + R + 6}" rx="${R * 0.85}" ry="${R * 0.18}" fill="${NAVY}" opacity="0.35"/>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="#FFFFFF"/>
    <clipPath id="bclip"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath>
    <g clip-path="url(#bclip)">
      <g fill="${NAVY}"><polygon points="${pent(cx, cy, R * 0.42, -90)}"/>${patches}</g>
      <path d="${seams}" fill="none" stroke="${NAVY}" stroke-width="${R * 0.12}" stroke-linecap="round"/>
    </g>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${NAVY}" stroke-opacity="0.15" stroke-width="2"/>
  </g>`;
}

// red/white stripes (drawn full-width, clipped to the upper-right triangle)
const STRIPE = 66;
let stripes = "";
for (let i = 0; i < 8; i++) stripes += `<rect x="0" y="${i * STRIPE}" width="512" height="${STRIPE}" fill="${i % 2 ? "#FFFFFF" : RED}"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#34369C"/><stop offset="1" stop-color="#23246F"/>
    </linearGradient>
    <clipPath id="card"><rect width="512" height="512" rx="116"/></clipPath>
    <clipPath id="stripeTri"><polygon points="0,0 512,0 512,512"/></clipPath>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="${NAVY}" flood-opacity="0.55"/>
    </filter>
  </defs>

  <g clip-path="url(#card)">
    <!-- blue field (lower-left) -->
    <rect width="512" height="512" fill="url(#blue)"/>
    <!-- red/white stripes (upper-right triangle) -->
    <g clip-path="url(#stripeTri)">${stripes}</g>
    <!-- bold diagonal seam through -->
    <line x1="-10" y1="-10" x2="522" y2="522" stroke="#FFFFFF" stroke-width="16"/>
    <line x1="-10" y1="-10" x2="522" y2="522" stroke="${NAVY}" stroke-opacity="0.18" stroke-width="20"/>
    <line x1="-10" y1="-10" x2="522" y2="522" stroke="#FFFFFF" stroke-width="16"/>

    <!-- white star on the blue half -->
    <polygon points="${star(150, 196, 60)}" fill="#FFFFFF" filter="url(#lift)"/>

    <!-- heavy, angled 26 anchored toward the bottom -->
    <g filter="url(#lift)">
      <text x="250" y="380" text-anchor="middle" transform="rotate(15 250 360)"
            font-family="'Bricolage Grotesque','Archivo Black','Helvetica Neue',Arial,sans-serif"
            font-weight="900" font-size="208" letter-spacing="-10"
            fill="#FFFFFF" stroke="${NAVY}" stroke-width="5" paint-order="stroke">26</text>
    </g>

    <!-- football, top right on the stripes -->
    ${ball(372, 150, 37)}
  </g>
</svg>
`;

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../web/icon.svg");
writeFileSync(out, svg);
console.log(`Wrote ${out}`);
