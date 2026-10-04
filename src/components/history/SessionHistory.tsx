"use client";

import React, { useState, useEffect, useCallback } from "react";
import { formatLapTime } from "@/lib/fuel-calculator";

// ============================================================================
// Types (mirror the /api/sessions backend)
// ============================================================================

interface SessionSummary {
  id: string;
  game: string | null;
  car: string | null;
  track: string | null;
  started_at: string;
  ended_at: string | null;
  lap_count: number | null;
  best_lap_time: number | null;
  source: string | null;
}

interface LapRow {
  lap_number: number;
  lap_time: number | null;
  is_valid: boolean;
  is_out_lap: boolean;
  is_in_lap: boolean;
  sector_times: number[] | string | null;
  sector_valid: boolean[] | string | null;
  sample_rate: number | null;
  sample_count: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return iso;
  }
}

function fmtLapTime(v: number | null | undefined): string {
  if (v == null || !isFinite(v) || v <= 0) return "—";
  return formatLapTime(v);
}

/** pg REAL[] may arrive as a JS array or a "{a,b,c}" string. */
function toNumberArray(v: number[] | string | null | undefined): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(Number).filter((n) => isFinite(n));
  if (typeof v === "string") {
    const inner = v.replace(/^\{|\}$/g, "");
    if (!inner.trim()) return null;
    return inner.split(",").map((s) => Number(s.trim())).filter((n) => isFinite(n));
  }
  return null;
}

function fmtSector(v: number | null | undefined): string {
  if (v == null || !isFinite(v) || v <= 0) return "—";
  return v.toFixed(3);
}

// ============================================================================
// Minimal SVG sparkline (no charting dependency)
// ============================================================================

function Sparkline({ values, width = 160, height = 40 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) {
    return <span className="text-[11px] text-slate-500">Need 2+ sessions for trend</span>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    // Lower lap time = better → higher on the chart
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = pts[0].split(",");
  const last = pts[pts.length - 1].split(",");
  const improved = values[values.length - 1] < values[0];
  const stroke = improved ? "#34d399" : "#f87171";
  return (
    <svg width={width} height={height} className="overflow-visible" role="img" aria-label="Best lap trend">
      <polyline points={pts.join(" ")} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={first[0]} cy={first[1]} r="2.5" fill="#64748b" />
      <circle cx={last[0]} cy={last[1]} r="3" fill={stroke} />
    </svg>
  );
}

// ============================================================================
// Lap badge
// ============================================================================

function LapBadge({ lap }: { lap: LapRow }) {
  if (!lap.is_valid)
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30">Invalid</span>;
  if (lap.is_out_lap)
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">Out lap</span>;
  if (lap.is_in_lap)
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">In lap</span>;
  return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">Valid</span>;
}

// ============================================================================
// Main component
// ============================================================================

export const SessionHistory: React.FC = () => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [laps, setLaps] = useState<LapRow[]>([]);
  const [lapsLoading, setLapsLoading] = useState(false);
  const [trackFilter, setTrackFilter] = useState<string>("all");

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", { credentials: "same-origin" });
      if (res.status === 401) {
        setUnauthorized(true);
        setSessions([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUnauthorized(false);
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (e: any) {
      setError(e?.message || "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setLaps([]);
      return;
    }
    setExpandedId(id);
    setLapsLoading(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLaps(Array.isArray(data.laps) ? data.laps : []);
    } catch {
      setLaps([]);
    } finally {
      setLapsLoading(false);
    }
  };

  // Trend: best lap over time for the expanded session's track+car
  const expandedSession = sessions.find((s) => s.id === expandedId) || null;
  const trendSessions = expandedSession
    ? sessions
        .filter(
          (s) =>
            (s.track || "") === (expandedSession.track || "") &&
            (s.car || "") === (expandedSession.car || "") &&
            s.best_lap_time != null &&
            s.best_lap_time > 0
        )
        .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
    : [];

  const tracks = Array.from(new Set(sessions.map((s) => s.track || "Unknown"))).sort();
  const visibleSessions =
    trackFilter === "all" ? sessions : sessions.filter((s) => (s.track || "Unknown") === trackFilter);

  if (loading) {
    return (
      <div className="rounded-xl bg-slate-900/50 border border-slate-800 p-8 text-center text-sm text-slate-400">
        Loading session history…
      </div>
    );
  }

  if (unauthorized) {
    return (
      <div className="rounded-xl bg-slate-900/50 border border-slate-800 p-8 text-center">
        <div className="text-sm font-semibold text-slate-200 mb-1">Sign in to view session history</div>
        <div className="text-xs text-slate-500">Your logged laps are stored per driver account.</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl bg-slate-900/50 border border-rose-500/30 p-8 text-center">
        <div className="text-sm font-semibold text-rose-400 mb-2">Couldn&apos;t load sessions</div>
        <div className="text-xs text-slate-500 mb-3">{error}</div>
        <button
          type="button"
          onClick={fetchSessions}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header + filters */}
      <div className="px-3.5 py-2.5 rounded-xl bg-slate-900/50 border border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-bold text-white tracking-tight">Session History</div>
          <div className="text-[11px] text-slate-500">
            {sessions.length} session{sessions.length === 1 ? "" : "s"} logged
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tracks.length > 1 && (
            <select
              value={trackFilter}
              onChange={(e) => setTrackFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 outline-none focus:border-blue-500"
              aria-label="Filter by track"
            >
              <option value="all">All tracks</option>
              {tracks.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={fetchSessions}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 transition-all"
          >
            Refresh
          </button>
        </div>
      </div>

      {visibleSessions.length === 0 && (
        <div className="rounded-xl bg-slate-900/50 border border-slate-800 p-8 text-center">
          <div className="text-sm font-semibold text-slate-200 mb-1">No sessions yet</div>
          <div className="text-xs text-slate-500">
            Analyze telemetry or log laps from the rig bridge and they&apos;ll appear here.
          </div>
        </div>
      )}

      {visibleSessions.map((s) => {
        const isOpen = expandedId === s.id;
        return (
          <div key={s.id} className="rounded-xl bg-slate-900/50 border border-slate-800 overflow-hidden">
            <button
              type="button"
              onClick={() => toggleExpand(s.id)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-800/40 transition-colors"
            >
              <span className={`text-slate-500 transition-transform text-xs ${isOpen ? "rotate-90" : ""}`}>▶</span>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="text-sm font-bold text-white truncate">{s.track || "Unknown track"}</span>
                  <span className="text-xs text-slate-400 truncate">{s.car || "Unknown car"}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {fmtDate(s.started_at)}
                  {s.game ? ` · ${s.game}` : ""}
                  {s.source ? ` · ${s.source}` : ""}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-bold text-blue-400 font-mono">{fmtLapTime(s.best_lap_time)}</div>
                <div className="text-[11px] text-slate-500">
                  {s.lap_count ?? "—"} lap{(s.lap_count ?? 0) === 1 ? "" : "s"}
                </div>
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-slate-800 px-4 py-3 space-y-3">
                {/* Trend for this track+car */}
                {trendSessions.length >= 1 && (
                  <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2.5 flex items-center gap-4 flex-wrap">
                    <div>
                      <div className="text-[11px] font-semibold text-slate-300">
                        Best lap trend · {expandedSession?.track}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {trendSessions.length} session{trendSessions.length === 1 ? "" : "s"} ·{" "}
                        {expandedSession?.car}
                      </div>
                    </div>
                    <Sparkline values={trendSessions.map((t) => t.best_lap_time as number)} />
                    <div className="text-[11px] text-slate-500 font-mono">
                      {fmtLapTime(Math.min(...trendSessions.map((t) => t.best_lap_time as number)))} best
                    </div>
                  </div>
                )}

                {lapsLoading ? (
                  <div className="text-xs text-slate-500 py-2">Loading laps…</div>
                ) : laps.length === 0 ? (
                  <div className="text-xs text-slate-500 py-2">No laps recorded for this session.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                          <th className="py-1.5 pr-3 font-semibold">Lap</th>
                          <th className="py-1.5 pr-3 font-semibold">Time</th>
                          <th className="py-1.5 pr-3 font-semibold">S1</th>
                          <th className="py-1.5 pr-3 font-semibold">S2</th>
                          <th className="py-1.5 pr-3 font-semibold">S3</th>
                          <th className="py-1.5 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {laps.map((lap) => {
                          const sectors = toNumberArray(lap.sector_times);
                          const isBest =
                            lap.is_valid &&
                            lap.lap_time != null &&
                            lap.lap_time > 0 &&
                            laps
                              .filter((l) => l.is_valid && l.lap_time != null && l.lap_time > 0)
                              .every((l) => (l.lap_time as number) >= (lap.lap_time as number));
                          return (
                            <tr key={lap.lap_number} className="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30">
                              <td className="py-1.5 pr-3 font-mono text-slate-300">{lap.lap_number}</td>
                              <td className={`py-1.5 pr-3 font-mono font-semibold ${isBest ? "text-emerald-400" : "text-slate-200"}`}>
                                {fmtLapTime(lap.lap_time)}
                                {isBest && <span className="ml-1.5 text-[9px] text-emerald-500 font-sans">BEST</span>}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-slate-400">{fmtSector(sectors?.[0])}</td>
                              <td className="py-1.5 pr-3 font-mono text-slate-400">{fmtSector(sectors?.[1])}</td>
                              <td className="py-1.5 pr-3 font-mono text-slate-400">{fmtSector(sectors?.[2])}</td>
                              <td className="py-1.5"><LapBadge lap={lap} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default SessionHistory;
