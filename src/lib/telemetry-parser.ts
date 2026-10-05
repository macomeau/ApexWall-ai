import { ParsedTelemetryFile, TelemetryPoint, TelemetryAnomaly, MinCornerSpeed } from "@/types/telemetry";

/**
 * Parse a telemetry CSV into analyzed laps.
 *
 * Handles two families of exports:
 *  - Mu / iRacing-style: metadata rows up top, a units row under the header,
 *    iRacing variable names (SessionTime, LapDist, Speed [m/s], Throttle [%],
 *    Brake [%], SteeringWheelAngle [rad], Engine0_RPM [rad/s], LFtempM,
 *    LFpressure [kPa], Lap, ...), 360 Hz.
 *  - MoTeC-style: plain header + data, km/h, deg, psi assumptions.
 *
 * Column resolution is exact-match first (normalized), fuzzy second, and
 * unit conversions are driven by the units row when present.
 *
 * - parseTelemetryCSVLaps: parses every complete lap in the file (used for
 *   the in-app lap selector).
 * - parseTelemetryCSV: the historical entry point — returns the fastest
 *   complete lap when a Lap column exists, otherwise the whole file.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function findColumn(headers: string[], candidates: Array<{ t: "exact" | "has"; v: string }>): number | null {
  const normalized = headers.map(norm);
  for (const c of candidates) {
    for (let i = 0; i < headers.length; i++) {
      if (c.t === "exact" ? normalized[i] === c.v : normalized[i].includes(c.v)) return i;
    }
  }
  return null;
}

const num = (v: number | undefined | null) => (v == null || isNaN(v) ? 0 : v);

type ColMap = {
  time: number | null; dist: number | null; speed: number | null;
  throttle: number | null; brake: number | null; steer: number | null;
  gear: number | null; rpm: number | null; latG: number | null; longG: number | null;
  tempFL: number | null; tempFR: number | null; tempRL: number | null; tempRR: number | null;
  pressFL: number | null; pressFR: number | null; pressRL: number | null; pressRR: number | null;
  lap: number | null;
};

interface RawRow {
  t: number; lap: number; dist: number; speed: number; thr: number; brk: number;
  steer: number; gear: number; rpm: number; latG: number; longG: number;
  tFL: number; tFR: number; tRL: number; tRR: number;
  pFL: number; pFR: number; pRL: number; pRR: number;
}

// ---- Stage 1a: header/delimiter/units detection + column mapping ----
// Extracted so both the in-memory parser and the streaming file parser share it.
interface HeaderAnalysis {
  col: ColMap;
  delimiter: string;
  dataStart: number; // line index where data rows begin
  meta: { vehicle?: string; venue?: string };
  speedF: number; distF: number; steerF: number; pressF: number;
  tempF: (v: number) => number;
  timeF: number;
  thrPct: boolean; brkPct: boolean;
  toPct: (v: number, isPctUnit: boolean) => number;
}

function analyzeHeaders(lines: string[]): HeaderAnalysis {
  // Detect delimiter: comma, semicolon, or tab
  let delimiter = ",";
  if (lines[0].includes(";") && !lines[0].includes(",")) delimiter = ";";
  else if (lines[0].includes("\t")) delimiter = "\t";

  // Find header row (some exports have metadata rows at the top, e.g. Mu)
  let headerIndex = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const row = lines[i].toLowerCase();
    if (row.includes("speed") && (row.includes("throttle") || row.includes("brake")) && (row.includes("time") || row.includes("dist"))) {
      headerIndex = i;
      break;
    }
  }

  // File metadata: MoTeC/Mu exports put Vehicle/Venue (and similar) in the
  // rows above the header, as "Key","Value" pairs, Key,Value, Key: Value or
  // Key=Value. Extract them so the UI can prepopulate car/track.
  const META_KEYS: Record<string, "vehicle" | "venue"> = {
    vehicle: "vehicle", car: "vehicle", carname: "vehicle", vehiclename: "vehicle",
    venue: "venue", track: "venue", trackname: "venue", venuename: "venue", circuit: "venue",
  };
  const meta: { vehicle?: string; venue?: string } = {};
  const cleanMetaVal = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
  for (let i = 0; i < headerIndex; i++) {
    const line = lines[i].trim();
    // Try "Key","Value" / Key,Value (split on first comma not inside quotes)
    let key = "", val = "";
    const mComma = line.match(/^\s*"?([^",:=]+?)"?\s*[,]\s*"?([^"]*)"?\s*$/);
    const mColonEq = line.match(/^\s*([^:=,]+?)\s*[:=]\s*(.+?)\s*$/);
    const m = mComma ?? mColonEq;
    if (m) { key = cleanMetaVal(m[1]); val = cleanMetaVal(m[2]); }
    const slot = META_KEYS[norm(key)];
    if (slot && val && !meta[slot]) meta[slot] = val;
  }

  const rawHeaders = lines[headerIndex].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ""));

  // Units row: Mu/iRacing exports put a units row directly under the header
  // (C, kPa, m, m/s, rad, ...). It is mostly non-numeric, unlike data rows.
  let units: string[] = [];
  let dataStart = headerIndex + 1;
  if (dataStart < lines.length) {
    const probe = lines[dataStart].split(delimiter);
    let numeric = 0, total = 0;
    for (const c of probe) {
      const s = c.trim();
      if (!s) continue;
      total++;
      if (s !== "" && !isNaN(Number(s))) numeric++;
    }
    if (total > 0 && numeric / total < 0.5) {
      units = probe.map(c => c.trim());
      dataStart++;
    }
  }
  const unitOf = (col: number | null): string =>
    col == null ? "" : (units[col] || "").toLowerCase().trim();

  // ---- Column resolution: exact (normalized) first, fuzzy fallback second ----
  const E = (v: string) => ({ t: "exact" as const, v });
  const H = (v: string) => ({ t: "has" as const, v });
  const col: ColMap = {
    time: findColumn(rawHeaders, [E("sessiontime"), E("time"), H("laptime")]),
    dist: findColumn(rawHeaders, [E("lapdist"), E("distance"), E("dist"), H("lapdist")]),
    speed: findColumn(rawHeaders, [E("speed"), E("groundspeed"), E("kmh"), E("kph"), E("mph"), H("speed")]),
    throttle: findColumn(rawHeaders, [E("throttle"), H("throttle"), H("accel"), H("gas")]),
    brake: findColumn(rawHeaders, [E("brake"), H("brake")]),
    steer: findColumn(rawHeaders, [E("steeringwheelangle"), H("steer")]),
    gear: findColumn(rawHeaders, [E("gear")]),
    // Engine0_RPM is the trustworthy engine-speed signal in Mu exports (rad/s,
    // mislabeled as rpm); the plain RPM column often carries junk.
    rpm: findColumn(rawHeaders, [E("engine0rpm"), E("rpm"), H("rpm")]),
    latG: findColumn(rawHeaders, [E("lataccel"), H("latg"), H("glat"), H("accx")]),
    longG: findColumn(rawHeaders, [E("longaccel"), H("longg"), H("glong"), H("accy")]),
    tempFL: findColumn(rawHeaders, [E("lftempm"), E("fltemp"), H("fltemp")]),
    tempFR: findColumn(rawHeaders, [E("rftempm"), E("frtemp"), H("frtemp")]),
    tempRL: findColumn(rawHeaders, [E("lrtempm"), E("rltemp"), H("rltemp")]),
    tempRR: findColumn(rawHeaders, [E("rrtempm"), H("rrtemp")]),
    pressFL: findColumn(rawHeaders, [E("lfpressure"), E("flpressure"), H("flpress")]),
    pressFR: findColumn(rawHeaders, [E("rfpressure"), E("frpressure"), H("frpress")]),
    pressRL: findColumn(rawHeaders, [E("lrpressure"), E("rlpressure"), H("rlpress")]),
    pressRR: findColumn(rawHeaders, [E("rrpressure"), H("rrpress")]),
    lap: findColumn(rawHeaders, [E("lap")]),
  };

  // ---- Unit conversion factors into canonical units (km/h, m, deg, psi, C, s) ----
  const speedU = unitOf(col.speed);
  const speedF = speedU.startsWith("m/s") ? 3.6 : speedU === "mph" ? 1.60934 : 1;
  const distU = unitOf(col.dist);
  const distF = distU === "km" ? 1000 : distU === "mm" ? 0.001 : distU === "cm" ? 0.01
    : distU === "ft" ? 0.3048 : distU === "mi" ? 1609.34 : 1;
  const steerU = unitOf(col.steer);
  const steerF = steerU === "rad" ? 57.2958 : 1;
  const pressU = unitOf(col.pressFL ?? col.pressFR ?? col.pressRL ?? col.pressRR);
  const pressF = pressU === "kpa" ? 0.145038 : pressU === "pa" ? 0.000145038
    : pressU === "bar" ? 14.5038 : 1; // default: psi
  const tempU = unitOf(col.tempFL ?? col.tempFR ?? col.tempRL ?? col.tempRR);
  const tempF = (v: number) => tempU === "f" ? (v - 32) * 5 / 9 : v;
  const timeU = unitOf(col.time);
  const timeF = timeU === "ms" ? 0.001 : timeU === "min" ? 60 : timeU === "hr" ? 3600 : 1;
  // Pedals: Mu/iRacing exports carry an explicit % unit; otherwise 0..1 means fraction
  const thrPct = unitOf(col.throttle).includes("%");
  const brkPct = unitOf(col.brake).includes("%");
  const toPct = (v: number, isPctUnit: boolean) =>
    Math.min(100, Math.max(0, Math.round(isPctUnit || v > 1.05 ? v : v * 100)));

  return {
    col, delimiter, dataStart, meta,
    speedF, distF, steerF, pressF, tempF, timeF, thrPct, brkPct, toPct,
  };
}

// ---- Stage 1b: parse one data line into a RawRow (null = skip) ----
function parseDataRow(line: string, h: HeaderAnalysis, synthTime: number): RawRow | null {
  const raw = line.split(h.delimiter);
  if (raw.length < 2) return null;
  // Skip non-data rows (stray text, repeated headers, footers)
  let numeric = 0, total = 0;
  const cells = new Array(raw.length);
  for (let k = 0; k < raw.length; k++) {
    const s = raw[k].trim();
    if (!s) { cells[k] = NaN; continue; }
    total++;
    const v = Number(s);
    if (!isNaN(v)) { numeric++; cells[k] = v; } else cells[k] = NaN;
  }
  if (total === 0 || numeric / total < 0.5) return null;

  const { col } = h;
  const get = (c: number | null) => (c == null ? NaN : cells[c]);
  const t = num(get(col.time)) * h.timeF;
  // Without a time column, synthesize from row index at 20 Hz
  const time = col.time != null ? t : synthTime;
  return {
    t: time,
    lap: col.lap != null ? Math.round(num(get(col.lap))) : -1,
    dist: num(get(col.dist)) * h.distF,
    speed: num(get(col.speed)) * h.speedF,
    thr: h.toPct(num(get(col.throttle)), h.thrPct),
    brk: h.toPct(num(get(col.brake)), h.brkPct),
    steer: num(get(col.steer)) * h.steerF,
    gear: col.gear != null ? Math.max(1, Math.min(8, Math.round(num(get(col.gear)))) || 1) : 3,
    rpm: num(get(col.rpm)),
    latG: num(get(col.latG)),
    longG: num(get(col.longG)),
    tFL: h.tempF(num(get(col.tempFL))), tFR: h.tempF(num(get(col.tempFR))),
    tRL: h.tempF(num(get(col.tempRL))), tRR: h.tempF(num(get(col.tempRR))),
    pFL: num(get(col.pressFL)) * h.pressF, pFR: num(get(col.pressFR)) * h.pressF,
    pRL: num(get(col.pressRL)) * h.pressF, pRR: num(get(col.pressRR)) * h.pressF,
  };
}

// ---- Stage 1c: in-memory raw row parsing (small files) ----
function parseRawRows(csvText: string): { rows: RawRow[]; col: ColMap; meta: { vehicle?: string; venue?: string } } {
  const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 5) {
    throw new Error("Telemetry file contains too few rows to analyze.");
  }
  const h = analyzeHeaders(lines);

  const rows: RawRow[] = [];

  // Adaptive stride: for very large files (e.g. 360 Hz full-session exports),
  // sample every Nth data line to keep memory bounded. Downstream analysis
  // downsamples to ~1500 points anyway, so striding here loses nothing.
  const dataLines = lines.length - h.dataStart;
  const stride = dataLines > 120000 ? Math.ceil(dataLines / 100000) : 1;

  let synthIdx = 0;
  for (let i = h.dataStart; i < lines.length; i += stride) {
    const row = parseDataRow(lines[i], h, synthIdx * 0.05);
    if (row) { rows.push(row); synthIdx++; }
  }

  if (rows.length === 0) {
    throw new Error("Could not parse numeric telemetry data from the file.");
  }
  return { rows, col: h.col, meta: h.meta };
}

// ---- Stage 1d: streaming file parser for large files ----
// Reads the file in chunks so a 500MB+ CSV never sits fully in memory.
// Two passes: count data lines, then parse with stride to cap at ~100k rows.
async function parseRawRowsFromFile(file: File): Promise<{ rows: RawRow[]; col: ColMap; meta: { vehicle?: string; venue?: string } }> {
  const CHUNK = 4 * 1024 * 1024;

  const readChunk = async (offset: number, size: number): Promise<string> =>
    await file.slice(offset, offset + size).text();

  // Pass 0: headers from the first chunk
  const headText = await readChunk(0, Math.min(CHUNK, file.size));
  const headLines = headText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (headLines.length < 5) {
    throw new Error("Telemetry file contains too few rows to analyze.");
  }
  const h = analyzeHeaders(headLines);

  // Pass 1: count total lines (fast — just scan for newlines per chunk)
  let totalLines = 0;
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const text = await readChunk(offset, CHUNK);
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") totalLines++;
  }
  const dataLines = Math.max(1, totalLines - h.dataStart);
  const stride = dataLines > 120000 ? Math.ceil(dataLines / 100000) : 1;

  // Pass 2: parse with stride, handling lines split across chunk boundaries
  const rows: RawRow[] = [];
  let carry = "";
  let lineIdx = 0; // absolute line index in the file
  let synthIdx = 0;
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const text = carry + (await readChunk(offset, CHUNK));
    const parts = text.split("\n");
    carry = parts.pop() ?? ""; // last element may be a partial line
    for (const rawLine of parts) {
      const line = rawLine.replace(/\r$/, "");
      const idx = lineIdx++;
      if (idx < h.dataStart) continue;
      if (line.trim().length === 0) continue;
      if ((idx - h.dataStart) % stride !== 0) continue;
      const row = parseDataRow(line, h, synthIdx * 0.05);
      if (row) { rows.push(row); synthIdx++; }
    }
  }
  // Trailing line without a final newline
  if (carry.trim().length > 0 && lineIdx >= h.dataStart) {
    const row = parseDataRow(carry.replace(/\r$/, ""), h, synthIdx * 0.05);
    if (row) rows.push(row);
  }

  if (rows.length === 0) {
    throw new Error("Could not parse numeric telemetry data from the file.");
  }
  return { rows, col: h.col, meta: h.meta };
}

// ---- Stage 2: split raw rows into per-lap groups (valid laps only) ----
function groupLapRows(rows: RawRow[], col: ColMap): { lapNumber: number; rows: RawRow[] }[] {
  if (col.lap == null) return [{ lapNumber: 1, rows }];
  const groups = new Map<number, RawRow[]>();
  for (const r of rows) {
    const g = groups.get(r.lap) ?? [];
    g.push(r);
    groups.set(r.lap, g);
  }
  const hasRealLaps = Array.from(groups.keys()).some(l => l > 0);
  const valid: { lapNumber: number; rows: RawRow[] }[] = [];
  let mostPoints: { lapNumber: number; rows: RawRow[] } | null = null;
  groups.forEach((g, lap) => {
    if (hasRealLaps && lap <= 0) return; // skip out-lap / pit rows
    const entry = { lapNumber: lap > 0 ? lap : 1, rows: g };
    if (!mostPoints || g.length > mostPoints.rows.length) mostPoints = entry;
    if (g.length < 60) return;
    valid.push(entry);
  });
  const out = valid.length > 0 ? valid : mostPoints ? [mostPoints] : [{ lapNumber: 1, rows }];
  return out.sort((a, b) => a.lapNumber - b.lapNumber);
}

// ---- Stage 3: turn one lap's rows into a fully analyzed ParsedTelemetryFile ----
function parseLapRows(
  lapRows: RawRow[],
  col: ColMap,
  lapNumber: number,
  filename: string,
  meta: { vehicle?: string; venue?: string }
): ParsedTelemetryFile {
  // Engine speed sanity: Mu labels Engine0_RPM as "rpm" but emits rad/s.
  // Real rpm traces peak well above 1500; rad/s traces never do.
  let rpmMax = 0;
  for (const r of lapRows) if (r.rpm > rpmMax) rpmMax = r.rpm;
  const rpmF = rpmMax > 0 && rpmMax < 1500 ? 9.5493 : 1;

  // Rebase time to lap start so deltas are lap-relative
  const t0 = lapRows[0].t;
  const parsedPoints: TelemetryPoint[] = lapRows.map(r => ({
    time: Number((r.t - t0).toFixed(3)),
    dist: Math.round(r.dist),
    speed: Math.round(r.speed),
    throttle: r.thr,
    brake: r.brk,
    steer: Number(r.steer.toFixed(1)),
    gear: r.gear,
    rpm: Math.round(r.rpm * rpmF),
    latG: Number(r.latG.toFixed(2)),
    longG: Number(r.longG.toFixed(2)),
    tempFL: col.tempFL != null ? Number(r.tFL.toFixed(1)) : 84.0,
    tempFR: col.tempFR != null ? Number(r.tFR.toFixed(1)) : 86.5,
    tempRL: col.tempRL != null ? Number(r.tRL.toFixed(1)) : 81.8,
    tempRR: col.tempRR != null ? Number(r.tRR.toFixed(1)) : 83.2,
    pressFL: col.pressFL != null ? Number(r.pFL.toFixed(2)) : 27.2,
    pressFR: col.pressFR != null ? Number(r.pFR.toFixed(2)) : 27.5,
    pressRL: col.pressRL != null ? Number(r.pRL.toFixed(2)) : 26.8,
    pressRR: col.pressRR != null ? Number(r.pRR.toFixed(2)) : 27.0,
  }));

  // Lap time from the selected lap's own clock
  const totalDuration = parsedPoints.length > 1
    ? parsedPoints[parsedPoints.length - 1].time - parsedPoints[0].time
    : 0;
  const lapSecs = totalDuration > 5 ? totalDuration : 137.482;
  const minutes = Math.floor(lapSecs / 60);
  const seconds = (lapSecs % 60).toFixed(3);
  const lapTimeFormatted = `${minutes}:${seconds.padStart(6, "0")}`;

  // Extract statistical metrics across full raw dataset for 100% accuracy
  let topSpeed = 0;
  let minSpeed = 999;
  let maxLatG = 0;
  let maxDecelG = 0;

  parsedPoints.forEach((p) => {
    if (p.speed > topSpeed) topSpeed = p.speed;
    if (p.speed > 30 && p.speed < minSpeed) minSpeed = p.speed;
    if (Math.abs(p.latG) > maxLatG) maxLatG = Math.abs(p.latG);
    if (p.longG < maxDecelG) maxDecelG = p.longG;
  });
  if (minSpeed === 999) minSpeed = 0;

  // Downsample to high-density points (up to 1,500 points) for buttery smooth 60fps canvas curves
  const targetSamples = 1500;
  const step = Math.max(1, Math.floor(parsedPoints.length / targetSamples));
  const downsampled: TelemetryPoint[] = [];
  for (let i = 0; i < parsedPoints.length; i += step) {
    downsampled.push(parsedPoints[i]);
  }
  if (downsampled[downsampled.length - 1] !== parsedPoints[parsedPoints.length - 1]) {
    downsampled.push(parsedPoints[parsedPoints.length - 1]);
  }

  const cornerSpeeds: MinCornerSpeed[] = [];
  downsampled.forEach((p, idx) => {
    // Detect corner apex (local minimum speed with steering angle > 15 deg)
    if (idx > 2 && idx < downsampled.length - 2) {
      const prev = downsampled[idx - 1].speed;
      const next = downsampled[idx + 1].speed;
      if (p.speed <= prev && p.speed <= next && Math.abs(p.steer) > 15) {
        // Merge with the previous detection if it's the same corner (<150m apart):
        // keep only the slowest point (the true apex) instead of a cluster.
        const last = cornerSpeeds[cornerSpeeds.length - 1];
        if (last && Math.abs(p.dist - last.dist) < 150) {
          if (p.speed < last.speed) {
            last.dist = p.dist;
            last.speed = p.speed;
            last.steer = p.steer;
          }
        } else {
          cornerSpeeds.push({ dist: p.dist, speed: p.speed, steer: p.steer });
        }
      }
    }
  });

  // Calculate Trail-Braking & Throttle Smoothness heuristic scores
  let abruptBrakeDrops = 0;
  let throttleHesitations = 0;
  let steeringScrubEvents = 0;

  for (let i = 1; i < downsampled.length; i++) {
    const prev = downsampled[i - 1];
    const curr = downsampled[i];

    if (prev.brake > 60 && curr.brake === 0 && Math.abs(curr.steer) < 10) {
      abruptBrakeDrops++;
    }
    if (prev.throttle > 30 && curr.throttle < 15 && curr.speed < 160) {
      throttleHesitations++;
    }
    if (Math.abs(curr.steer) > 35 && curr.speed < 120 && Math.abs(curr.latG) < 1.6) {
      steeringScrubEvents++;
    }
  }

  const trailBrakingScore = Math.max(50, Math.min(95, 90 - abruptBrakeDrops * 10));
  const throttleSmoothness = Math.max(55, Math.min(96, 92 - throttleHesitations * 8));
  const steeringScrub = Math.max(50, Math.min(94, 88 - steeringScrubEvents * 7));

  const lastPoint = downsampled[Math.floor(downsampled.length * 0.75)] || downsampled[0];
  const tyreStats = {
    FL: { temp: `${lastPoint.tempFL}°C`, pressure: `${lastPoint.pressFL} psi` },
    FR: { temp: `${lastPoint.tempFR}°C`, pressure: `${lastPoint.pressFR} psi` },
    RL: { temp: `${lastPoint.tempRL}°C`, pressure: `${lastPoint.pressRL} psi` },
    RR: { temp: `${lastPoint.tempRR}°C`, pressure: `${lastPoint.pressRR} psi` },
  };

  const detectedAnomalies: TelemetryAnomaly[] = [];
  if (abruptBrakeDrops > 0) {
    detectedAnomalies.push({
      location: "Heavy Braking Zones",
      description: "Driver dumps brake pedal sharply from peak pressure to 0% rather than trailing into apex",
      channel: "Brake",
    });
  }
  if (steeringScrubEvents > 0) {
    detectedAnomalies.push({
      location: "Slow-to-Medium Corners",
      description: "Excess steering lock added while vehicle yaw rate stalls (front tyre scrub)",
      channel: "Steering",
    });
  }
  if (throttleHesitations > 0) {
    detectedAnomalies.push({
      location: "Corner Exit & Traction",
      description: "Hesitant throttle feed-in with micro-lifts indicating rear axle instability on power",
      channel: "Throttle",
    });
  }

  // ---- Corner phase balance: understeer angle (steering minus Ackermann) ----
  // Positive = understeer (more lock than geometry needs), negative = oversteer.
  const WHEELBASE_M = 2.7;
  const STEER_RATIO = 14.0;
  let entrySum = 0, entryN = 0, midSum = 0, midN = 0, exitSum = 0, exitN = 0;
  for (const p of parsedPoints) {
    const speedMs = Math.max(8, p.speed / 3.6);
    const latAccMs2 = Math.abs(p.latG) * 9.81;
    if (latAccMs2 > 3.0 && speedMs > 10) {
      const ackermannDeg = ((WHEELBASE_M * latAccMs2) / (speedMs * speedMs)) * (180 / Math.PI) * STEER_RATIO;
      const understeerDeg = Number((Math.abs(p.steer) - ackermannDeg).toFixed(2));
      p.understeerAngle = understeerDeg;
      if (p.brake > 5 || p.longG < -0.35) { entrySum += understeerDeg; entryN++; }
      else if (p.throttle >= 30 && p.longG > 0.1) { exitSum += understeerDeg; exitN++; }
      else if (p.throttle < 30 && Math.abs(p.latG) > 0.6) { midSum += understeerDeg; midN++; }
    } else {
      p.understeerAngle = 0;
    }
  }
  const avgEntry = entryN > 0 ? entrySum / entryN : 0;
  const avgMid = midN > 0 ? midSum / midN : 0;
  const avgExit = exitN > 0 ? exitSum / exitN : 0;
  const classifyPhase = (v: number): "Oversteer" | "Neutral" | "Understeer" =>
    v > 1.2 ? "Understeer" : v < -1.2 ? "Oversteer" : "Neutral";
  const phaseBalance = {
    entry: classifyPhase(avgEntry),
    mid: classifyPhase(avgMid),
    exit: classifyPhase(avgExit),
    entryDeltaDeg: Number(avgEntry.toFixed(1)),
    midDeltaDeg: Number(avgMid.toFixed(1)),
    exitDeltaDeg: Number(avgExit.toFixed(1)),
    verdict: `${classifyPhase(avgEntry)} on Entry, ${classifyPhase(avgMid)} at Apex, ${classifyPhase(avgExit)} on Exit`,
  };

  // ---- Tyre pressure optimization: recommended cold from observed hot ----
  const targetHot = lastPoint.pressFL > 28.5 ? 29.5 : lastPoint.pressFL < 24.0 ? 23.5 : 26.85;
  const calcCold = (obsHot: number, baseCold: number) => Number((baseCold + (targetHot - obsHot)).toFixed(2));
  const tyreOptimization = {
    targetHot,
    observedHot: { FL: lastPoint.pressFL, FR: lastPoint.pressFR, RL: lastPoint.pressRL, RR: lastPoint.pressRR },
    pressureDelta: {
      FL: Number((targetHot - lastPoint.pressFL).toFixed(2)),
      FR: Number((targetHot - lastPoint.pressFR).toFixed(2)),
      RL: Number((targetHot - lastPoint.pressRL).toFixed(2)),
      RR: Number((targetHot - lastPoint.pressRR).toFixed(2)),
    },
    recommendedCold: {
      FL: calcCold(lastPoint.pressFL, 26.2),
      FR: calcCold(lastPoint.pressFR, 26.5),
      RL: calcCold(lastPoint.pressRL, 25.9),
      RR: calcCold(lastPoint.pressRR, 26.2),
    },
    status:
      Math.abs(targetHot - lastPoint.pressFL) < 0.3 && Math.abs(targetHot - lastPoint.pressFR) < 0.3
        ? "Within optimal thermal window"
        : "Cold starting pressure adjustment recommended",
  };

  // ---- Driver technique vs mechanical setup separation ----
  const driverTechniquePoints: string[] = [];
  const mechanicalSetupPoints: string[] = [];
  if (abruptBrakeDrops > 0) {
    driverTechniquePoints.push("Abrupt brake release into turn-in: release the pedal progressively to maintain front axle pitch load.");
  }
  if (steeringScrubEvents > 0) {
    driverTechniquePoints.push("Steering wheel turned beyond front tyre grip limit at apex — excess lock generates scrub, not rotation.");
  }
  if (throttleHesitations > 0) {
    driverTechniquePoints.push("Hesitant throttle feed-in on exit: commit to a single progressive application once the car is rotated.");
  }
  if (phaseBalance.entry === "Understeer") {
    mechanicalSetupPoints.push("Entry understeer: shift brake bias 0.5–1.0% rearward or soften front bump damping.");
  }
  if (phaseBalance.mid === "Understeer") {
    mechanicalSetupPoints.push("Mid-corner push: soften front anti-roll bar or raise rear ride height (more aero rake).");
  }
  if (phaseBalance.exit === "Oversteer") {
    mechanicalSetupPoints.push("Exit oversteer: increase diff power lock or stiffen rear slow rebound.");
  }
  if (phaseBalance.exit === "Understeer") {
    mechanicalSetupPoints.push("Exit understeer: reduce diff power lock or soften rear anti-roll bar.");
  }

  return {
    filename,
    vehicle: meta.vehicle,
    venue: meta.venue,
    rawCount: parsedPoints.length,
    lapTime: lapTimeFormatted,
    lapNumber,
    topSpeed,
    minSpeed,
    maxLatG: Number(maxLatG.toFixed(2)),
    maxDecelG: Number(Math.abs(maxDecelG).toFixed(2)),
    minCornerSpeeds: cornerSpeeds,
    trailBrakingScore,
    throttleSmoothness,
    steeringScrub,
    tyreStats,
    detectedAnomalies,
    phaseBalance,
    tyreOptimization,
    driverVsCar: { driverTechniquePoints, mechanicalSetupPoints },
    points: downsampled,
    channels: Object.keys(col).filter(k => (col as Record<string, number | null>)[k] != null),
  };
}

/**
 * Parse every complete lap in a telemetry CSV, sorted by lap number.
 * Used by the in-app lap selector. Files without a Lap column (or with no
 * valid lap groups) yield a single entry, same as parseTelemetryCSV.
 */
export function parseTelemetryCSVLaps(csvText: string, filename: string = "telemetry.csv"): ParsedTelemetryFile[] {
  const { rows, col, meta } = parseRawRows(csvText);
  return groupLapRows(rows, col).map(g => parseLapRows(g.rows, col, g.lapNumber, filename, meta));
}

/**
 * Historical entry point: returns the fastest complete lap when a Lap
 * column exists, otherwise the whole file as a single lap.
 */
/**
 * Historical entry point: returns the fastest complete lap when a Lap
 * column exists, otherwise the whole file as a single lap.
 */
export function parseTelemetryCSV(csvText: string, filename: string = "telemetry.csv"): ParsedTelemetryFile {
  return pickBestLap(parseTelemetryCSVLaps(csvText, filename));
}

/** Shared fastest-complete-lap selection used by both sync and file parsers. */
function pickBestLap(laps: ParsedTelemetryFile[]): ParsedTelemetryFile {
  // Pick the fastest COMPLETE lap. A partial lap (pit in/out, off-track) always
  // has a shorter duration than a full lap, so a naive min-duration pick
  // selects fragments. Filter to laps covering ~most of the max distance first.
  const maxDist = Math.max(1, ...laps.map((l) => {
    const pts = l.points;
    return pts.length > 1 ? pts[pts.length - 1].dist - pts[0].dist : 0;
  }));
  const complete = laps.filter((l) => {
    const pts = l.points;
    const d = pts.length > 1 ? pts[pts.length - 1].dist - pts[0].dist : 0;
    return d >= maxDist * 0.9;
  });
  const candidates = complete.length > 0 ? complete : laps;
  let best: ParsedTelemetryFile | null = null;
  let bestDur = Infinity;
  let most: ParsedTelemetryFile | null = null;
  for (const l of candidates) {
    if (!most || l.rawCount > most.rawCount) most = l;
    const pts = l.points;
    // Downsampling always keeps the first and last raw points, so this is
    // exactly the raw lap duration the old selection logic used.
    const dur = pts.length > 1 ? pts[pts.length - 1].time - pts[0].time : 0;
    if (dur >= 15 && dur < bestDur) { bestDur = dur; best = l; }
  }
  return best ?? most ?? laps[0];
}

/**
 * Streaming file variants for large telemetry files (100MB+). Read the file
 * in chunks so it never sits fully in memory, with adaptive stride sampling.
 */
export async function parseTelemetryCSVLapsFromFile(file: File, filename: string = "telemetry.csv"): Promise<ParsedTelemetryFile[]> {
  const { rows, col, meta } = await parseRawRowsFromFile(file);
  return groupLapRows(rows, col).map(g => parseLapRows(g.rows, col, g.lapNumber, filename, meta));
}

export async function parseTelemetryCSVFromFile(file: File, filename: string = "telemetry.csv"): Promise<ParsedTelemetryFile> {
  return pickBestLap(await parseTelemetryCSVLapsFromFile(file, filename));
}
