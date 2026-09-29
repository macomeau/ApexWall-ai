import {
  ParsedTelemetryFile,
  LapComparisonSummary,
  TrackMapData,
  TrackMapPoint,
  TrackCorner,
  CornerDeltaComparison,
} from "@/types/telemetry";
import {
  REAL_CIRCUITS,
  RealCircuitDefinition,
  getAuthenticTrackGeometry,
} from "./circuit-geometries";

/** A circuit definition usable by the map builder: built-in or user-learned. */
export interface MapCircuitDefinition {
  id?: string;
  name: string;
  officialDistance: number;
  fiaGrade?: string;
  country?: string;
  points: { dist: number; x: number; y: number }[];
  corners: { name: string; shortName?: string; dist: number; x: number; y: number }[];
  sectors?: { sector: number; dist: number }[];
  drsZones?: { name: string; start: number; end: number }[];
}

/** Metadata for a user-learned track (as returned by GET /api/learned-tracks). */
export interface LearnedTrackMeta {
  id: string;
  name: string;
  matchKey: string;
  distanceM: number | null;
  country?: string | null;
}

/** Full learned track geometry (as returned by GET /api/learned-tracks/:id). */
export interface LearnedTrackFull extends LearnedTrackMeta {
  points: { dist: number; x: number; y: number }[];
  corners: { name: string; shortName?: string; dist: number; x: number; y: number }[];
  sectors: { sector: number; dist: number }[];
}

export function learnedTrackToDef(t: LearnedTrackFull): MapCircuitDefinition {
  return {
    id: t.id,
    name: t.name,
    officialDistance: t.distanceM || 0,
    fiaGrade: "Learned from telemetry",
    country: t.country || undefined,
    points: t.points,
    corners: t.corners,
    sectors: t.sectors,
  };
}

/** Normalize a track hint for match-key comparison. */
export function normalizeTrackKey(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Derive a stable match key for a track from the form value, falling back to
 * the uploaded filename. iRacing filenames look like
 * "{car}_{track} 2026-09-23 04-16-27.ibt" — strip the car prefix, date stamp
 * and extension so "mercedesamgevogt3_sebring international 2026-09-23 ..." keys as "sebringinternational".
 */
export function deriveTrackMatchKey(track: string, filename: string): string {
  const t = normalizeTrackKey(track);
  if (t) return t;
  let base = (filename || "").replace(/\.[^.]+$/, "");
  base = base.replace(/\s+\d{4}-\d{2}-\d{2}\s+\d{2}[-:]\d{2}[-:]\d{2}.*$/, "");
  const us = base.indexOf("_");
  if (us >= 0) base = base.slice(us + 1);
  return normalizeTrackKey(base) || normalizeTrackKey(filename);
}

/** Match a search hint against the user's learned tracks (key, then distance). */
export function matchLearnedTrackMeta(
  searchHint: string,
  totalDist: number | undefined,
  metas: LearnedTrackMeta[]
): LearnedTrackMeta | null {
  const norm = normalizeTrackKey(searchHint);
  if (norm) {
    for (const m of metas) {
      const mk = normalizeTrackKey(m.matchKey);
      if (mk && (norm.includes(mk) || mk.includes(norm))) return m;
    }
  }
  if (totalDist && totalDist > 1000) {
    let best: LearnedTrackMeta | null = null;
    let bestDiff = Infinity;
    for (const m of metas) {
      if (!m.distanceM) continue;
      const diff = Math.abs(m.distanceM - totalDist) / m.distanceM;
      if (diff < 0.03 && diff < bestDiff) {
        best = m;
        bestDiff = diff;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * High-Precision Interpolation along Official FIA Surveyed Track Coordinates
 */
function interpolateRealCircuit(
  def: { points: { dist: number; x: number; y: number }[]; officialDistance: number },
  targetDist: number,
  telemetryStartDist: number,
  telemetryEndDist: number
): { x: number; y: number } {
  const pts = def.points;
  if (!pts || pts.length === 0) return { x: 500, y: 500 };
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };

  const officialMax = def.officialDistance;
  const telemSpan = Math.max(1, telemetryEndDist - telemetryStartDist);

  let mappedDist: number;
  if (telemSpan >= officialMax * 0.85) {
    // Full lap: stretch to exact official distance
    mappedDist = Math.max(0, Math.min(officialMax, ((targetDist - telemetryStartDist) / telemSpan) * officialMax));
  } else {
    // Partial run or calibrated stint: use absolute track distance (modulo official distance)
    mappedDist = ((targetDist % officialMax) + officialMax) % officialMax;
  }

  // Binary search along pts
  let low = 0;
  let high = pts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (pts[mid].dist === mappedDist) return { x: pts[mid].x, y: pts[mid].y };
    if (pts[mid].dist < mappedDist) low = mid + 1;
    else high = mid - 1;
  }

  const i0 = Math.max(0, Math.min(pts.length - 1, high));
  const i1 = Math.min(pts.length - 1, Math.max(0, low));
  if (i0 === i1) return { x: pts[i0].x, y: pts[i0].y };

  const p0 = pts[i0];
  const p1 = pts[i1];
  const span = p1.dist - p0.dist;
  if (span <= 0.001) return { x: p0.x, y: p0.y };

  const t = Math.max(0, Math.min(1, (mappedDist - p0.dist) / span));
  return {
    x: +(p0.x + (p1.x - p0.x) * t).toFixed(1),
    y: +(p0.y + (p1.y - p0.y) * t).toFixed(1),
  };
}

/**
 * Universal Dead-Reckoning Trajectory for Custom / Mod circuits
 * Uses physical curvature integration with cubic smoothing and closed-loop endpoint relaxation.
 */
function reconstructAutonomousTrajectory(telemetry: ParsedTelemetryFile): { x: number; y: number }[] {
  const pts = telemetry.points;
  if (!pts || pts.length < 2) return [{ x: 500, y: 500 }];

  let x = 0;
  let y = 0;
  let heading = 0;
  const rawTrajectory: { x: number; y: number; dist: number }[] = [{ x: 0, y: 0, dist: pts[0].dist }];

  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(0.005, Math.min(0.2, pts[i].time - pts[i - 1].time));
    const v = Math.max(4.0, pts[i].speed / 3.6); // speed in m/s
    const latG = pts[i].latG || 0;
    const steer = pts[i].steer || 0;

    let omega = 0;
    if (Math.abs(latG) > 0.05) {
      omega = (latG * 9.80665) / v;
    } else if (Math.abs(steer) > 1.0) {
      const wheelBase = 2.75;
      const steerRatio = 14.5;
      const steerRad = (steer * Math.PI) / 180.0 / steerRatio;
      omega = (v / wheelBase) * Math.sin(steerRad);
    }

    heading += omega * dt;
    x += v * Math.cos(heading) * dt;
    y += v * Math.sin(heading) * dt;
    rawTrajectory.push({ x, y, dist: pts[i].dist });
  }

  // Closed-loop drift distribution
  const totalDist = Math.max(1, pts[pts.length - 1].dist);
  const driftX = x;
  const driftY = y;

  return rawTrajectory.map((pt) => {
    const progress = Math.max(0, Math.min(1, pt.dist / totalDist));
    return {
      x: pt.x - progress * driftX,
      y: pt.y - progress * driftY,
    };
  });
}

/**
 * Build a TrackMapData from any circuit definition (built-in authentic
 * geometry or a user-learned one): interpolate telemetry onto the shape
 * and match corners / driver apex speeds.
 */
function buildTrackMapFromDefinition(
  def: MapCircuitDefinition,
  telemetryPoints: ParsedTelemetryFile["points"],
  lapComparison: LapComparisonSummary | null | undefined,
  startDist: number,
  endDist: number,
  geometrySource: "authentic" | "learned"
): TrackMapData {
    // Map telemetry onto the definition shape
    const points: TrackMapPoint[] = telemetryPoints.map((pt, idx) => {
      const coord = interpolateRealCircuit(def, pt.dist, startDist, endDist);
      const deltaPt = lapComparison?.deltaPoints?.[idx];

      return {
        dist: pt.dist,
        x: coord.x,
        y: coord.y,
        speed: pt.speed,
        throttle: pt.throttle,
        brake: pt.brake,
        latG: pt.latG,
        timeDelta: deltaPt ? deltaPt.timeDelta : undefined,
        refSpeed: deltaPt ? deltaPt.refSpeed : undefined,
      };
    });

    // Match corners and calculate driver apex speeds
    const corners: TrackCorner[] = def.corners.map((rc, cIdx) => {
      // Find telemetry point closest to this corner's distance
      let closestPt: TrackMapPoint | null = null;
      let minDiff = Infinity;
      let minSpeedInZone = Infinity;

      points.forEach((p) => {
        const diff = Math.abs(p.dist - rc.dist);
        if (diff < minDiff) {
          minDiff = diff;
          closestPt = p;
        }
        if (diff <= 220 && p.speed < minSpeedInZone) {
          minSpeedInZone = p.speed;
        }
      });

      const comp: CornerDeltaComparison | undefined = lapComparison?.cornerComparisons?.find(
        (c) =>
          c.shortName === rc.shortName ||
          c.corner === rc.name ||
          c.corner.toLowerCase().includes(rc.shortName.toLowerCase()) ||
          Math.abs(c.dist - rc.dist) < 180
      );

      const hasTelemetryInCorner = minDiff < 300;
      const driverSpeed = hasTelemetryInCorner
        ? comp?.driverMinSpeed ?? (minSpeedInZone < Infinity ? minSpeedInZone : closestPt?.speed)
        : undefined;

      return {
        id: `corner-${cIdx}`,
        name: rc.name,
        shortName: rc.shortName,
        dist: rc.dist,
        x: rc.x,
        y: rc.y,
        driverSpeed,
        refSpeed: comp?.refMinSpeed,
        speedDelta: comp?.speedDelta,
        timeDelta: comp?.timeDelta,
        brakingPointDeltaMeters: comp?.brakingPointDeltaMeters,
        throttleCommitDeltaMeters: comp?.throttleCommitDeltaMeters,
        verdict: comp?.verdict || (hasTelemetryInCorner ? `Apex Speed: ${Math.round(driverSpeed || 0)} km/h` : geometrySource === "learned" ? "Learned Reference Corner" : "FIA Reference Corner"),
      };
    });

    return {
      circuitKey: def.id,
      circuitName: def.name,
      country: def.country,
      fiaGrade: def.fiaGrade,
      totalDistance: def.officialDistance,
      points,
      fullCircuitPoints: def.points.map((p) => ({ dist: p.dist, x: p.x, y: p.y })),
      corners,
      drsZones: def.drsZones,
      sectors: def.sectors,
      bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
      geometrySource,
    };
}

/**
 * Generate True FIA Grade Track Map Data synchronized with telemetry.
 * Automatically recognizes official FIA circuits or supports user overrides.
 */
export function generateTrackMapData(
  telemetry: ParsedTelemetryFile,
  trackHint?: string,
  lapComparison?: LapComparisonSummary | null,
  learnedDef?: MapCircuitDefinition | null
): TrackMapData {
  const telemetryPoints = telemetry.points;
  const startDist = telemetryPoints[0]?.dist || 0;
  const endDist = telemetryPoints[telemetryPoints.length - 1]?.dist || 4000;
  const totalDistance = Math.max(100, endDist - startDist);

  // 1. Identify Authentic FIA Circuit
  const searchHint = `${trackHint || ""} ${telemetry.filename || ""}`;
  const realCircuit = getAuthenticTrackGeometry(searchHint, endDist);

  if (realCircuit) {
    // 2A. Authentic built-in circuit geometry
    return buildTrackMapFromDefinition(
      {
        id: realCircuit.id,
        name: realCircuit.name,
        officialDistance: realCircuit.officialDistance,
        fiaGrade: realCircuit.fiaGrade,
        country: realCircuit.country,
        points: realCircuit.points,
        corners: realCircuit.corners,
        sectors: realCircuit.sectors,
        drsZones: realCircuit.drsZones,
      },
      telemetryPoints,
      lapComparison,
      startDist,
      endDist,
      "authentic"
    );
  }

  if (learnedDef) {
    // 2A'. User-learned circuit geometry (auto-saved from earlier telemetry)
    return buildTrackMapFromDefinition(
      learnedDef,
      telemetryPoints,
      lapComparison,
      startDist,
      endDist,
      "learned"
    );
  }

  // 2B. Universal Kinematic Dead-Reckoning Fallback for Custom Tracks
  const rawPositions = reconstructAutonomousTrajectory(telemetry);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  rawPositions.forEach((p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });

  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);
  const maxRange = Math.max(rangeX, rangeY);

  const padding = 70;
  const usableSize = 1000 - padding * 2;
  const scale = usableSize / maxRange;

  const offsetX = padding + (usableSize - rangeX * scale) / 2;
  const offsetY = padding + (usableSize - rangeY * scale) / 2;

  const points: TrackMapPoint[] = telemetryPoints.map((pt, idx) => {
    const rawPos = rawPositions[idx] || { x: 500, y: 500 };
    const normX = Math.round(offsetX + (rawPos.x - minX) * scale);
    const normY = Math.round(offsetY + (rawPos.y - minY) * scale);
    const deltaPt = lapComparison?.deltaPoints?.[idx];

    return {
      dist: pt.dist,
      x: normX,
      y: normY,
      speed: pt.speed,
      throttle: pt.throttle,
      brake: pt.brake,
      latG: pt.latG,
      timeDelta: deltaPt ? deltaPt.timeDelta : undefined,
      refSpeed: deltaPt ? deltaPt.refSpeed : undefined,
    };
  });

  // Dynamic Corner Detection
  const corners: TrackCorner[] = [];
  const minCornerGap = Math.max(120, totalDistance / 30.0);

  for (let i = 2; i < telemetryPoints.length - 2; i++) {
    const prev = telemetryPoints[i - 1].speed;
    const curr = telemetryPoints[i].speed;
    const next = telemetryPoints[i + 1].speed;
    const latG = Math.abs(telemetryPoints[i].latG);
    const steer = Math.abs(telemetryPoints[i].steer);
    const dist = telemetryPoints[i].dist;

    if (curr <= prev && curr <= next && (latG >= 0.45 || steer >= 10.0)) {
      if (corners.length === 0 || dist - corners[corners.length - 1].dist > minCornerGap) {
        const cNum = corners.length + 1;
        const pt = points[i];
        corners.push({
          id: `corner-${corners.length}`,
          name: `Turn ${cNum}`,
          shortName: `T${cNum}`,
          dist,
          x: pt.x,
          y: pt.y,
          driverSpeed: curr,
          verdict: `Minimum Apex Speed: ${Math.round(curr)} km/h`,
        });
      }
    }
  }

  return {
    circuitName: trackHint?.trim() || "Autonomous Circuit Layout",
    fiaGrade: "Custom Circuit",
    totalDistance: endDist,
    points,
    fullCircuitPoints: points.map((p) => ({ dist: p.dist, x: p.x, y: p.y })),
    corners,
    bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
    geometrySource: "reconstructed",
  };
}
