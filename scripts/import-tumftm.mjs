#!/usr/bin/env node
/**
 * Import circuit centerlines from the TUMFTM racetrack-database
 * (github.com/TUMFTM/racetrack-database, LGPL-3.0; centerlines created by
 * TUMFTM from map data) into RealCircuitDefinition entries.
 * Expects CSVs in /tmp/tum/<Name>.csv (tracks/*.csv: x_m, y_m, widths).
 * Writes scripts/track-layouts-tum.json (merged with the OSM output later).
 */
import fs from "node:fs";
import path from "node:path";

// csv name, app key, display name, country
const MAP = [
  ["Budapest", "hungaroring", "Hungaroring", "Hungary"],
  ["Hockenheim", "hockenheim", "Hockenheimring", "Germany"],
  ["IMS", "indianapolis", "Indianapolis Motor Speedway (Road Course)", "USA"],
  ["Montreal", "montreal", "Circuit Gilles Villeneuve (Montreal)", "Canada"],
  ["Sepang", "sepang", "Sepang International Circuit", "Malaysia"],
  ["Shanghai", "shanghai", "Shanghai International Circuit", "China"],
  ["YasMarina", "yasmarina", "Yas Marina Circuit", "UAE"],
  ["Melbourne", "melbourne", "Albert Park Circuit (Melbourne)", "Australia"],
  ["MexicoCity", "mexicocity", "Autódromo Hermanos Rodríguez", "Mexico"],
  ["Sakhir", "sakhir", "Bahrain International Circuit (Sakhir)", "Bahrain"],
  ["Sochi", "sochi", "Sochi Autodrom", "Russia"],
  ["MoscowRaceway", "moscowraceway", "Moscow Raceway", "Russia"],
  ["Norisring", "norisring", "Norisring", "Germany"],
  ["Oschersleben", "oschersleben", "Motorsport Arena Oschersleben", "Germany"],
  ["Nuerburgring", "nurburgringgp_tum", "Nürburgring (TUMFTM)", "Germany"],
];

function resample(pts, N) {
  const p = pts.slice();
  const first = p[0], last = p[p.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1) p.push(first);
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const d = (i / N) * total;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const segL = Math.max(1e-9, cum[j + 1] - cum[j]);
    const f = (d - cum[j]) / segL;
    out.push({ dist: Math.round(d * 10) / 10, x: p[j][0] + (p[j + 1][0] - p[j][0]) * f, y: p[j][1] + (p[j + 1][1] - p[j][1]) * f });
  }
  return { points: out, total };
}

function detectCorners(points, total) {
  const N = points.length;
  const heads = points.map((a, i) => {
    const b = points[(i + 1) % N];
    return Math.atan2(b.y - a.y, b.x - a.x);
  });
  const stepM = total / N;
  const win = Math.max(2, Math.round(120 / stepM));
  const curv = heads.map((_, i) => {
    let dh = heads[(i + win) % N] - heads[(i - win + N) % N];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return Math.abs(dh) / (2 * win * stepM);
  });
  const sm = curv.map((_, i) => {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += curv[(i + k + N) % N];
    return s / 5;
  });
  const minGap = Math.max(6, Math.round(220 / stepM));
  const idx = sm.map((v, i) => [v, i]).filter(([v]) => v > 0.0009).sort((a, b) => b[0] - a[0]);
  const chosen = [];
  for (const [, i] of idx) {
    if (chosen.every((c) => Math.min(Math.abs(c - i), N - Math.abs(c - i)) > minGap)) chosen.push(i);
    if (chosen.length >= 16) break;
  }
  chosen.sort((a, b) => a - b);
  return chosen.map((i, n) => ({
    name: `Turn ${n + 1}`, shortName: `T${n + 1}`,
    dist: Math.round(points[i].dist),
    x: Math.round(points[i].x * 10) / 10, y: Math.round(points[i].y * 10) / 10,
  }));
}

function toCanvas(points) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const range = Math.max(maxX - minX, maxY - minY, 1);
  const pad = 60, usable = 1000 - pad * 2;
  const s = usable / range;
  const ox = pad + (usable - (maxX - minX) * s) / 2;
  const oy = pad + (usable - (maxY - minY) * s) / 2;
  return points.map((p) => ({
    dist: p.dist,
    x: Math.round((ox + (p.x - minX) * s) * 10) / 10,
    y: Math.round((oy + (maxY - p.y) * s) * 10) / 10,
  }));
}

const out = {};
const report = [];
for (const [csv, key, name, country] of MAP) {
  const file = `/tmp/tum/${csv}.csv`;
  if (!fs.existsSync(file)) { report.push(`${key}: missing csv`); continue; }
  const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  const pts = rows.map((l) => l.split(",").map(Number)).filter((r) => r.length >= 2 && isFinite(r[0]) && isFinite(r[1])).map((r) => [r[0], r[1]]);
  if (pts.length < 50) { report.push(`${key}: only ${pts.length} pts`); continue; }
  const { points: raw, total } = resample(pts, 240);
  const canvas = toCanvas(raw);
  const corners = detectCorners(canvas, total);
  out[key] = {
    id: key, name, officialDistance: Math.round(total),
    fiaGrade: "Real layout (TUMFTM racetrack-database)", country, drsZones: [],
    sectors: [1, 2, 3].map((s) => ({ sector: s, dist: Math.round((total * s) / 3) })),
    points: canvas, corners,
  };
  report.push(`${key}: pts=${pts.length} len=${Math.round(total)}m corners=${corners.length}`);
}
const outDir = path.dirname(new URL(import.meta.url).pathname);
fs.writeFileSync(path.join(outDir, "track-layouts-tum.json"), JSON.stringify(out, null, 1));
console.log(report.join("\n"));
console.log(`wrote ${Object.keys(out).length} TUMFTM layouts`);
