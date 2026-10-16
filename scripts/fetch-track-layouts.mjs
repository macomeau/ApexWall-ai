#!/usr/bin/env node
/**
 * Fetch REAL circuit layouts from OpenStreetMap (Overpass API) and convert
 * them into RealCircuitDefinition entries for src/lib/circuit-geometries.ts.
 *
 * Method: query highway=raceway ways near the circuit centre, build the
 * node graph, trace the racing loop by heading continuity at junctions
 * (pit lanes diverge at an angle; the circuit runs straightest), score the
 * loop against the known official length, project lat/lon to local metres,
 * resample evenly by distance, detect corners from curvature, and scale
 * into the app's 0-1000 canvas box with north up (canvas y grows south).
 *
 * Data: © OpenStreetMap contributors, ODbL.
 *
 * Usage: node scripts/fetch-track-layouts.mjs [key ...]   (default: all)
 * Writes: scripts/track-layouts-out.json
 */
import fs from "node:fs";
import path from "node:path";

// key, name, country, lat, lon, radius m, official length m (for scoring)
const TRACKS = [
  ["watkinsglen", "Watkins Glen International", "USA", 42.3369, -76.8154, 2400, 5430],
  ["roadamerica", "Road America", "USA", 43.8003, -87.9935, 2800, 6515],
  ["vir", "Virginia International Raceway", "USA", 36.5601, -79.2050, 2600, 5263],
  ["lagunaseca", "WeatherTech Raceway Laguna Seca", "USA", 36.5842, -121.7534, 1800, 3602],
  ["roadatlanta", "Michelin Raceway Road Atlanta", "USA", 34.1489, -83.8168, 2000, 4088],
  ["midohio", "Mid-Ohio Sports Car Course", "USA", 40.6889, -82.6356, 1800, 3862],
  ["barber", "Barber Motorsports Park", "USA", 33.5328, -86.6206, 1800, 3830],
  ["limerock", "Lime Rock Park", "USA", 41.9278, -73.3839, 1400, 2410],
  ["sonoma", "Sonoma Raceway", "USA", 38.1611, -122.4547, 2200, 4050],
  ["bathurst", "Mount Panorama Circuit (Bathurst)", "Australia", -33.4486, 149.5603, 2800, 6213],
  ["nurburgringgp", "Nürburgring GP-Strecke", "Germany", 50.3356, 6.9475, 2600, 5148],
  ["imola", "Autodromo Enzo e Dino Ferrari (Imola)", "Italy", 44.3439, 11.7167, 2400, 4909],
  ["mugello", "Mugello Circuit", "Italy", 43.9975, 11.3719, 2600, 5245],
  ["misano", "Misano World Circuit", "Italy", 43.9614, 12.6839, 1800, 4226],
  ["paulricard", "Circuit Paul Ricard", "France", 43.2506, 5.7917, 2800, 5842],
  ["portimao", "Algarve International Circuit (Portimão)", "Portugal", 37.2322, -8.6306, 2400, 4653],
  ["donington", "Donington Park", "UK", 52.8306, -1.3750, 2000, 4020],
  ["fuji", "Fuji Speedway", "Japan", 35.3714, 138.9272, 2400, 4563],
  ["okayama", "Okayama International Circuit", "Japan", 34.9153, 134.2211, 1800, 3703],
  ["jerez", "Circuito de Jerez", "Spain", 36.7083, -6.0339, 2400, 4428],
  ["assen", "TT Circuit Assen", "Netherlands", 52.9611, 6.5236, 2400, 4555],
  ["detroit", "Detroit Grand Prix (Belle Isle)", "USA", 42.3430, -82.9780, 2400, 3782],
];

const ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];
const only = process.argv.slice(2);
const targets = TRACKS.filter(([k]) => only.length === 0 || only.includes(k));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const ep of ENDPOINTS) {
      try {
        const res = await fetch(ep, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ApexWall-track-layout-fetcher/1.0" },
          body: "data=" + encodeURIComponent(query),
        });
        if (!res.ok) { lastErr = new Error(`${ep} HTTP ${res.status}`); continue; }
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    await sleep(4000 * (attempt + 1));
  }
  throw lastErr || new Error("overpass failed");
}

/* ---------- node graph + heading-continuity loop tracing ---------- */
// ways: [{ ids: number[], pts: [lon,lat][] }] in local METRES already.
function buildGraph(ways) {
  const adj = new Map(); // id -> Map(toId -> true)
  const coord = new Map(); // id -> [x,y]
  const addEdge = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Map());
    adj.get(a).set(b, true);
  };
  for (const w of ways) {
    for (let i = 0; i < w.ids.length; i++) {
      coord.set(w.ids[i], w.pts[i]);
      if (i > 0) { addEdge(w.ids[i - 1], w.ids[i]); addEdge(w.ids[i], w.ids[i - 1]); }
    }
  }
  return { adj, coord };
}

function pathLen(ids, coord) {
  let L = 0;
  for (let i = 1; i < ids.length; i++) {
    const a = coord.get(ids[i - 1]), b = coord.get(ids[i]);
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

/** Walk from a start node/direction, always taking the straightest unused edge. */
function traceLoop(graph, startId, firstId, maxSteps = 20000) {
  const { adj, coord } = graph;
  const usedEdge = new Set();
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const path = [startId, firstId];
  usedEdge.add(ek(startId, firstId));
  let prev = startId, cur = firstId;
  for (let step = 0; step < maxSteps; step++) {
    if (cur === startId) return path;
    const nbrs = [...(adj.get(cur)?.keys() || [])];
    const [px, py] = coord.get(prev), [cx, cy] = coord.get(cur);
    const inAng = Math.atan2(cy - py, cx - px);
    let bestTo = null, bestTurn = Infinity;
    for (const to of nbrs) {
      if (to === prev) continue;
      if (usedEdge.has(ek(cur, to))) continue;
      const [tx, ty] = coord.get(to);
      let d = Math.atan2(ty - cy, tx - cx) - inAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      // penalise immediate backtracking implicitly (to===prev excluded)
      if (Math.abs(d) < bestTurn) { bestTurn = Math.abs(d); bestTo = to; }
    }
    if (bestTo == null) return path; // dead end
    path.push(bestTo);
    usedEdge.add(ek(cur, bestTo));
    prev = cur; cur = bestTo;
  }
  return path;
}

function findBestLoop(ways, expectedLen) {
  const graph = buildGraph(ways);
  const { adj, coord } = graph;
  // Candidate starts: nodes on the longest way.
  const longest = ways.reduce((a, b) => (pathLen(b.ids, coord) > pathLen(a.ids, coord) ? b : a), ways[0]);
  let best = null;
  const starts = new Set();
  for (let i = 0; i < longest.ids.length - 1; i++) { starts.add(i); }
  // Try starts spread along the longest way, both directions.
  const idxs = [...starts].filter((_, k) => k % Math.max(1, Math.floor(longest.ids.length / 6)) === 0);
  for (const i of idxs) {
    for (const dir of [1, -1]) {
      const a = longest.ids[i], b = longest.ids[i + dir];
      if (a == null || b == null) continue;
      const path = traceLoop(graph, a, b);
      if (path.length < 8) continue;
      const closed = path[path.length - 1] === path[0];
      const L = pathLen(path, coord);
      const err = Math.abs(L - expectedLen) / expectedLen;
      const score = (closed ? 0 : 10) + err;
      if (!best || score < best.score) best = { path, closed, L, err, score };
      if (closed && err < 0.02) return best;
    }
  }
  return best;
}

/* ---------- geometry helpers ---------- */
function toMeters(pts, lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return pts.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]);
}

function resample(loopM, N) {
  const pts = loopM.slice();
  if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) pts.push(pts[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const d = (i / N) * total;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const segL = Math.max(1e-9, cum[j + 1] - cum[j]);
    const f = (d - cum[j]) / segL;
    out.push({ dist: Math.round(d * 10) / 10, x: pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, y: pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f });
  }
  return { points: out, total };
}

function detectCorners(points, total) {
  const N = points.length;
  const heads = [];
  for (let i = 0; i < N; i++) {
    const a = points[i], b = points[(i + 1) % N];
    heads.push(Math.atan2(b.y - a.y, b.x - a.x));
  }
  const stepM = total / N;
  const win = Math.max(2, Math.round(120 / stepM));
  const curv = [];
  for (let i = 0; i < N; i++) {
    let dh = heads[(i + win) % N] - heads[(i - win + N) % N];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    curv.push(Math.abs(dh) / (2 * win * stepM));
  }
  const sm = curv.map((_, i) => {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) { s += curv[(i + k + N) % N]; c++; }
    return s / c;
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

/* ---------- main ---------- */
const results = {};
const report = [];
for (const [key, name, country, lat, lon, radius, expected] of targets) {
  try {
    const q = `[out:json][timeout:90];way["highway"="raceway"](around:${radius},${lat},${lon});out geom;`;
    const data = await overpass(q);
    const ways = [];
    for (const el of data.elements || []) {
      if (el.type === "way" && el.geometry && el.nodes?.length === el.geometry.length) {
        ways.push({ ids: el.nodes, pts: toMeters(el.geometry.map((g) => [g.lon, g.lat]), lat, lon) });
      }
    }
    if (!ways.length) { report.push(`${key}: NO raceway ways`); continue; }
    const best = findBestLoop(ways, expected);
    if (!best) { report.push(`${key}: no loop traced (${ways.length} ways)`); continue; }
    const loopM = best.path.map((id) => buildGraph(ways).coord.get(id));
    const { points: rawPts, total } = resample(loopM, 240);
    const canvas = toCanvas(rawPts);
    const corners = detectCorners(canvas, total);
    results[key] = {
      id: key, name, officialDistance: Math.round(total),
      fiaGrade: "Real layout (OpenStreetMap)", country, drsZones: [],
      sectors: [1, 2, 3].map((s) => ({ sector: s, dist: Math.round((total * s) / 3) })),
      points: canvas, corners,
    };
    report.push(`${key}: ways=${ways.length} closed=${best.closed} len=${Math.round(best.L)}m (exp ${expected}, err ${(best.err * 100).toFixed(1)}%) corners=${corners.length}`);
  } catch (e) {
    report.push(`${key}: ERROR ${e.message}`);
  }
  await sleep(1500);
}

const outDir = path.dirname(new URL(import.meta.url).pathname);
fs.writeFileSync(path.join(outDir, "track-layouts-out.json"), JSON.stringify(results, null, 1));
console.log(report.join("\n"));
console.log(`\nwrote ${Object.keys(results).length} layouts`);
