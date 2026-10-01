"use client";

import React, { useState, useMemo } from "react";
import {
  TYRE_PRESETS,
  calculateCompensatedPressures,
  TyreCalculationResult,
} from "@/lib/tyre-calculator";
import { useUnits } from "@/components/session/UnitsContext";
import { psiToBar, barToPsi } from "@/lib/units";

interface TyrePressureCalculatorProps {
  initialTrackTemp?: number;
  onApplyPressures?: (pressures: { FL: number; FR: number; RL: number; RR: number }) => void;
}

export const TyrePressureCalculator: React.FC<TyrePressureCalculatorProps> = ({
  initialTrackTemp = 30,
  onApplyPressures,
}) => {
  const { units, fmt } = useUnits();
  const [selectedPresetId, setSelectedPresetId] = useState(TYRE_PRESETS[0].id);
  const [trackTemp, setTrackTemp] = useState<number>(initialTrackTemp);
  const [circuitDirection, setCircuitDirection] = useState<"clockwise" | "counter-clockwise" | "balanced">(
    "clockwise"
  );
  const [isEmpirical, setIsEmpirical] = useState<boolean>(false);

  // Empirical previous run inputs
  const [empiricalCold, setEmpiricalCold] = useState({ FL: 26.2, FR: 26.5, RL: 25.9, RR: 26.2 });
  const [empiricalHot, setEmpiricalHot] = useState({ FL: 27.2, FR: 27.4, RL: 26.8, RR: 27.0 });
  const [appliedFeedback, setAppliedFeedback] = useState(false);

  // Empirical inputs are psi-native in state; show them in the user's units.
  const imperial = units === "imperial";
  const dispP = (psi: number): number => (imperial ? Math.round(psi * 10) / 10 : Math.round(psiToBar(psi) * 100) / 100);
  const parseP = (raw: string, fallbackPsi: number): number => {
    const v = parseFloat(raw);
    if (Number.isNaN(v)) return fallbackPsi;
    return imperial ? v : barToPsi(v);
  };
  const pStep = imperial ? 0.1 : 0.01;

  const result: TyreCalculationResult = useMemo(() => {
    return calculateCompensatedPressures({
      presetId: selectedPresetId,
      trackTemp,
      circuitDirection,
      currentColdPressures: isEmpirical ? empiricalCold : undefined,
      observedHotPressures: isEmpirical ? empiricalHot : undefined,
    });
  }, [selectedPresetId, trackTemp, circuitDirection, isEmpirical, empiricalCold, empiricalHot]);

  const handleApply = () => {
    onApplyPressures?.(result.recommendedCold);
    setAppliedFeedback(true);
    setTimeout(() => setAppliedFeedback(false), 2500);
  };

  return (
    <div className="tyre-calc-card glass-card-nested">
      {/* Header */}
      <div className="calc-header">
        <div className="calc-title-group">
          <div className="calc-badge-row">
            <span className="calc-badge">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 3v18" />
                <path d="M3 12h18" />
              </svg>
              TYRE PRESSURE & THERMAL COMPENSATOR
            </span>
            <span className="calc-target-pill">
              TARGET: <strong>{fmt.pressurePsi(result.targetHot)} HOT</strong>
            </span>
          </div>
          <h3 className="calc-title">Optimal Cold Starting Pressure Calculator</h3>
          <p className="calc-sub">
            Compensates for track temperature fluctuations and circuit loading asymmetry to hit peak operating pressures on lap 3.
          </p>
        </div>

        {/* Mode Toggle */}
        <div className="calc-mode-switch">
          <button
            type="button"
            className={`calc-mode-btn ${!isEmpirical ? "active" : ""}`}
            onClick={() => setIsEmpirical(false)}
          >
            Thermodynamic Model
          </button>
          <button
            type="button"
            className={`calc-mode-btn ${isEmpirical ? "active" : ""}`}
            onClick={() => setIsEmpirical(true)}
          >
            Empirical Stint Data
          </button>
        </div>
      </div>

      {/* Inputs Bar */}
      <div className="calc-inputs-grid">
        <div className="calc-field">
          <label className="field-label">Sim & Compound Homologation</label>
          <select
            className="calc-select"
            value={selectedPresetId}
            onChange={(e) => setSelectedPresetId(e.target.value)}
          >
            {TYRE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (Hot: {fmt.pressurePsi(p.targetHotPressure)})
              </option>
            ))}
          </select>
        </div>

        <div className="calc-field">
          <div className="slider-label-row">
            <label className="field-label">Current Track Temperature</label>
            <span className="slider-val-badge">{fmt.temp(trackTemp)}</span>
          </div>
          <input
            type="range"
            min="10"
            max="55"
            step="1"
            value={trackTemp}
            onChange={(e) => setTrackTemp(parseInt(e.target.value, 10))}
            className="calc-slider"
          />
          <div className="slider-range-labels">
            <span>{fmt.temp(10)} (Cold)</span>
            <span>{fmt.temp(30)} (Baseline)</span>
            <span>{fmt.temp(55)} (Extreme)</span>
          </div>
        </div>

        <div className="calc-field">
          <label className="field-label">Circuit Turning Direction</label>
          <div className="segmented">
            <button
              type="button"
              className={`seg-btn ${circuitDirection === "clockwise" ? "active" : ""}`}
              onClick={() => setCircuitDirection("clockwise")}
            >
              Clockwise
            </button>
            <button
              type="button"
              className={`seg-btn ${circuitDirection === "counter-clockwise" ? "active" : ""}`}
              onClick={() => setCircuitDirection("counter-clockwise")}
            >
              Counter-Clock
            </button>
            <button
              type="button"
              className={`seg-btn ${circuitDirection === "balanced" ? "active" : ""}`}
              onClick={() => setCircuitDirection("balanced")}
            >
              Balanced
            </button>
          </div>
        </div>
      </div>

      {/* Empirical Previous Stint Inputs (Visible if Empirical Mode Active) */}
      {isEmpirical && (
        <div className="empirical-inputs-box">
          <div className="empirical-box-title">
            <span>INPUT PREVIOUS RUN PRESSURES (FROM PIT STOP / MOTEC)</span>
            <span className="hint-pill">Target Delta Correction</span>
          </div>
          <div className="empirical-quad-grid">
            <div className="emp-corner">
              <span className="corner-tag">FRONT LEFT</span>
              <div className="emp-inputs">
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalCold.FL)}
                  onChange={(e) => setEmpiricalCold({ ...empiricalCold, FL: parseP(e.target.value, 26) })}
                  title="Cold Pressure"
                />
                <span>→</span>
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalHot.FL)}
                  onChange={(e) => setEmpiricalHot({ ...empiricalHot, FL: parseP(e.target.value, 27) })}
                  title="Observed Hot"
                />
              </div>
            </div>

            <div className="emp-corner">
              <span className="corner-tag">FRONT RIGHT</span>
              <div className="emp-inputs">
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalCold.FR)}
                  onChange={(e) => setEmpiricalCold({ ...empiricalCold, FR: parseP(e.target.value, 26) })}
                  title="Cold Pressure"
                />
                <span>→</span>
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalHot.FR)}
                  onChange={(e) => setEmpiricalHot({ ...empiricalHot, FR: parseP(e.target.value, 27) })}
                  title="Observed Hot"
                />
              </div>
            </div>

            <div className="emp-corner">
              <span className="corner-tag">REAR LEFT</span>
              <div className="emp-inputs">
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalCold.RL)}
                  onChange={(e) => setEmpiricalCold({ ...empiricalCold, RL: parseP(e.target.value, 26) })}
                  title="Cold Pressure"
                />
                <span>→</span>
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalHot.RL)}
                  onChange={(e) => setEmpiricalHot({ ...empiricalHot, RL: parseP(e.target.value, 27) })}
                  title="Observed Hot"
                />
              </div>
            </div>

            <div className="emp-corner">
              <span className="corner-tag">REAR RIGHT</span>
              <div className="emp-inputs">
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalCold.RR)}
                  onChange={(e) => setEmpiricalCold({ ...empiricalCold, RR: parseP(e.target.value, 26) })}
                  title="Cold Pressure"
                />
                <span>→</span>
                <input
                  type="number"
                  step={pStep}
                  value={dispP(empiricalHot.RR)}
                  onChange={(e) => setEmpiricalHot({ ...empiricalHot, RR: parseP(e.target.value, 27) })}
                  title="Observed Hot"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4-Corner Calculated Pressure Quad HUD */}
      <div className="tyre-results-section">
        <div className="tyre-quad-layout">
          {/* Front Left */}
          <div className="tyre-quad-card card-fl">
            <div className="quad-card-top">
              <span className="quad-pos-badge">FRONT LEFT (FL)</span>
              <span className="quad-gain-pill">+{fmt.pressurePsi(result.expectedGain.FL)} hot gain</span>
            </div>
            <div className="quad-main-val">
              <span className="quad-val">{fmt.pressurePsi(result.recommendedCold.FL).split(" ")[0]}</span>
              <span className="quad-unit">{fmt.pressureUnit.toUpperCase()} COLD</span>
            </div>
            <div className="quad-sub-metric">
              Target Hot: <strong>{fmt.pressurePsi(result.expectedHot.FL)}</strong>
            </div>
          </div>

          {/* Front Right */}
          <div className="tyre-quad-card card-fr">
            <div className="quad-card-top">
              <span className="quad-pos-badge">FRONT RIGHT (FR)</span>
              <span className="quad-gain-pill">+{fmt.pressurePsi(result.expectedGain.FR)} hot gain</span>
            </div>
            <div className="quad-main-val">
              <span className="quad-val">{fmt.pressurePsi(result.recommendedCold.FR).split(" ")[0]}</span>
              <span className="quad-unit">{fmt.pressureUnit.toUpperCase()} COLD</span>
            </div>
            <div className="quad-sub-metric">
              Target Hot: <strong>{fmt.pressurePsi(result.expectedHot.FR)}</strong>
            </div>
          </div>

          {/* Rear Left */}
          <div className="tyre-quad-card card-rl">
            <div className="quad-card-top">
              <span className="quad-pos-badge">REAR LEFT (RL)</span>
              <span className="quad-gain-pill">+{fmt.pressurePsi(result.expectedGain.RL)} hot gain</span>
            </div>
            <div className="quad-main-val">
              <span className="quad-val">{fmt.pressurePsi(result.recommendedCold.RL).split(" ")[0]}</span>
              <span className="quad-unit">{fmt.pressureUnit.toUpperCase()} COLD</span>
            </div>
            <div className="quad-sub-metric">
              Target Hot: <strong>{fmt.pressurePsi(result.expectedHot.RL)}</strong>
            </div>
          </div>

          {/* Rear Right */}
          <div className="tyre-quad-card card-rr">
            <div className="quad-card-top">
              <span className="quad-pos-badge">REAR RIGHT (RR)</span>
              <span className="quad-gain-pill">+{fmt.pressurePsi(result.expectedGain.RR)} hot gain</span>
            </div>
            <div className="quad-main-val">
              <span className="quad-val">{fmt.pressurePsi(result.recommendedCold.RR).split(" ")[0]}</span>
              <span className="quad-unit">{fmt.pressureUnit.toUpperCase()} COLD</span>
            </div>
            <div className="quad-sub-metric">
              Target Hot: <strong>{fmt.pressurePsi(result.expectedHot.RR)}</strong>
            </div>
          </div>
        </div>

        {/* Engineer Notes & Apply Bar */}
        <div className="calc-action-bar">
          <div className="calc-notes-text">
            <span className="notes-dot"></span>
            <span>{result.circuitLoadingNotes}</span>
          </div>

          {onApplyPressures && (
            <button
              type="button"
              className={`calc-apply-btn ${appliedFeedback ? "applied" : ""}`}
              onClick={handleApply}
            >
              {appliedFeedback ? "✓ Pressures Applied to Setup" : "Apply Pressures to Setup →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
