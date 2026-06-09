// Generates web/data/annexC.json — the Round-of-32 slot allocation for the best 8
// third-placed teams (brief §6).
//
//   node scripts/gen-annexc.js
//
// ⚠️  PLACEHOLDER MAPPING. There are C(12,8) = 495 possible combinations of which
// eight groups supply the qualifying third-placed teams. FIFA publishes the OFFICIAL
// allocation chart that maps each combination → which R32 slot each third-placed
// team fills. That chart MUST be transcribed here before going live — the mapping
// below is a deterministic placeholder so the engine + bracket wiring can be built
// and tested. The output file carries `"placeholder": true` and every entry carries
// `"verified": false` so the UI can warn until real data is loaded.
//
// Structure (consumed by engine.annexCSlots):
//   {
//     "placeholder": true,
//     "thirdPlaceSlots": ["r32-1","r32-5","r32-11","r32-13","r32-2","r32-8","r32-10","r32-16"],
//     "combinations": {
//       "ABCDEFGH": { "A": "r32-1", "B": "r32-5", ... }   // group letter -> R32 slot
//     }
//   }

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = pathResolve(__dirname, "../web/data/annexC.json");

const GROUPS = ["A","B","C","D","E","F","G","H","I","J","K","L"];

// The eight R32 match slots that are filled by third-placed teams (the other 24 R32
// places are group winners/runners-up). These slot ids match scripts/gen-mock.js.
const THIRD_SLOTS = ["r32-2","r32-3","r32-5","r32-8","r32-10","r32-11","r32-13","r32-16"];

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const [head, ...tail] = arr;
  const withHead = combinations(tail, k - 1).map((c) => [head, ...c]);
  const withoutHead = combinations(tail, k);
  return [...withHead, ...withoutHead];
}

const combos = combinations(GROUPS, 8);
const out = { placeholder: true, verified: false, thirdPlaceSlots: THIRD_SLOTS, combinations: {} };

for (const combo of combos) {
  const sorted = [...combo].sort();
  const key = sorted.join("");
  // PLACEHOLDER rule: assign the sorted qualifying groups to the eight third-place
  // slots in order. Deterministic and reversible, but NOT FIFA's real allocation.
  const mapping = {};
  sorted.forEach((g, i) => (mapping[g] = THIRD_SLOTS[i]));
  out.combinations[key] = mapping;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT} — ${combos.length} combinations (placeholder mapping).`);
