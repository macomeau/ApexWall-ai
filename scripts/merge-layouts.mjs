#!/usr/bin/env node
/**
 * Merge fetched layouts (OSM + TUMFTM outputs) into a TS block ready to
 * splice into src/lib/circuit-geometries.ts (REAL_CIRCUITS entries).
 *
 * QA verdicts (2026-10-16, shapes rendered and eyeballed):
 *  REJECT OSM: vir (traced an unidentifiable 2974m config), midohio
 *   (no-chicane course; Marc's laps use the chicane layout), misano +
 *   jerez + paulricard (fragments / mangled traces).
 *  CONFIG-SPECIFIC: sonoma trace = Cup course (3226m) -> sonomacup;
 *   donington trace = National (3180m) -> doningtonnational.
 *  REJECT TUMFTM: indianapolis (the oval, not the road course).
 *  Nürburgring GP: prefer OSM when present.
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const read = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : {});
const osm = { ...read("track-layouts-out.json"), ...read("track-layouts-laguna.json") };
const tum = read("track-layouts-tum.json");

for (const k of ["vir", "midohio", "misano", "jerez", "paulricard"]) delete osm[k];
if (osm.sonoma) {
  osm.sonomacup = { ...osm.sonoma, id: "sonomacup", name: "Sonoma Raceway (Cup Course)" };
  delete osm.sonoma;
}
if (osm.donington) {
  osm.doningtonnational = { ...osm.donington, id: "doningtonnational", name: "Donington Park (National)" };
  delete osm.donington;
}
delete tum.indianapolis;
if (osm.nurburgringgp && tum.nurburgringgp_tum) delete tum.nurburgringgp_tum;
if (tum.nurburgringgp_tum) { tum.nurburgringgp = tum.nurburgringgp_tum; delete tum.nurburgringgp_tum; }

const merged = { ...tum, ...osm };
const keys = Object.keys(merged).sort();
console.log("merged keys:", keys.join(", "));
const block = keys
  .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(merged[k])},`)
  .join("\n");
fs.writeFileSync(path.join(dir, "track-layouts-block.ts.txt"), block + "\n");
console.log(`wrote block for ${keys.length} circuits`);
