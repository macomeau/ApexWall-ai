export interface TelemetryPoint {
  time: number;
  dist: number;
  speed: number;
  throttle: number;
  brake: number;
  steer: number;
  gear: number;
  rpm: number;
  latG: number;
  longG: number;
  tempFL: number;
  tempFR: number;
  tempRL: number;
  tempRR: number;
  pressFL: number;
  pressFR: number;
  pressRL: number;
  pressRR: number;
  /** Steering wheel angle minus geometric Ackermann angle (deg). Positive = understeer, negative = oversteer. */
  understeerAngle?: number;
}

export interface CornerPhaseBalance {
  entry: "Oversteer" | "Neutral" | "Understeer";
  mid: "Oversteer" | "Neutral" | "Understeer";
  exit: "Oversteer" | "Neutral" | "Understeer";
  entryDeltaDeg: number;
  midDeltaDeg: number;
  exitDeltaDeg: number;
  verdict: string;
}

export interface TyreOptimizationReport {
  recommendedCold: { FL: number; FR: number; RL: number; RR: number };
  observedHot: { FL: number; FR: number; RL: number; RR: number };
  targetHot: number;
  pressureDelta: { FL: number; FR: number; RL: number; RR: number };
  status: string;
}

export interface DriverVsCarDiagnostics {
  driverTechniquePoints: string[];
  mechanicalSetupPoints: string[];
}

export interface TyreCornerData {
  temp: string;
  pressure: string;
}

export interface MinCornerSpeed {
  dist: number;
  speed: number;
  steer: number;
}

export interface TelemetryStats {
  lapTime: string;
  topSpeed: number;
  minSpeed: number;
  maxLatG: number;
  maxDecelG: number;
  minCornerSpeeds: MinCornerSpeed[];
  trailBrakingScore: number;
  throttleSmoothness: number;
  steeringScrub: number;
  tyres: {
    FL: TyreCornerData;
    FR: TyreCornerData;
    RL: TyreCornerData;
    RR: TyreCornerData;
  };
}

export interface TelemetryAnomaly {
  location: string;
  description: string;
  channel: string;
}

export interface ParsedTelemetryFile {
  filename: string;
  /** Vehicle name from the file's metadata rows (MoTeC/Mu), if present. */
  vehicle?: string;
  /** Venue/track name from the file's metadata rows (MoTeC/Mu), if present. */
  venue?: string;
  rawCount: number;
  lapTime: string;
  lapNumber: number;
  topSpeed: number;
  minSpeed: number;
  maxLatG: number;
  maxDecelG: number;
  minCornerSpeeds: MinCornerSpeed[];
  trailBrakingScore: number;
  throttleSmoothness: number;
  steeringScrub: number;
  tyreStats: {
    FL: TyreCornerData;
    FR: TyreCornerData;
    RL: TyreCornerData;
    RR: TyreCornerData;
  };
  detectedAnomalies: TelemetryAnomaly[];
  phaseBalance?: CornerPhaseBalance;
  tyreOptimization?: TyreOptimizationReport;
  driverVsCar?: DriverVsCarDiagnostics;
  points: TelemetryPoint[];
  channels: string[];
}

export interface KpiRating {
  name: string;
  score: number;
  status: string;
  feedback: string;
}

export interface CornerBreakdown {
  corner: string;
  timeDelta: string;
  driverInput: string;
  chassisResponse: string;
  actionableFix: string;
}

export interface DriverCoaching {
  phase: string;
  icon: string;
  tip: string;
}

export interface SetupAdjustment {
  category: string;
  component: string;
  adjustment: string;
  rationale: string;
}

export interface SetupItem {
  label: string;
  value: string;
  styleNote?: string;
}

export interface SetupSection {
  title: string;
  items: SetupItem[];
}

export interface AdaptiveSetup {
  philosophy: string;
  sections: SetupSection[];
}

export interface CornerDeltaComparison {
  corner: string;
  shortName?: string;
  dist: number;
  driverMinSpeed: number;
  refMinSpeed: number;
  speedDelta: number;
  timeDelta: number;
  brakingPointDeltaMeters: number;
  throttleCommitDeltaMeters: number;
  verdict: string;
}

export interface DeltaPoint {
  dist: number;
  timeDelta: number;
  speedDelta: number;
  driverSpeed: number;
  refSpeed: number;
  driverThrottle: number;
  refThrottle: number;
  driverBrake: number;
  refBrake: number;
}

export interface GGPoint {
  latG: number;
  longG: number;
  speed: number;
  dist: number;
  throttle: number;
  brake: number;
  gTotal: number;
}

export interface GGFrictionQuadrantStats {
  trailBrakingLeftGripPct: number;
  trailBrakingRightGripPct: number;
  powerDownLeftGripPct: number;
  powerDownRightGripPct: number;
}

export interface GGFrictionCircleData {
  scaleMaxG: number;
  peakCombinedG: number;
  peakLatG: number;
  peakDecelG: number;
  gripUtilizationPct: number;
  trailBrakingTransitionEfficiency: number;
  quadrantStats: GGFrictionQuadrantStats;
  points: GGPoint[];
  envelopeHull: { latG: number; longG: number }[];
  refEnvelopeHull?: { latG: number; longG: number }[];
  refGripUtilizationPct?: number;
  gripDeficitVerdict: string;
}

export interface LapComparisonSummary {
  driverLapTime: string;
  refLapTime: string;
  totalTimeDeltaSeconds: number;
  topSpeedDeltaKmh: number;
  cornerComparisons: CornerDeltaComparison[];
  deltaPoints: DeltaPoint[];
  frictionCircle?: GGFrictionCircleData;
}

export interface TelemetryAnalysisResult {
  overallScore: number;
  verdictTitle: string;
  lapTimeObserved?: string;
  estimatedTimeLost?: string;
  primaryLimiter?: string;
  executiveSummary?: string;
  kpiRatings?: KpiRating[];
  cornerBreakdowns?: CornerBreakdown[];
  driverCoaching?: DriverCoaching[];
  setupAdjustments?: SetupAdjustment[];
  adaptiveSetup?: AdaptiveSetup;
  pitRadioMessage?: string;
  lapComparison?: LapComparisonSummary;
  frictionCircle?: GGFrictionCircleData;
}

export interface GeneratedSetupResult {
  summary: string;
  sections: SetupSection[];
  engineerNotes: string;
}

export interface TrackCorner {
  id: string;
  name: string;
  shortName: string;
  dist: number;
  x: number;
  y: number;
  driverSpeed?: number;
  refSpeed?: number;
  speedDelta?: number;
  timeDelta?: number;
  brakingPointDeltaMeters?: number;
  throttleCommitDeltaMeters?: number;
  verdict?: string;
}

export interface TrackMapPoint {
  dist: number;
  x: number;
  y: number;
  speed: number;
  throttle: number;
  brake: number;
  latG: number;
  timeDelta?: number;
  refSpeed?: number;
  cornerName?: string;
}

export interface TrackDrsZone {
  name: string;
  start: number;
  end: number;
}

export interface TrackSector {
  sector: number;
  dist: number;
}

export interface TrackMapData {
  circuitKey?: string;
  circuitName: string;
  country?: string;
  fiaGrade?: string;
  totalDistance: number;
  points: TrackMapPoint[];
  fullCircuitPoints?: { dist: number; x: number; y: number }[];
  corners: TrackCorner[];
  drsZones?: TrackDrsZone[];
  sectors?: TrackSector[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Where the circuit geometry came from: built-in DB, user-learned, or anonymous reconstruction. */
  geometrySource?: "authentic" | "learned" | "reconstructed";
}

