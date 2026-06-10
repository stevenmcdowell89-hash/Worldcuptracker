// Generates web/icon.svg — the PWA / home-screen icon (brief §9: indigo is chrome).
//   node scripts/gen-icon.js
// A clean soccer-ball mark on an indigo field. Geometry is computed so the pentagon
// pattern is regular, and all content sits inside the maskable safe zone (centre 80%)
// so Android's icon masks never clip it.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const C = 256;            // canvas centre (512×512 viewBox)
const R_BALL = 140;       // ball radius (Ø280 = 55% of canvas — well inside the safe zone)
const R_PENT = 58;        // central pentagon circumradius
const R_RIM = 140;        // distance of the rim patches from centre (on the ball edge)
const R_PATCH = 33;       // rim-patch pentagon radius
const DARK = "#2A2597";   // deep indigo for the patches/seams (reads on white)

const ANGLES = [-90, -18, 54, 126, 198];                 // the five pentagon directions
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
const fmt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
const pentagon = (cx, cy, r, start) => ANGLES.map((_, k) => fmt(pt(cx, cy, r, start + k * 72))).join(" ");

const central = pentagon(C, C, R_PENT, -90);
const rimCenters = ANGLES.map((a) => pt(C, C, R_RIM, a));
const rimPents = rimCenters.map((c, i) => pentagon(c[0], c[1], R_PATCH, ANGLES[i] + 180));   // vertex points inward
// seams: each central-pentagon vertex out to its rim patch, plus the ring joining the rim patches
const seams = ANGLES.map((a) => `M ${fmt(pt(C, C, R_PENT, a))} L ${fmt(pt(C, C, R_RIM - R_PATCH * 0.7, a))}`).join(" ");
const ring = `M ${rimCenters.map(fmt).join(" L ")} Z`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4B45E0"/><stop offset="1" stop-color="#322CB0"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.7" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E8E9FB"/>
    </radialGradient>
    <clipPath id="ball"><circle cx="${C}" cy="${C}" r="${R_BALL}"/></clipPath>
  </defs>

  <rect width="512" height="512" rx="112" fill="url(#bg)"/>

  <!-- soft drop shadow under the ball -->
  <ellipse cx="${C}" cy="${C + 150}" rx="120" ry="26" fill="#1A1670" opacity="0.35"/>

  <!-- ball -->
  <circle cx="${C}" cy="${C}" r="${R_BALL}" fill="url(#shine)"/>
  <g clip-path="url(#ball)" fill="${DARK}">
    <polygon points="${central}"/>
    ${rimPents.map((p) => `<polygon points="${p}"/>`).join("\n    ")}
  </g>
  <g clip-path="url(#ball)" fill="none" stroke="${DARK}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
    <path d="${seams}"/>
    <path d="${ring}" stroke-width="6"/>
  </g>
  <circle cx="${C}" cy="${C}" r="${R_BALL}" fill="none" stroke="#1A1670" stroke-opacity="0.12" stroke-width="2"/>
</svg>
`;

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../web/icon.svg");
writeFileSync(out, svg);
console.log(`Wrote ${out}`);
