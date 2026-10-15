"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRealtimeClient, type SealedLiveQuery } from "@neon/realtime/client";
import { RealtimeProvider, useLiveQuery } from "@neon/realtime-react";

interface LapRow {
  id: number;
  lap_number: number;
  lap_time: number | null;
  is_valid: boolean;
  is_out_lap: boolean;
  is_in_lap: boolean;
  sector_times: number[] | null;
  created_at: string;
}

interface Boot {
  url: string;
  session: {
    id: string;
    game?: string | null;
    car?: string | null;
    track?: string | null;
    started_at?: string | null;
    lap_count?: number | null;
    best_lap_time?: number | null;
  } | null;
  sealedQuery: SealedLiveQuery<LapRow> | null;
  laps: LapRow[];
}

function fmtLap(t?: number | null): string {
  if (t == null || !isFinite(t)) return "—";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function fmtSector(t?: number | null): string {
  return t == null || !isFinite(t) ? "—" : t.toFixed(3);
}

async function fetchBoot(): Promise<Boot> {
  const res = await fetch("/api/realtime/live-laps", {
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) throw new Error("Sign in to view your live session.");
  if (!res.ok) throw new Error(`Live feed unavailable (${res.status}).`);
  return res.json();
}

function LapBoard({
  boot,
  refreshQuery,
}: {
  boot: Boot;
  refreshQuery: () => Promise<SealedLiveQuery<LapRow>>;
}) {
  const { data, status, error } = useLiveQuery<LapRow>(boot.sealedQuery!, {
    initialData: boot.laps,
    refreshQuery,
  });
  const laps = (data ?? boot.laps) as LapRow[];
  const validTimes = laps
    .filter((l) => l.is_valid && !l.is_out_lap && !l.is_in_lap && l.lap_time != null)
    .map((l) => l.lap_time as number);
  const best = validTimes.length ? Math.min(...validTimes) : null;
  const last = laps.length ? laps[laps.length - 1] : null;

  const statusPill =
    status === "live"
      ? { label: "● LIVE", cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" }
      : status === "connecting"
        ? { label: "CONNECTING…", cls: "text-amber-300 border-amber-500/40 bg-amber-500/10" }
        : status === "stale"
          ? { label: "RENEWING…", cls: "text-slate-300 border-white/20 bg-white/5" }
          : status === "error"
            ? { label: "CONNECTION ERROR", cls: "text-red-300 border-red-500/40 bg-red-500/10" }
            : { label: "CLOSED", cls: "text-slate-400 border-white/10 bg-white/5" };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <div className="text-[11px] tracking-[0.25em] text-[#d4a373] font-mono mb-1">
            {boot.session?.game || "SESSION"} — LIVE TIMING
          </div>
          <h1 className="text-2xl md:text-3xl font-semibold text-slate-100">
            {boot.session?.car || "Car"} <span className="text-slate-500">@</span>{" "}
            {boot.session?.track || "Track"}
          </h1>
          {boot.session?.started_at && (
            <div className="text-xs text-slate-400 mt-1">
              Started {new Date(boot.session.started_at).toLocaleString()}
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[10px] tracking-widest text-slate-400">BEST LAP</div>
            <div className="text-3xl font-mono text-[#f7ebe1]">{fmtLap(best)}</div>
            {last && (
              <div className="text-xs font-mono text-slate-400">
                Last: {fmtLap(last.lap_time)}
              </div>
            )}
          </div>
          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${statusPill.cls}`}>
            {statusPill.label}
          </span>
        </div>
      </div>

      {status === "error" && error && (
        <div className="mb-4 text-sm text-red-300 border border-red-500/30 bg-red-500/10 rounded-lg px-3 py-2">
          {error.message}
        </div>
      )}

      {laps.length === 0 ? (
        <div className="border border-white/10 rounded-xl bg-white/[0.03] p-8 text-center text-slate-300">
          Session is live — waiting for the first lap from the bridge…
        </div>
      ) : (
        <div className="overflow-x-auto border border-white/10 rounded-xl">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="bg-white/[0.04] text-slate-400 text-left">
                <th className="px-3 py-2 font-medium">LAP</th>
                <th className="px-3 py-2 font-medium">TIME</th>
                <th className="px-3 py-2 font-medium">GAP</th>
                <th className="px-3 py-2 font-medium">S1</th>
                <th className="px-3 py-2 font-medium">S2</th>
                <th className="px-3 py-2 font-medium">S3</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {[...laps].reverse().map((l) => {
                const isBest =
                  best != null && l.lap_time === best && l.is_valid && !l.is_out_lap && !l.is_in_lap;
                const gap =
                  best != null && l.lap_time != null && l.is_valid && !isBest
                    ? `+${(l.lap_time - best).toFixed(3)}`
                    : "";
                return (
                  <tr
                    key={l.id}
                    className={`border-t border-white/5 ${isBest ? "bg-[#d4a373]/10 text-[#f7ebe1]" : "text-slate-200"}`}
                  >
                    <td className="px-3 py-2">{l.lap_number}</td>
                    <td className="px-3 py-2 font-semibold">{fmtLap(l.lap_time)}</td>
                    <td className="px-3 py-2 text-slate-400">{gap}</td>
                    <td className="px-3 py-2">{fmtSector(l.sector_times?.[0])}</td>
                    <td className="px-3 py-2">{fmtSector(l.sector_times?.[1])}</td>
                    <td className="px-3 py-2">{fmtSector(l.sector_times?.[2])}</td>
                    <td className="px-3 py-2 text-[10px] tracking-wider">
                      {l.is_out_lap ? (
                        <span className="text-sky-300">OUT LAP</span>
                      ) : l.is_in_lap ? (
                        <span className="text-sky-300">IN LAP</span>
                      ) : !l.is_valid ? (
                        <span className="text-red-300">INVALID</span>
                      ) : isBest ? (
                        <span className="text-[#d4a373]">BEST</span>
                      ) : (
                        ""
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500 mt-3">
        Laps appear here live as the bridge uploads them — no refresh needed. Powered by Neon
        Realtime live SQL over the lap_telemetry table.
      </p>
    </div>
  );
}

export default function LivePitwall() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");

  const load = useCallback(async (silent = false) => {
    try {
      const b = await fetchBoot();
      if (!b.session || !b.sealedQuery) {
        if (!silent) setState("empty");
        return null;
      }
      setBoot((prev) => {
        if (prev && prev.session?.id === b.session!.id && silent) return prev;
        return b;
      });
      setState("ready");
      return b;
    } catch (e: any) {
      if (!silent) {
        setErrMsg(e?.message || "Could not load the live feed.");
        setState("error");
      }
      return null;
    }
  }, []);

  useEffect(() => {
    load();
    // Pick up a newly started session without a manual refresh.
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [load]);

  const client = useMemo(
    () => (boot?.url ? createRealtimeClient({ url: boot.url }) : null),
    [boot?.url]
  );

  const refreshQuery = useCallback(async () => {
    const b = await fetchBoot();
    if (!b.sealedQuery) throw new Error("No live session to renew.");
    return b.sealedQuery;
  }, []);

  if (state === "loading") {
    return <div className="text-slate-300 text-sm">Connecting to the live timing feed…</div>;
  }
  if (state === "error") {
    return (
      <div className="border border-red-500/30 bg-red-500/10 rounded-xl p-6 text-red-200 text-sm">
        {errMsg}
      </div>
    );
  }
  if (state === "empty" || !boot || !client) {
    return (
      <div className="border border-white/10 rounded-xl bg-white/[0.03] p-8 text-center">
        <div className="text-slate-100 font-semibold mb-1">No sessions yet</div>
        <p className="text-sm text-slate-400">
          Start the bridge and complete a lap — your live timing will appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <RealtimeProvider client={client}>
      <LapBoard key={boot.session!.id} boot={boot} refreshQuery={refreshQuery} />
    </RealtimeProvider>
  );
}
