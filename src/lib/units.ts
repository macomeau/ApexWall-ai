/**
 * Global units system. Canonical internal values are metric:
 * speed = km/h, temperature = °C, pressure = bar, distance = m, fuel = L.
 * The `fmt` helpers take a canonical metric value and render it in the
 * user's chosen system.
 */

export type Units = "metric" | "imperial";

export const KMH_TO_MPH = 0.621371;
export const BAR_TO_PSI = 14.5038;
export const M_TO_FT = 3.28084;
export const L_TO_GAL = 0.264172; // US gallons

export const kmhToMph = (kmh: number): number => kmh * KMH_TO_MPH;
export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const barToPsi = (bar: number): number => bar * BAR_TO_PSI;
export const psiToBar = (psi: number): number => psi / BAR_TO_PSI;
export const mToFt = (m: number): number => m * M_TO_FT;
export const lToGal = (l: number): number => l * L_TO_GAL;

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface UnitFormatters {
  /** Canonical input: km/h. Renders "245 km/h" or "152 mph". */
  speed: (kmh: number, digits?: number) => string;
  /** Canonical input: °C. Renders "30°C" or "86°F". */
  temp: (celsius: number) => string;
  /** Temperature DELTA in °C (no +32 offset). Renders "5°C" or "9°F". */
  tempDelta: (celsiusDelta: number) => string;
  /** Canonical input: bar. Renders "1.85 bar" or "26.8 psi". */
  pressureBar: (bar: number) => string;
  /** Native-psi input (e.g. iRacing/ACC tyre data). Renders "1.85 bar" or "26.8 psi". */
  pressurePsi: (psi: number) => string;
  /** Canonical input: meters. Renders "150 m" / "492 ft"; long distances as km/mi. */
  distance: (meters: number) => string;
  /** Canonical input: liters. Renders "35 L" or "9.2 gal". */
  fuel: (liters: number) => string;
  /** Unit labels for the current system. */
  speedUnit: string;
  tempUnit: string;
  pressureUnit: string;
  distanceUnit: string;
  fuelUnit: string;
}

export function makeFormatters(units: Units): UnitFormatters {
  const imperial = units === "imperial";
  return {
    speed: (kmh, digits = 0) => {
      const v = imperial ? kmhToMph(kmh) : kmh;
      const r = digits === 0 ? Math.round(v) : +v.toFixed(digits);
      return `${r} ${imperial ? "mph" : "km/h"}`;
    },
    temp: (celsius) => {
      const v = imperial ? cToF(celsius) : celsius;
      return `${Math.round(v)}°${imperial ? "F" : "C"}`;
    },
    tempDelta: (celsiusDelta) => {
      const v = imperial ? (celsiusDelta * 9) / 5 : celsiusDelta;
      return `${Math.round(v)}°${imperial ? "F" : "C"}`;
    },
    pressureBar: (bar) => {
      const v = imperial ? barToPsi(bar) : bar;
      return `${round2(v)} ${imperial ? "psi" : "bar"}`;
    },
    pressurePsi: (psi) => {
      const v = imperial ? psi : psiToBar(psi);
      return `${round2(v)} ${imperial ? "psi" : "bar"}`;
    },
    distance: (meters) => {
      if (imperial) {
        if (meters >= 1609.34) return `${round1(meters / 1609.34)} mi`;
        return `${Math.round(mToFt(meters))} ft`;
      }
      if (meters >= 1000) return `${round1(meters / 1000)} km`;
      return `${Math.round(meters)} m`;
    },
    fuel: (liters) => {
      const v = imperial ? lToGal(liters) : liters;
      return `${round1(v)} ${imperial ? "gal" : "L"}`;
    },
    speedUnit: imperial ? "mph" : "km/h",
    tempUnit: imperial ? "°F" : "°C",
    pressureUnit: imperial ? "psi" : "bar",
    distanceUnit: imperial ? "mi" : "km",
    fuelUnit: imperial ? "gal" : "L",
  };
}
