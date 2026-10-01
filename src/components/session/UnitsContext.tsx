"use client";

import React, { createContext, useContext, useState, useEffect, useMemo } from "react";
import { Units, UnitFormatters, makeFormatters } from "@/lib/units";

/**
 * Global display units (Metric / Imperial), persisted to localStorage.
 * Defaults to metric. Every unit literal in the UI goes through `fmt`
 * so the whole app switches together.
 */
const STORAGE_KEY = "apexwall.units.v1";

export interface UnitsContextValue {
  units: Units;
  setUnits: (u: Units) => void;
  toggleUnits: () => void;
  fmt: UnitFormatters;
}

const UnitsContext = createContext<UnitsContextValue | null>(null);

function loadStored(): Units {
  if (typeof window === "undefined") return "metric";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "imperial" ? "imperial" : "metric";
  } catch {
    return "metric";
  }
}

export const UnitsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [units, setUnitsState] = useState<Units>(loadStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, units);
    } catch {
      // Storage unavailable: units still work in-memory.
    }
  }, [units]);

  const value = useMemo<UnitsContextValue>(() => {
    const setUnits = (u: Units) => setUnitsState(u);
    return {
      units,
      setUnits,
      toggleUnits: () => setUnitsState((p) => (p === "metric" ? "imperial" : "metric")),
      fmt: makeFormatters(units),
    };
  }, [units]);

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
};

export function useUnits(): UnitsContextValue {
  const ctx = useContext(UnitsContext);
  if (!ctx) throw new Error("useUnits must be used within a UnitsProvider");
  return ctx;
}
