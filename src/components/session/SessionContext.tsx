"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

/**
 * Shared session spec: the car/track/conditions fields that every tab needs.
 * Set once, visible everywhere — persisted to localStorage so a reload or a
 * new visit keeps what was filled in. Tab-specific fields (telemetry results,
 * setup skill level, strategy tools, etc.) stay local to their tab.
 */
export interface SessionSpec {
  game: string;
  car: string;
  track: string;
  sessionType: string;
  weather: string;
  trackTemp: string;
  airTemp: string;
  tyreCompound: string;
  fuelLoad: string;
  driverStyle: string;
  handlingIssue: string;
}

const STORAGE_KEY = "apexwall.session.v1";

export const DEFAULT_SESSION: SessionSpec = {
  game: "Assetto Corsa Competizione",
  car: "",
  track: "",
  sessionType: "Practice / Hotlap",
  weather: "Dry",
  trackTemp: "30°C",
  airTemp: "22°C",
  tyreCompound: "DHE Slick",
  fuelLoad: "35 L",
  driverStyle: "Heavy Trail-Braker",
  handlingIssue: "",
};

export interface SessionContextValue extends SessionSpec {
  setGame: (v: string) => void;
  setCar: (v: string) => void;
  setTrack: (v: string) => void;
  setSessionType: (v: string) => void;
  setWeather: (v: string) => void;
  setTrackTemp: (v: string) => void;
  setAirTemp: (v: string) => void;
  setTyreCompound: (v: string) => void;
  setFuelLoad: (v: string) => void;
  setDriverStyle: (v: string) => void;
  setHandlingIssue: (v: string) => void;
  updateSession: (patch: Partial<SessionSpec>) => void;
  resetSession: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function loadStored(): SessionSpec {
  if (typeof window === "undefined") return DEFAULT_SESSION;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SESSION;
    const parsed = JSON.parse(raw) as Partial<SessionSpec>;
    // Merge over defaults so new fields added later still get sane values.
    return { ...DEFAULT_SESSION, ...parsed };
  } catch {
    return DEFAULT_SESSION;
  }
}

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [spec, setSpec] = useState<SessionSpec>(loadStored);

  // Persist on every change — cheap, small object.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(spec));
    } catch {
      // Storage full or unavailable: session still works in-memory.
    }
  }, [spec]);

  const updateSession = useCallback((patch: Partial<SessionSpec>) => {
    setSpec((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetSession = useCallback(() => {
    setSpec(DEFAULT_SESSION);
  }, []);

  const value: SessionContextValue = {
    ...spec,
    setGame: (v) => updateSession({ game: v }),
    setCar: (v) => updateSession({ car: v }),
    setTrack: (v) => updateSession({ track: v }),
    setSessionType: (v) => updateSession({ sessionType: v }),
    setWeather: (v) => updateSession({ weather: v }),
    setTrackTemp: (v) => updateSession({ trackTemp: v }),
    setAirTemp: (v) => updateSession({ airTemp: v }),
    setTyreCompound: (v) => updateSession({ tyreCompound: v }),
    setFuelLoad: (v) => updateSession({ fuelLoad: v }),
    setDriverStyle: (v) => updateSession({ driverStyle: v }),
    setHandlingIssue: (v) => updateSession({ handlingIssue: v }),
    updateSession,
    resetSession,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
