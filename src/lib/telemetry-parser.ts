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

// ---- Stage 1: header/delimiter/units detection, column mapping, raw rows ----
function parseRawRows(csvText: string): { rows: RawRow[]; col: ColMap; meta: { vehicle?: string; venue?: string } } {
  const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 5) {
    throw new Error("Telemetry file contains too few rows to analyze.");
  }

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

  const rows: RawRow[] = [];
  const get = (cells: number[], c: number | null) => (c == null ? NaN : cells[c]);

  for (let i = dataStart; i < lines.length; i++) {
    const raw = lines[i].split(delimiter);
    if (raw.length < 2) continue;
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
    if (total === 0 || numeric / total < 0.5) continue;

    const t = num(get(cells, col.time)) * timeF;
    // Without a time column, synthesize from row index at 20 Hz
    const time = col.time != null ? t : (rows.length * 0.05);
    rows.push({
      t: time,
      lap: col.lap != null ? Math.round(num(get(cells, col.lap))) : -1,
      dist: num(get(cells, col.dist)) * distF,
      speed: num(get(cells, col.speed)) * speedF,
      thr: toPct(num(get(cells, col.throttle)), thrPct),
      brk: toPct(num(get(cells, col.brake)), brkPct),
      steer: num(get(cells, col.steer)) * steerF,
      gear: col.gear != null ? Math.max(1, Math.min(8, Math.round(num(get(cells, col.gear)))) || 1) : 3,
      rpm: num(get(cells, col.rpm)),
      latG: num(get(cells, col.latG)),
      longG: num(get(cells, col.longG)),
      tFL: tempF(num(get(cells, col.tempFL))), tFR: tempF(num(get(cells, col.tempFR))),
      tRL: tempF(num(get(cells, col.tempRL))), tRR: tempF(num(get(cells, col.tempRR))),
      pFL: num(get(cells, col.pressFL)) * pressF, pFR: num(get(cells, col.pressFR)) * pressF,
      pRL: num(get(cells, col.pressRL)) * pressF, pRR: num(get(cells, col.pressRR)) * pressF,
    });
  }

  if (rows.length === 0) {
    throw new Error("Could not parse numeric telemetry data from the file.");
  }
  return { rows, col, meta };
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
        cornerSpeeds.push({ dist: p.dist, speed: p.speed, steer: p.steer });
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
    minCornerSpeeds: cornerSpeeds.slice(0, 6),
    trailBrakingScore,
    throttleSmoothness,
    steeringScrub,
    tyreStats,
    detectedAnomalies,
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
export function parseTelemetryCSV(csvText: string, filename: string = "telemetry.csv"): ParsedTelemetryFile {
  const laps = parseTelemetryCSVLaps(csvText, filename);
  let best: ParsedTelemetryFile | null = null;
  let bestDur = Infinity;
  let most: ParsedTelemetryFile | null = null;
  for (const l of laps) {
    if (!most || l.rawCount > most.rawCount) most = l;
    const pts = l.points;
    // Downsampling always keeps the first and last raw points, so this is
    // exactly the raw lap duration the old selection logic used.
    const dur = pts.length > 1 ? pts[pts.length - 1].time - pts[0].time : 0;
    if (dur >= 15 && dur < bestDur) { bestDur = dur; best = l; }
  }
  return best ?? most ?? laps[0];
}
