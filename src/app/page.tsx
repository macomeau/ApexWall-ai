"use client";

import React, { useState, useEffect } from "react";
import { CockpitNavbar } from "@/components/CockpitNavbar";
import { WorkspaceMode } from "@/components/ModeNavigation";
import { SetupGenerator } from "@/components/setup/SetupGenerator";
import { TelemetryAnalyzer } from "@/components/telemetry/TelemetryAnalyzer";
import { LiveTelemetryHUD } from "@/components/telemetry/LiveTelemetryHUD";
import { StrategyTools } from "@/components/tools/StrategyTools";
import { SetupVaultModal } from "@/components/vault/SetupVaultModal";
import { AuthModal } from "@/components/auth/AuthModal";
import { Footer } from "@/components/Footer";
import { SavedSetupRecord, getSavedSetups } from "@/lib/setup-vault";
import { RaceEngineerChat } from "@/components/engineer/RaceEngineerChat";
import { SetupExportContext } from "@/lib/setup-exporter";
import { TelemetryAnalysisResult, ParsedTelemetryFile } from "@/types/telemetry";
import { SessionProvider, useSession } from "@/components/session/SessionContext";
import { UnitsProvider, useUnits } from "@/components/session/UnitsContext";

export default function Home() {
  return (
    <UnitsProvider>
      <SessionProvider>
        <HomeInner />
      </SessionProvider>
    </UnitsProvider>
  );
}

function HomeInner() {
  const [mode, setMode] = useState<WorkspaceMode>("telemetry");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isVaultOpen, setIsVaultOpen] = useState<boolean>(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [savedSetupsCount, setSavedSetupsCount] = useState<number>(0);

  const [lastGeneratedSetup, setLastGeneratedSetup] = useState<SetupExportContext | null>(null);
  const [lastTelemetryResult, setLastTelemetryResult] = useState<TelemetryAnalysisResult | null>(null);
  const [lastTelemetryFile, setLastTelemetryFile] = useState<ParsedTelemetryFile | null>(null);

  // Shared session spec — car/track/conditions filled in on any tab are
  // visible on every tab, and persist across visits via localStorage.
  const session = useSession();
  const { fmt } = useUnits();

  const scrollTop = () => {
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // Sync count of saved setups from local storage
  useEffect(() => {
    const refreshVaultCount = () => {
      const list = getSavedSetups();
      setSavedSetupsCount(list.length);
    };
    refreshVaultCount();
    window.addEventListener("simsetup_vault_updated", refreshVaultCount);
    window.addEventListener("storage", refreshVaultCount);
    return () => {
      window.removeEventListener("simsetup_vault_updated", refreshVaultCount);
      window.removeEventListener("storage", refreshVaultCount);
    };
  }, [isVaultOpen]);

  const handleApplyToSetup = (setupContext: {
    game: string;
    car: string;
    track: string;
    trackTemp: string;
    airTemp: string;
    tyreCompound: string;
    fuelLoad: string;
    handlingIssue: string;
  }) => {
    // Spec fields are already shared — just carry the AI diagnosis over.
    session.updateSession(setupContext);
    setMode("setup");
    scrollTop();
  };

  const handleApplyPressures = (pressures: { FL: number; FR: number; RL: number; RR: number }) => {
    // Calculator outputs psi-native numbers; render them in the user's units.
    const p = (psi: number) => fmt.pressurePsi(psi);
    const pressureSummary = `Target Cold Pressures: FL ${p(pressures.FL)}, FR ${p(pressures.FR)}, RL ${p(pressures.RL)}, RR ${p(pressures.RR)}`;
    session.setHandlingIssue(
      session.handlingIssue
        ? `${session.handlingIssue}. Calibrated tyre pressures: FL ${p(pressures.FL)}, FR ${p(pressures.FR)}, RL ${p(pressures.RL)}, RR ${p(pressures.RR)}`
        : pressureSummary
    );
    setMode("setup");
    scrollTop();
  };

  const handleApplyFuel = (liters: number) => {
    session.setFuelLoad(`${liters} L`);
    setMode("setup");
    scrollTop();
  };

  const handleLoadFromVault = (saved: SavedSetupRecord) => {
    session.updateSession({
      game: saved.game,
      car: saved.car,
      track: saved.track,
      sessionType: saved.sessionType,
      weather: saved.weather,
      trackTemp: saved.trackTemp,
      airTemp: saved.airTemp,
      handlingIssue: saved.summary || "",
    });
    setMode("setup");
    scrollTop();
  };

  return (
    <div className="min-h-screen flex flex-col justify-between bg-[var(--bg-base)] text-[var(--text-primary)] transition-colors duration-200">
      <div>
        <CockpitNavbar
          mode={mode}
          onChangeMode={setMode}
          onOpenVault={() => setIsVaultOpen(true)}
          onOpenAuth={() => setIsAuthModalOpen(true)}
          savedSetupsCount={savedSetupsCount}
          isLoading={isLoading}
          activeCar={session.car || "—"}
          activeTrack={session.track || "—"}
        />

        {/* Dynamic Workspace Container */}
        <main className="w-full max-w-[1780px] mx-auto px-3 sm:px-5 py-3">
          <div style={{ display: mode === "setup" ? "block" : "none" }}>
            <SetupGenerator
              onLoadingChange={setIsLoading}
              onSetupGenerated={setLastGeneratedSetup}
              onDiscussWithEngineer={() => setMode("engineer")}
            />
          </div>

          <div style={{ display: mode === "telemetry" ? "block" : "none" }}>
            <TelemetryAnalyzer
              onLoadingChange={setIsLoading}
              onApplyToSetup={handleApplyToSetup}
              onTelemetryAnalyzed={(res, file) => {
                setLastTelemetryResult(res);
                setLastTelemetryFile(file);
              }}
              onDiscussWithEngineer={() => setMode("engineer")}
            />
          </div>

          <div style={{ display: mode === "engineer" ? "block" : "none" }}>
            <RaceEngineerChat
              currentSetup={lastGeneratedSetup}
              telemetryResult={lastTelemetryResult}
              parsedTelemetry={lastTelemetryFile}
              onApplyAdjustmentToSetup={(advice) => {
                session.setHandlingIssue(
                  session.handlingIssue
                    ? `${session.handlingIssue}. Engineer guidance: ${advice.slice(0, 150)}`
                    : advice.slice(0, 180)
                );
              }}
              onSwitchToSetup={() => setMode("setup")}
            />
          </div>

          <div style={{ display: mode === "strategy" ? "block" : "none" }}>
            <StrategyTools
              onApplyPressuresToSetup={handleApplyPressures}
              onApplyFuelToSetup={handleApplyFuel}
            />
          </div>

          <div style={{ display: mode === "live" ? "block" : "none" }}>
            <LiveTelemetryHUD />
          </div>
        </main>
      </div>

      {/* Setup Vault & Diff Modal */}
      <SetupVaultModal
        isOpen={isVaultOpen}
        onClose={() => setIsVaultOpen(false)}
        onLoadSetup={handleLoadFromVault}
      />

      {/* Driver Authentication Modal (Google & Credentials) */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />

      <Footer />
    </div>
  );
}
