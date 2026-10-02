/**
 * Synthetic demo telemetry traces for the Telemetry tab.
 *
 * Generates realistic multi-lap CSV telemetry (Mu/iRacing-style columns)
 * from a corner-speed model so visitors can try the analysis without
 * uploading their own files. The CSV goes through the normal
 * parseTelemetryCSV pipeline, so lap detection, Vehicle/Venue metadata,
 * stats and the lap selector all behave exactly like a real upload.
 */

interface DemoCorner {
  dist: number; // metres along the lap
  apexKmh: number; // target apex speed
  name: string;
}

interface DemoTrack {
  vehicle: string;
  venue: string;
  game: string;
  length: number; // metres
  topKmh: number;
  corners: DemoCorner[];
  /** lapIndex -> corner name -> apex speed multiplier (driver mistakes) */
  mistakes?: Record<number, Record<string, number>>;
  /** lapIndex -> list of {dist, duration} throttle lifts (seconds) */
  lifts?: Record<number, { dist: number; duration: number }[]>;
}

// Sebring corner distances from the authentic circuit geometry.
const SEBRING_CORNERS: DemoCorner[] = [
  { dist: 291, apexKmh: 138, name: "T1" },
  { dist: 478, apexKmh: 205, name: "T2" },
  { dist: 807, apexKmh: 92, name: "T3" },
  { dist: 940, apexKmh: 112, name: "T4" },
  { dist: 1116, apexKmh: 148, name: "T5" },
  { dist: 1345, apexKmh: 118, name: "T6" },
  { dist: 2005, apexKmh: 82, name: "T7" },
  { dist: 2210, apexKmh: 142, name: "T8" },
  { dist: 2438, apexKmh: 108, name: "T9" },
  { dist: 2764, apexKmh: 128, name: "T10" },
  { dist: 2889, apexKmh: 98, name: "T11" },
  { dist: 3245, apexKmh: 152, name: "T12" },
  { dist: 3812, apexKmh: 182, name: "T13" },
  { dist: 4035, apexKmh: 158, name: "T14" },
  { dist: 4135, apexKmh: 138, name: "T15" },
  { dist: 4251, apexKmh: 168, name: "T16" },
  { dist: 5384, apexKmh: 118, name: "T17" },
];

export const DEMO_TRACKS: DemoTrack[] = [
  {
    vehicle: "Mercedes-AMG GT3 2020",
    venue: "Sebring International Raceway",
    game: "iRacing",
    length: 6019,
    topKmh: 268,
    corners: SEBRING_CORNERS,
    // Lap 2 (index 1): late braking into T1 (slower apex) + a lift in fast T13.
    mistakes: { 1: { T1: 0.88, T7: 0.94 } },
    lifts: { 1: [{ dist: 3750, duration: 0.9 }] },
  },
];

const STEP = 2; // metres per sample
const ACCEL = 7.5; // m/s^2
const DECEL = 15.5; // m/s^2 braking

function speedProfile(track: DemoTrack, lapIndex: number): { v: number[]; n: number } {
  const n = Math.floor(track.length / STEP);
  const topMs = track.topKmh / 3.6;
  const mistakes = track.mistakes?.[lapIndex] ?? {};

  // Target speed at each point (corner apex limits).
  const vTarget = new Array(n).fill(topMs);
  for (const c of track.corners) {
    const mult = mistakes[c.name] ?? 1;
    const vc = (c.apexKmh * mult) / 3.6;
    const idx = Math.round(c.dist / STEP) % n;
    // Apply the apex limit over a zone around the corner (±40m).
    for (let k = -20; k <= 20; k++) {
      const j = (idx + k + n) % n;
      if (vc < vTarget[j]) vTarget[j] = vc;
    }
  }

  // Backward pass: braking limits.
  const vBrake = [...vTarget];
  let limit = topMs;
  for (let i = 2 * n - 1; i >= 0; i--) {
    const j = i % n;
    limit = Math.sqrt(Math.max(vTarget[j] * vTarget[j], limit * limit - 2 * DECEL * STEP));
    if (limit < vBrake[j]) vBrake[j] = limit;
    else limit = vBrake[j];
  }

  // Forward pass: acceleration limits.
  const v = new Array(n).fill(0);
  v[0] = vBrake[0] * 0.98;
  for (let i = 1; i < n; i++) {
    const vAcc = Math.sqrt(v[i - 1] * v[i - 1] + 2 * ACCEL * STEP);
    v[i] = Math.min(vAcc, vBrake[i]);
  }
  // Close the loop: iterate until the start speed is consistent.
  for (let iter = 0; iter < 3; iter++) {
    v[0] = Math.min(Math.sqrt(v[n - 1] * v[n - 1] + 2 * ACCEL * STEP), vBrake[0]);
    for (let i = 1; i < n; i++) {
      const vAcc = Math.sqrt(v[i - 1] * v[i - 1] + 2 * ACCEL * STEP);
      v[i] = Math.min(vAcc, vBrake[i]);
    }
  }
  return { v, n };
}

function gearForSpeed(kmh: number): number {
  if (kmh < 95) return 2;
  if (kmh < 125) return 3;
  if (kmh < 160) return 4;
  if (kmh < 200) return 5;
  return 6;
}

export function generateDemoCSV(track: DemoTrack, laps: number): string {
  const lines: string[] = [];
  lines.push(`"Vehicle","${track.vehicle}"`);
  lines.push(`"Venue","${track.venue}"`);
  lines.push(`"Driver","Demo Driver"`);
  lines.push(
    "SessionTime,LapDist,Speed,Throttle,Brake,SteeringWheelAngle,Gear,Engine0_RPM,LatAccel,LongAccel,LFtempM,RFtempM,LRtempM,RRtempM,LFpressure,RFpressure,LRpressure,RRpressure,Lap"
  );
  lines.push("s,m,m/s,%,%,rad,-,rad/s,g,g,C,C,C,C,kPa,kPa,kPa,kPa,-");

  let t = 0;
  for (let lap = 0; lap < laps; lap++) {
    const { v, n } = speedProfile(track, lap);
    const lifts = track.lifts?.[lap] ?? [];
    // Precompute lift windows in distance space.
    const liftAt = new Array(n).fill(false);
    for (const l of lifts) {
      const idx = Math.round(l.dist / STEP) % n;
      // Convert duration to sample count using local speed.
      const localV = Math.max(v[idx], 20);
      const count = Math.round((l.duration * localV) / STEP);
      for (let k = 0; k < count; k++) liftAt[(idx + k) % n] = true;
    }

    for (let i = 0; i < n; i++) {
      const dist = i * STEP;
      const vMs = v[i];
      const vNext = v[(i + 1) % n];
      const dt = STEP / Math.max(vMs, 1);
      t += dt;
      const kmh = vMs * 3.6;

      // Longitudinal accel (m/s^2) from speed delta.
      const aLong = ((vNext - vMs) / dt) / 9.81; // in G

      // Braking if decelerating hard, throttle if accelerating.
      const braking = aLong < -0.25;
      const accelerating = aLong > 0.12 && !liftAt[i];
      const throttle = liftAt[i] ? 0 : accelerating ? 100 : braking ? 0 : 35;
      const brake = braking ? Math.min(100, Math.round((-aLong / 1.7) * 100)) : 0;

      // Lateral G: peaks at the apex, ~0 when braking in a straight line.
      let latG = 0;
      let steer = 0;
      for (const c of track.corners) {
        let dd = Math.abs(dist - c.dist);
        dd = Math.min(dd, track.length - dd);
        if (dd < 55) {
          const vc = c.apexKmh / 3.6;
          const falloff = 1 - dd / 55;
          // Cornering intensity: 1 at apex speed, fading when far off it
          // (e.g. still braking in a straight line).
          const cornering = Math.max(0, 1 - Math.abs(vMs - vc) / vc);
          const g = 1.7 * falloff * cornering;
          if (g > Math.abs(latG)) {
            latG = g * (c.dist % 2 === 0 ? 1 : -1);
            steer = latG * 0.09;
          }
        }
      }

      const gear = gearForSpeed(kmh);
      // rad/s: rough engine speed model.
      const gearTopKmh = [0, 0, 95, 125, 160, 200, 268][gear];
      const rpmRad = 65 + (kmh / gearTopKmh) * 55;

      // Tyre temps: warm, with slight corner-load variation.
      const loadVar = Math.abs(latG) * 2.5;
      const tFL = 92 + loadVar + Math.sin(dist / 300) * 1.5;
      const tFR = 91 + loadVar + Math.cos(dist / 280) * 1.5;
      const tRL = 88 + Math.abs(aLong) * 1.2;
      const tRR = 87.5 + Math.abs(aLong) * 1.2;
      const pFL = 184, pFR = 185, pRL = 180, pRR = 181;

      lines.push(
        [
          t.toFixed(2),
          dist.toFixed(1),
          vMs.toFixed(2),
          throttle.toFixed(0),
          brake.toFixed(0),
          steer.toFixed(3),
          gear,
          rpmRad.toFixed(1),
          latG.toFixed(3),
          aLong.toFixed(3),
          tFL.toFixed(1),
          tFR.toFixed(1),
          tRL.toFixed(1),
          tRR.toFixed(1),
          pFL,
          pFR,
          pRL,
          pRR,
          lap + 1,
        ].join(",")
      );
    }
  }
  return lines.join("\n");
}
