/**
 * F-001: Delta trace computation.
 * Pure functions: given two laps (reference + comparison) with distance and
 * speed channels, compute the cumulative time delta at each distance point.
 *
 * Both laps are resampled onto a common distance grid via linear interpolation,
 * then time is integrated as dt = dDist / speed. Delta = t_comparison - t_reference.
 * Positive delta = comparison is slower at that point.
 */

export interface LapChannels {
  dist: number[];   // lap distance in meters, monotonically increasing
  speed: number[];  // speed in m/s (or km/h — must match between laps)
}

export interface DeltaPoint {
  dist: number;
  delta: number; // seconds, + = comparison slower
}

export interface DeltaResult {
  points: DeltaPoint[];
  maxGain: { dist: number; delta: number };  // most negative = biggest gain
  maxLoss: { dist: number; delta: number };  // most positive = biggest loss
  finalDelta: number; // total time difference at lap end
}

/**
 * Resample a channel onto a uniform distance grid via linear interpolation.
 */
function resample(dist: number[], values: number[], grid: number[]): number[] {
  const out: number[] = new Array(grid.length);
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i];
    while (j < dist.length - 2 && dist[j + 1] < g) j++;
    const d0 = dist[j], d1 = dist[j + 1];
    const v0 = values[j], v1 = values[j + 1];
    if (d1 <= d0 || !isFinite(v0) || !isFinite(v1)) {
      out[i] = isFinite(v0) ? v0 : 0;
    } else {
      const t = Math.min(1, Math.max(0, (g - d0) / (d1 - d0)));
      out[i] = v0 + t * (v1 - v0);
    }
  }
  return out;
}

/**
 * Compute cumulative time at each grid point by integrating dt = dDist / speed.
 * Speeds below 1 m/s are clamped to avoid division blowup (pit/tow).
 */
function cumulativeTime(grid: number[], speed: number[]): number[] {
  const t: number[] = new Array(grid.length);
  let acc = 0;
  t[0] = 0;
  for (let i = 1; i < grid.length; i++) {
    const dDist = grid[i] - grid[i - 1];
    const v = Math.max(1, (speed[i] + speed[i - 1]) / 2);
    acc += dDist / v;
    t[i] = acc;
  }
  return t;
}

export function computeDelta(
  reference: LapChannels,
  comparison: LapChannels,
  gridStepM: number = 5
): DeltaResult | null {
  if (!reference.dist.length || !comparison.dist.length) return null;
  if (reference.dist.length !== reference.speed.length) return null;
  if (comparison.dist.length !== comparison.speed.length) return null;

  // Common grid: 0 to min(lap lengths), 5m steps
  const maxDist = Math.min(
    reference.dist[reference.dist.length - 1],
    comparison.dist[comparison.dist.length - 1]
  );
  if (maxDist < 100) return null;
  const n = Math.floor(maxDist / gridStepM);
  const grid: number[] = Array.from({ length: n + 1 }, (_, i) => i * gridStepM);

  const refSpeed = resample(reference.dist, reference.speed, grid);
  const cmpSpeed = resample(comparison.dist, comparison.speed, grid);
  const refTime = cumulativeTime(grid, refSpeed);
  const cmpTime = cumulativeTime(grid, cmpSpeed);

  const points: DeltaPoint[] = grid.map((d, i) => ({
    dist: d,
    delta: cmpTime[i] - refTime[i],
  }));

  let maxGain = points[0], maxLoss = points[0];
  for (const p of points) {
    if (p.delta < maxGain.delta) maxGain = p;
    if (p.delta > maxLoss.delta) maxLoss = p;
  }

  return {
    points,
    maxGain,
    maxLoss,
    finalDelta: points[points.length - 1].delta,
  };
}

/**
 * F-003: Theoretical best from sector times.
 * Returns the composite time and which lap contributed each sector.
 */
export interface SectorBest {
  sectorIndex: number;
  time: number;
  lapNumber: number;
}

export function theoreticalBest(
  laps: Array<{ lap_number: number; sector_times: number[] | null; is_valid: boolean }>
): { total: number; sectors: SectorBest[] } | null {
  const valid = laps.filter((l) => l.is_valid && l.sector_times && l.sector_times.length === 3);
  if (valid.length === 0) return null;
  const sectors: SectorBest[] = [];
  let total = 0;
  for (let s = 0; s < 3; s++) {
    let best: SectorBest | null = null;
    for (const lap of valid) {
      const t = lap.sector_times![s];
      if (t != null && t > 0 && (!best || t < best.time)) {
        best = { sectorIndex: s, time: t, lapNumber: lap.lap_number };
      }
    }
    if (!best) return null;
    sectors.push(best);
    total += best.time;
  }
  return { total, sectors };
}
