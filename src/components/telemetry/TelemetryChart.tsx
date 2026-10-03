import React, { useEffect, useRef, useState, useCallback } from "react";
import type { TelemetryPoint, MinCornerSpeed } from "@/types/telemetry";
import { useUnits } from "@/components/session/UnitsContext";

interface TelemetryChartProps {
  points: TelemetryPoint[];
  corners: MinCornerSpeed[];
}

type ChannelKey = "speed" | "throttle" | "brake" | "steer" | "latG";

const CHANNELS: { key: ChannelKey; label: string; color: string }[] = [
  { key: "speed", label: "Speed", color: "#38bdf8" },
  { key: "throttle", label: "Throttle", color: "#34d399" },
  { key: "brake", label: "Brake", color: "#f87171" },
  { key: "steer", label: "Steering", color: "#fbbf24" },
  { key: "latG", label: "Lat G", color: "#c084fc" },
];

/**
 * MoTeC-style multi-channel telemetry chart: synchronized distance traces
 * with corner markers and a hover scrubber.
 */
export const TelemetryChart: React.FC<TelemetryChartProps> = ({ points, corners }) => {
  const { units, fmt } = useUnits();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activeChannels, setActiveChannels] = useState<Set<ChannelKey>>(
    new Set<ChannelKey>(["speed", "throttle", "brake"])
  );
  const [hover, setHover] = useState<{ x: number; point: TelemetryPoint } | null>(null);
  const activeRef = useRef(activeChannels);
  activeRef.current = activeChannels;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;

  const toggleChannel = (key: ChannelKey) => {
    setActiveChannels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper || points.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = wrapper.getBoundingClientRect();
    const width = rect.width || 760;
    const height = 300;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const active = activeRef.current;
    const hoverState = hoverRef.current;

    const maxDist = points[points.length - 1].dist || 1;
    const padL = 44, padR = 44, padT = 30, padB = 28;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const maxSpeed = Math.max(...points.map((p) => p.speed), 1);
    const maxSteer = Math.max(...points.map((p) => Math.abs(p.steer)), 1);
    const maxLatG = Math.max(...points.map((p) => Math.abs(p.latG)), 0.5);

    const getX = (dist: number) => padL + (dist / maxDist) * plotW;

    // Normalize each channel to 0..1 for the shared plot area
    const norm = (p: TelemetryPoint, key: ChannelKey): number => {
      switch (key) {
        case "speed": return p.speed / maxSpeed;
        case "throttle": return p.throttle / 100;
        case "brake": return p.brake / 100;
        case "steer": return 0.5 + p.steer / maxSteer / 2; // centered
        case "latG": return 0.5 + p.latG / maxLatG / 2; // centered
      }
    };
    const getY = (v: number) => padT + plotH - v * plotH;

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillText(`${100 - i * 25}%`, padL - 6, y + 3);
    }

    // Distance ticks
    ctx.textAlign = "center";
    for (let i = 0; i <= 6; i++) {
      const frac = i / 6;
      const x = padL + plotW * frac;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, height - padB);
      ctx.stroke();
      ctx.fillText(`${Math.round(maxDist * frac)}m`, x, height - 10);
    }

    // Zero line for centered channels
    if (active.has("steer") || active.has("latG")) {
      const yMid = padT + plotH / 2;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.setLineDash([4, 3]);
      ctx.moveTo(padL, yMid);
      ctx.lineTo(width - padR, yMid);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Corner markers
    ctx.textAlign = "center";
    corners.forEach((c, idx) => {
      const x = getX(c.dist);
      if (x < padL || x > width - padR) return;
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath();
      ctx.moveTo(x, padT - 4);
      ctx.lineTo(x, height - padB);
      ctx.stroke();
      // label pill
      const label = `T${idx + 1}`;
      ctx.font = "9px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = "rgba(30,41,59,0.9)";
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      const bx = Math.min(Math.max(x - tw / 2, padL), width - padR - tw);
      ctx.beginPath();
      ctx.roundRect(bx, 4, tw, 15, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillText(label, bx + tw / 2, 15);
    });

    // Traces
    for (const ch of CHANNELS) {
      if (!active.has(ch.key)) continue;
      ctx.beginPath();
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = ch.key === "speed" ? 2 : 1.6;
      ctx.lineJoin = "round";
      let started = false;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        // skip teleport gaps
        if (i > 0) {
          const prev = points[i - 1];
          if (Math.abs(p.dist - prev.dist) > 500 && p.dist < prev.dist) {
            started = false;
            continue;
          }
        }
        const x = getX(p.dist);
        const y = getY(norm(p, ch.key));
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Hover scrubber
    if (hoverState) {
      const { x, point } = hoverState;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.moveTo(x, padT - 4);
      ctx.lineTo(x, height - padB);
      ctx.stroke();
      for (const ch of CHANNELS) {
        if (!active.has(ch.key)) continue;
        const y = getY(norm(point, ch.key));
        ctx.beginPath();
        ctx.fillStyle = ch.color;
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1;
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Speed scale label (left axis top)
    ctx.fillStyle = "rgba(56,189,248,0.7)";
    ctx.textAlign = "left";
    ctx.font = "9px 'JetBrains Mono', monospace";
    if (active.has("speed")) {
      ctx.fillText(`SPD max ${fmt.speed(maxSpeed, 0)}`, padL + 4, padT - 8);
    }

    ctx.restore();
  }, [points, corners, fmt]);

  useEffect(() => {
    draw();
  }, [draw, activeChannels, hover]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const onMouseMove = (e: React.MouseEvent) => {
    const wrapper = wrapperRef.current;
    if (!wrapper || points.length < 2) return;
    const rect = wrapper.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padL = 44, padR = 44;
    const plotW = rect.width - padL - padR;
    const maxDist = points[points.length - 1].dist || 1;
    const frac = Math.min(Math.max((x - padL) / plotW, 0), 1);
    const targetDist = frac * maxDist;
    // binary search nearest point
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].dist < targetDist) lo = mid + 1;
      else hi = mid;
    }
    const idx = Math.max(0, Math.min(points.length - 1, lo));
    setHover({ x: padL + (points[idx].dist / maxDist) * plotW, point: points[idx] });
  };

  const fmtVal = (p: TelemetryPoint, key: ChannelKey): string => {
    switch (key) {
      case "speed": return fmt.speed(p.speed, 0);
      case "throttle": return `${Math.round(p.throttle)}%`;
      case "brake": return `${Math.round(p.brake)}%`;
      case "steer": return `${p.steer.toFixed(1)}°`;
      case "latG": return `${p.latG.toFixed(2)}G`;
    }
  };

  return (
    <div className="telemetry-chart-wrap">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Multi-channel telemetry <span className="text-slate-600 normal-case font-medium">· distance trace</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CHANNELS.map((ch) => (
            <button
              key={ch.key}
              type="button"
              onClick={() => toggleChannel(ch.key)}
              className={`text-[10px] px-2 py-1 rounded-md font-mono border transition ${
                activeChannels.has(ch.key)
                  ? "text-white border-transparent"
                  : "text-slate-500 border-slate-700/60 hover:text-slate-300"
              }`}
              style={activeChannels.has(ch.key) ? { backgroundColor: `${ch.color}33`, borderColor: `${ch.color}66`, color: ch.color } : undefined}
            >
              <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: ch.color, opacity: activeChannels.has(ch.key) ? 1 : 0.3 }} />
              {ch.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={wrapperRef}
        className="relative rounded-xl border border-slate-700/40 bg-slate-950/60 overflow-hidden cursor-crosshair"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: 300, display: "block" }} />
        {hover && (
          <div
            className="absolute pointer-events-none text-[10px] font-mono bg-slate-900/95 border border-slate-600/60 rounded-lg px-2 py-1.5 shadow-xl"
            style={{
              left: Math.min(Math.max(hover.x + 12, 8), (wrapperRef.current?.getBoundingClientRect().width || 300) - 150),
              top: 34,
            }}
          >
            <div className="text-slate-400 mb-1">{Math.round(hover.point.dist)}m</div>
            {CHANNELS.filter((c) => activeChannels.has(c.key)).map((ch) => (
              <div key={ch.key} className="flex justify-between gap-3">
                <span style={{ color: ch.color }}>{ch.label}</span>
                <span className="text-slate-200">{fmtVal(hover.point, ch.key)}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 mt-1 pt-1 border-t border-slate-700/60">
              <span className="text-slate-500">Gear</span>
              <span className="text-slate-200">{hover.point.gear}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">RPM</span>
              <span className="text-slate-200">{Math.round(hover.point.rpm).toLocaleString()}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
