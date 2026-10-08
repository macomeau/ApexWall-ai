"use client";

import React, { useState, useRef, useEffect } from "react";
import { SetupExportContext } from "@/lib/setup-exporter";
import { TelemetryAnalysisResult, ParsedTelemetryFile } from "@/types/telemetry";
import { useUnits } from "@/components/session/UnitsContext";
import { kmhToMph, psiToBar, cToF } from "@/lib/units";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface RaceEngineerChatProps {
  currentSetup?: SetupExportContext | null;
  telemetryResult?: TelemetryAnalysisResult | null;
  parsedTelemetry?: ParsedTelemetryFile | null;
  onApplyAdjustmentToSetup?: (note: string) => void;
  onSwitchToSetup?: () => void;
}

export const RaceEngineerChat: React.FC<RaceEngineerChatProps> = ({
  currentSetup,
  telemetryResult,
  parsedTelemetry,
  onApplyAdjustmentToSetup,
  onSwitchToSetup,
}) => {
  const { units } = useUnits();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome-1",
      role: "assistant",
      content: `Radio check driver, loud and clear on pit wall telemetry.

I have your active session telemetry and chassis telemetry synced. How does the car feel through the wheel? Let me know if you're fighting understeer on turn-in, snap oversteer on kerbs, or losing time to the delta benchmark, and I'll call out the exact click adjustments to make in the garage.`,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [radioAudioEnabled, setRadioAudioEnabled] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  // Multi-button PTT mapping: which wheel/gamepad button indices toggle the radio.
  // Persisted in localStorage so each wheel's redundant PTT buttons survive reloads.
  const [pttButtons, setPttButtons] = useState<number[]>([]);
  const [isMappingPtt, setIsMappingPtt] = useState(false);
  const [showPttMap, setShowPttMap] = useState(false);
  // Bridge PTT (in-game): buttons learned via the rig bridge sidecar ("joy:btn").
  // Works with the tab hidden behind the sim; audio is transcribed in the cloud.
  const [bridgePttButtons, setBridgePttButtons] = useState<string[]>([]);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [bridgeListening, setBridgeListening] = useState(false);
  const [isBridgeLearning, setIsBridgeLearning] = useState(false);
  const bridgeWsRef = useRef<WebSocket | null>(null);
  const bridgePttButtonsRef = useRef<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const gamepadPollingRef = useRef<number | null>(null);
  const lastGamepadBtnState = useRef<boolean>(false);
  const isListeningRef = useRef<boolean>(false);
  const pttButtonsRef = useRef<number[]>([]);
  const isMappingRef = useRef<boolean>(false);
  const showPttMapRef = useRef<HTMLDivElement | null>(null);

  // Load saved PTT mappings
  useEffect(() => {
    try {
      const saved = localStorage.getItem("apexwall-ptt-buttons");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const clean = parsed.filter((n) => Number.isInteger(n) && n >= 0);
          setPttButtons(clean);
          pttButtonsRef.current = clean;
        }
      }
      const savedBridge = localStorage.getItem("apexwall-ptt-bridge-buttons");
      if (savedBridge) {
        const parsed = JSON.parse(savedBridge);
        if (Array.isArray(parsed)) {
          const clean = parsed.filter((s) => typeof s === "string" && /^\d+:\d+$/.test(s));
          setBridgePttButtons(clean);
          bridgePttButtonsRef.current = clean;
        }
      }
    } catch (_e) {}
  }, []);

  const persistBridgePttButtons = (buttons: string[]) => {
    setBridgePttButtons(buttons);
    bridgePttButtonsRef.current = buttons;
    try {
      localStorage.setItem("apexwall-ptt-bridge-buttons", JSON.stringify(buttons));
    } catch (_e) {}
    // Push the map to the bridge sidecar
    try {
      bridgeWsRef.current?.send(JSON.stringify({ type: "ptt_map", payload: { buttons } }));
    } catch (_e) {}
  };

  // Bridge WebSocket: receive PTT transcripts + learn results, send button map.
  // WebSocket stays alive in background tabs, so in-game PTT works tab-hidden.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket("ws://localhost:9001");
      } catch (_e) {
        reconnectTimer = setTimeout(connect, 5000);
        return;
      }
      bridgeWsRef.current = ws;

      ws.onopen = () => {
        setBridgeConnected(true);
        // Send the current bridge button map to the sidecar
        try {
          ws!.send(JSON.stringify({ type: "ptt_map", payload: { buttons: bridgePttButtonsRef.current } }));
        } catch (_e) {}
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ptt_transcript" && data.payload?.text) {
            const transcript = String(data.payload.text);
            setInput(transcript);
            handleSendMessage(transcript);
          } else if (data.type === "ptt_learned" && data.payload?.button) {
            const btn = String(data.payload.button);
            setIsBridgeLearning(false);
            if (!bridgePttButtonsRef.current.includes(btn)) {
              persistBridgePttButtons([...bridgePttButtonsRef.current, btn].sort());
            }
          } else if (data.type === "ptt_listening") {
            setBridgeListening(!!data.payload?.active);
          } else if (data.type === "ptt_status" && data.payload?.learning === false) {
            setIsBridgeLearning(false);
          }
        } catch (_e) {}
      };

      ws.onclose = () => {
        setBridgeConnected(false);
        setBridgeListening(false);
        if (bridgeWsRef.current === ws) bridgeWsRef.current = null;
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        try { ws?.close(); } catch (_e) {}
      };
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      try { ws?.close(); } catch (_e) {}
      if (bridgeWsRef.current === ws) bridgeWsRef.current = null;
    };
  }, []);

  const persistPttButtons = (buttons: number[]) => {
    setPttButtons(buttons);
    pttButtonsRef.current = buttons;
    try {
      localStorage.setItem("apexwall-ptt-buttons", JSON.stringify(buttons));
    } catch (_e) {}
  };

  const capturePttButton = (btnIndex: number) => {
    if (!pttButtonsRef.current.includes(btnIndex)) {
      persistPttButtons([...pttButtonsRef.current, btnIndex].sort((a, b) => a - b));
    }
    setIsMappingPtt(false);
    isMappingRef.current = false;
    playRadioBeep(true);
  };

  const removePttButton = (btnIndex: number) => {
    persistPttButtons(pttButtonsRef.current.filter((b) => b !== btnIndex));
  };

  const startPttMapping = () => {
    setShowPttMap(false);
    setIsMappingPtt(true);
    isMappingRef.current = true;
  };

  const cancelPttMapping = () => {
    setIsMappingPtt(false);
    isMappingRef.current = false;
  };

  const startBridgeLearn = () => {
    if (!bridgeConnected) return;
    setIsBridgeLearning(true);
    setShowPttMap(false);
    try {
      bridgeWsRef.current?.send(JSON.stringify({ type: "ptt_learn_start" }));
    } catch (_e) {
      setIsBridgeLearning(false);
    }
    // Safety timeout in case the sidecar never answers
    setTimeout(() => setIsBridgeLearning(false), 20000);
  };

  const removeBridgePttButton = (btn: string) => {
    persistBridgePttButtons(bridgePttButtonsRef.current.filter((b) => b !== btn));
  };

  const activeSim = currentSetup?.game || "Assetto Corsa Competizione";
  const activeCar = currentSetup?.car || parsedTelemetry?.filename?.split(/[-_]/)[0]?.toUpperCase() || "GT3 Homologated";
  const activeTrack = currentSetup?.track || "Circuit de Spa-Francorchamps";
  const activeLapTime = telemetryResult?.lapComparison?.driverLapTime || parsedTelemetry?.lapTime || "2:18.420";
  const gripUtil = telemetryResult?.frictionCircle?.gripUtilizationPct || 89.4;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Close PTT mapping popover on outside click
  useEffect(() => {
    if (!showPttMap) return;
    const onDown = (e: MouseEvent) => {
      if (showPttMapRef.current && !showPttMapRef.current.contains(e.target as Node)) {
        setShowPttMap(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showPttMap]);

  // Authentic pit-radio beep sound via Web Audio API
  const playRadioBeep = (open: boolean) => {
    if (typeof window === "undefined") return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(open ? 920 : 620, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(open ? 1200 : 420, ctx.currentTime + 0.07);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
    } catch (_e) {}
  };

  // Initialize Speech Recognition & Wheel Button Listener
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRec) {
      setSpeechSupported(true);
      const rec = new SpeechRec();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = "en-US";

      rec.onstart = () => {
        isListeningRef.current = true;
        setIsListening(true);
        playRadioBeep(true);
      };

      rec.onresult = (e: any) => {
        const transcript = e.results[0]?.[0]?.transcript;
        if (transcript) {
          setInput(transcript);
          handleSendMessage(transcript);
        }
      };

      rec.onerror = () => {
        isListeningRef.current = false;
        setIsListening(false);
      };

      rec.onend = () => {
        isListeningRef.current = false;
        setIsListening(false);
        playRadioBeep(false);
      };

      recognitionRef.current = rec;
    }

    // Gamepad API Poller: capture mode maps a button, otherwise mapped buttons toggle PTT
    const pollGamepad = () => {
      const gamepads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];

      if (isMappingRef.current) {
        // Capture mode: first pressed button wins
        for (const gp of gamepads) {
          if (!gp) continue;
          for (let i = 0; i < gp.buttons.length; i++) {
            if (gp.buttons[i]?.pressed) {
              capturePttButton(i);
              break;
            }
          }
          if (!isMappingRef.current) break;
        }
      } else {
        const mapped = pttButtonsRef.current;
        let anyMappedPressed = false;
        if (mapped.length > 0) {
          for (const gp of gamepads) {
            if (!gp) continue;
            for (const idx of mapped) {
              if (gp.buttons[idx]?.pressed) {
                anyMappedPressed = true;
                break;
              }
            }
            if (anyMappedPressed) break;
          }
        }

        if (anyMappedPressed && !lastGamepadBtnState.current) {
          // Rising edge on any mapped PTT button toggles the radio
          toggleVoiceInput();
        }
        lastGamepadBtnState.current = anyMappedPressed;
      }
    };

    // setInterval (not rAF) so the poller keeps running when the tab is
    // backgrounded behind the sim — Chrome throttles it to ~1Hz back there,
    // but a held PTT press still registers. rAF would stop entirely.
    gamepadPollingRef.current = window.setInterval(pollGamepad, 100);

    return () => {
      if (gamepadPollingRef.current) clearInterval(gamepadPollingRef.current);
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch (_e) {}
      }
    };
  }, []);

  const toggleVoiceInput = () => {
    if (!recognitionRef.current) return;
    if (isListeningRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_e) {}
      isListeningRef.current = false;
      setIsListening(false);
    } else {
      try {
        recognitionRef.current.start();
        isListeningRef.current = true;
        setIsListening(true);
      } catch (_e) {
        isListeningRef.current = false;
        setIsListening(false);
      }
    }
  };

  // Voice synthesis for authentic pit radio comms
  const speakRadioMessage = (text: string) => {
    if (!radioAudioEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      // Take first 2 sentences for radio brevity
      const shortText = text.split(/(?<=[.?!])\s+/).slice(0, 2).join(" ");
      const utterance = new SpeechSynthesisUtterance(shortText);
      utterance.rate = 1.05;
      utterance.pitch = 0.95;

      const voices = window.speechSynthesis.getVoices();
      const britishOrDeepVoice = voices.find(
        (v) => v.lang.includes("en-GB") || v.name.includes("Male") || v.name.includes("David")
      );
      if (britishOrDeepVoice) utterance.voice = britishOrDeepVoice;

      window.speechSynthesis.speak(utterance);
    } catch (_e) {
      // Audio synthesis fallback
    }
  };

  const handleSendMessage = async (userText: string) => {
    const query = userText.trim();
    if (!query || isLoading) return;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: query,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    // Build context payload (speeds/tyres converted to the active unit system for the AI)
    const aiSpd = (kmh: number) => Math.round(units === "imperial" ? kmhToMph(kmh) : kmh);
    const aiTyreStats = parsedTelemetry?.tyreStats
      ? Object.fromEntries(
          Object.entries(parsedTelemetry.tyreStats).map(([k, v]: [string, any]) => [
            k,
            {
              temp: units === "imperial" ? `${Math.round(cToF(parseFloat(v.temp)))}°F` : v.temp,
              pressure: units === "metric" ? `${psiToBar(parseFloat(v.pressure)).toFixed(2)} bar` : v.pressure,
            },
          ])
        )
      : undefined;
    const telemetryContext = {
      car: activeCar,
      track: activeTrack,
      lapTime: activeLapTime,
      topSpeed: aiSpd(parsedTelemetry?.topSpeed || 285),
      minSpeed: aiSpd(parsedTelemetry?.minSpeed || 65),
      trailBrakingScore: parsedTelemetry?.trailBrakingScore || 78,
      gripUtilization: gripUtil,
      tyres: aiTyreStats,
      keyCorners: telemetryResult?.lapComparison?.cornerComparisons?.map((c) => ({
        corner: c.corner,
        driverSpeed: aiSpd(c.driverMinSpeed),
        refSpeed: aiSpd(c.refMinSpeed),
        speedDelta: units === "imperial" ? +kmhToMph(c.speedDelta).toFixed(1) : c.speedDelta,
        timeDelta: c.timeDelta,
        verdict: c.verdict,
      })),
    };

    const setupContext = currentSetup
      ? {
          game: currentSetup.game,
          car: currentSetup.car,
          track: currentSetup.track,
          summary: currentSetup.summary,
          sections: currentSetup.sections,
          engineerNotes: currentSetup.engineerNotes,
        }
      : undefined;

    try {
      const res = await fetch("/api/race-engineer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          units,
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          telemetryContext,
          setupContext,
          activeSim,
        }),
      });

      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("json") ? await res.json() : { reply: await res.text() };
      const replyContent = data.reply || "Copy driver, telemetry signal interrupted. State your issue again.";

      const assistantMsg: Message = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: replyContent,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setMessages((prev) => [...prev, assistantMsg]);
      speakRadioMessage(replyContent);
    } catch (_err) {
      const errorMsg: Message = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: `Copy driver, telemetry packet lost. Based on your ${activeSim} baseline for ${activeCar}, focus on progressive trail-braking release into turn-in and monitor tyre pressure buildup on your left-hand tyres.`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(input);
    }
  };

  const quickDebriefPrompts = [
    { label: "⚡ Turn 1 Pace Deficit", prompt: "Why am I losing time in Turn 1 compared to the delta benchmark?" },
    { label: "🛞 Tyre Temp & Pressure Check", prompt: "Check my tyre pressures and operating temperature window across the stint." },
    { label: "🔧 Cure Mid-Corner Understeer", prompt: "I have mid-corner push and understeer. What suspension and toe clicks should I adjust?" },
    { label: "🏎️ High-Speed Snap Oversteer", prompt: "The car snaps into oversteer under high-speed trail-braking. How do I stabilize the rear axle?" },
    { label: "🏁 Kerb Compliance in Chicanes", prompt: "The car bounces violently over chicane kerbs. How should I tune my fast dampers and bump stops?" },
  ];

  return (
    <div className="race-engineer-workspace max-w-[1440px] mx-auto px-6 py-4 flex flex-col gap-4">
      {/* Session Context Bar */}
      <div className="bg-[#0f1420] border border-cyan-500/20 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 font-bold text-lg shadow-inner">
            🎙️
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold font-mono tracking-wider text-white uppercase">
                CHIEF RACE ENGINEER // PIT WALL TELEMETRY DEBRIEF
              </span>
              <span className="text-[10px] font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                RADIO COMMS ACTIVE
              </span>
            </div>
            <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2 font-mono">
              <span className="text-cyan-300 font-semibold">{activeCar}</span>
              <span>•</span>
              <span className="text-slate-300">{activeTrack}</span>
              <span>•</span>
              <span className="text-slate-400">Sim: {activeSim}</span>
            </div>
          </div>
        </div>

        {/* Live Telemetry Mini-Pills & Radio Sound Toggle */}
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2 text-xs font-mono bg-black/40 border border-white/5 rounded-lg px-3 py-1.5">
            <span className="text-slate-400">Lap Time:</span>
            <span className="text-white font-bold">{activeLapTime}</span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400">Grip Util:</span>
            <span className="text-emerald-400 font-bold">{gripUtil}%</span>
          </div>

          <button
            type="button"
            onClick={() => setRadioAudioEnabled(!radioAudioEnabled)}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono border transition-all flex items-center gap-2 ${
              radioAudioEnabled
                ? "bg-cyan-500/20 border-cyan-500 text-cyan-300 shadow-md shadow-cyan-500/10"
                : "bg-white/5 border-white/10 text-slate-400 hover:text-white"
            }`}
            title="Toggle authentic team radio voice synthesis"
          >
            <span>{radioAudioEnabled ? "🔊" : "🔇"}</span>
            <span>{radioAudioEnabled ? "Radio Audio: ON" : "Radio Audio: OFF"}</span>
          </button>
        </div>
      </div>

      {/* Main Chat Interface */}
      <div className="bg-[#0b0e14] border border-white/10 rounded-2xl flex flex-col h-[650px] shadow-2xl overflow-hidden">
        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          {messages.map((msg) => {
            const isEngineer = msg.role === "assistant";
            return (
              <div
                key={msg.id}
                className={`flex gap-3 max-w-[85%] ${
                  isEngineer ? "self-start" : "self-end flex-row-reverse"
                }`}
              >
                {/* Avatar Icon */}
                <div
                  className={`w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold ${
                    isEngineer
                      ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                      : "bg-blue-600 text-white"
                  }`}
                >
                  {isEngineer ? "⚡" : "🏎️"}
                </div>

                {/* Message Bubble */}
                <div
                  className={`rounded-2xl p-4 text-xs md:text-sm leading-relaxed ${
                    isEngineer
                      ? "bg-[#121824] border border-cyan-500/25 text-slate-200 shadow-lg"
                      : "bg-blue-600/90 text-white shadow-lg"
                  }`}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between gap-4 mb-2 pb-1.5 border-b border-white/10">
                    <span
                      className={`text-[10px] font-mono font-bold uppercase tracking-wider ${
                        isEngineer ? "text-cyan-400" : "text-blue-200"
                      }`}
                    >
                      {isEngineer ? "CHIEF RACE ENGINEER // PIT WALL CH 1" : "DRIVER // COCKPIT"}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 opacity-70">
                      {msg.timestamp}
                    </span>
                  </div>

                  {/* Body Content */}
                  <div className="whitespace-pre-wrap space-y-2">
                    {msg.content}
                  </div>

                  {/* If engineer suggests setup modifications, show quick-apply button */}
                  {isEngineer && (msg.content.includes("Anti-Roll") || msg.content.includes("Dampers") || msg.content.includes("Toe") || msg.content.includes("click")) && (
                    <div className="mt-3 pt-2.5 border-t border-cyan-500/20 flex items-center justify-between">
                      <span className="text-[10.5px] font-mono text-cyan-300">
                        ⚡ Actionable garage adjustments detected
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          onApplyAdjustmentToSetup?.(msg.content);
                          onSwitchToSetup?.();
                        }}
                        className="px-2.5 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 rounded text-[11px] font-mono text-cyan-300 font-semibold transition-colors"
                      >
                        Push to Setup Generator →
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Loading Indicator */}
          {isLoading && (
            <div className="self-start flex gap-3 max-w-[85%]">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 flex items-center justify-center text-xs font-bold animate-pulse">
                ⚡
              </div>
              <div className="bg-[#121824] border border-cyan-500/25 rounded-2xl p-4 text-xs font-mono text-cyan-300 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
                <span>Race Engineer analyzing telemetry channels & calculating setup changes...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Debrief Suggestions Bar */}
        <div className="px-5 py-2.5 bg-black/40 border-t border-white/5 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="text-[10.5px] font-mono uppercase tracking-wider text-slate-500 flex-shrink-0">
            Debrief Focus:
          </span>
          {quickDebriefPrompts.map((q, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSendMessage(q.prompt)}
              className="flex-shrink-0 px-2.5 py-1 rounded-full bg-white/[0.04] hover:bg-cyan-500/15 border border-white/10 hover:border-cyan-500/30 text-[11px] font-mono text-slate-300 hover:text-cyan-300 transition-colors"
            >
              {q.label}
            </button>
          ))}
        </div>

        {/* Input Bar */}
        <div className="p-4 bg-[#0d121c] border-t border-white/10 flex items-center gap-3">
          {/* Wheel/Voice PTT Button + mapping */}
          {speechSupported && (
            <div className="relative flex items-center gap-1">
              <button
                type="button"
                onClick={isMappingPtt ? cancelPttMapping : toggleVoiceInput}
                className={`px-3 py-2 rounded-md font-mono text-xs flex items-center gap-1.5 transition-all border ${
                  isMappingPtt || isBridgeLearning
                    ? "bg-amber-500/20 border-amber-500 text-amber-300 animate-pulse"
                    : bridgeListening
                      ? "bg-emerald-500/20 border-emerald-500 text-emerald-300 animate-pulse"
                      : isListening
                        ? "bg-red-500/20 border-red-500 text-red-300 animate-pulse"
                        : "bg-white/[0.04] border-white/10 hover:border-blue-500/50 text-slate-300 hover:text-white"
                }`}
                title={
                  isMappingPtt
                    ? "Press a wheel button to map it (click again to cancel)"
                    : isBridgeLearning
                      ? "Press a wheel button — the bridge is learning… (click to cancel)"
                      : bridgeListening
                        ? "Bridge is recording your radio message…"
                        : "Push-To-Talk Radio (Click, wheel button, or bridge PTT in-game)"
                }
              >
                <span className={`w-2 h-2 rounded-full ${isMappingPtt || isBridgeLearning ? "bg-amber-400" : bridgeListening ? "bg-emerald-400" : isListening ? "bg-red-500" : bridgeConnected ? "bg-emerald-500" : "bg-slate-400"}`} />
                <span className="hidden sm:inline">
                  {isMappingPtt || isBridgeLearning
                    ? "Press wheel btn…"
                    : bridgeListening
                      ? "Recording…"
                      : isListening
                        ? "Listening..."
                        : `Radio PTT${pttButtons.length + bridgePttButtons.length > 0 ? ` (${pttButtons.length + bridgePttButtons.length})` : ""}`}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setShowPttMap((v) => !v)}
                className="p-2 rounded-md border border-white/10 bg-white/[0.04] text-slate-400 hover:text-white hover:border-blue-500/50 transition-all"
                title="Map wheel buttons to Radio PTT"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              {showPttMap && (
                <div
                  ref={showPttMapRef}
                  className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-white/10 bg-[#0d121c] shadow-xl shadow-black/50 p-3 z-50"
                >
                  <div className="text-[11px] font-mono font-bold text-slate-300 mb-2">PTT WHEEL BUTTONS</div>
                  <div className="text-[10px] text-slate-600 mb-1.5 leading-snug">
                    Browser PTT — works when this tab is visible.
                  </div>
                  {pttButtons.length === 0 ? (
                    <div className="text-xs text-slate-500 mb-2">No buttons mapped yet.</div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {pttButtons.map((b) => (
                        <span
                          key={b}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-500/15 border border-blue-500/30 text-[11px] font-mono text-blue-300"
                        >
                          Btn {b}
                          <button
                            type="button"
                            onClick={() => removePttButton(b)}
                            className="text-blue-400 hover:text-red-400 ml-0.5"
                            title={`Unmap button ${b}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={startPttMapping}
                    className="w-full px-2 py-1.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-xs font-mono transition-colors"
                  >
                    + Map a wheel button
                  </button>
                  {pttButtons.length > 0 && (
                    <button
                      type="button"
                      onClick={() => persistPttButtons([])}
                      className="w-full mt-1.5 text-[11px] font-mono text-slate-500 hover:text-red-400 transition-colors"
                    >
                      Clear all
                    </button>
                  )}
                  <div className="text-[10px] text-slate-600 mt-2 leading-snug">
                    Click "+ Map", then press the wheel button. Repeat for each redundant PTT button.
                  </div>

                  <div className="border-t border-white/10 mt-3 pt-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[11px] font-mono font-bold text-slate-300">BRIDGE PTT (IN-GAME)</div>
                      <span className={`w-2 h-2 rounded-full ${bridgeConnected ? "bg-emerald-400" : "bg-slate-600"}`} title={bridgeConnected ? "Bridge connected" : "Bridge not reachable (is it running on this PC?)"} />
                    </div>
                    <div className="text-[10px] text-slate-600 mb-1.5 leading-snug">
                      Via the rig bridge — works with the tab hidden behind the sim. Audio is transcribed in the cloud.
                    </div>
                    {bridgePttButtons.length === 0 ? (
                      <div className="text-xs text-slate-500 mb-2">No bridge buttons mapped yet.</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {bridgePttButtons.map((b) => (
                          <span
                            key={b}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-mono text-emerald-300"
                          >
                            {b}
                            <button
                              type="button"
                              onClick={() => removeBridgePttButton(b)}
                              className="text-emerald-400 hover:text-red-400 ml-0.5"
                              title={`Unmap ${b}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={startBridgeLearn}
                      disabled={!bridgeConnected || isBridgeLearning}
                      className="w-full px-2 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 text-xs font-mono transition-colors"
                    >
                      {isBridgeLearning ? "Press a wheel button…" : "+ Learn via bridge"}
                    </button>
                    {bridgePttButtons.length > 0 && (
                      <button
                        type="button"
                        onClick={() => persistBridgePttButtons([])}
                        className="w-full mt-1.5 text-[11px] font-mono text-slate-500 hover:text-red-400 transition-colors"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex-1 flex items-center bg-[#151c2a] border border-white/15 focus-within:border-cyan-500 rounded-xl px-4 py-2.5 transition-colors">
            <span className="text-slate-500 mr-2 font-mono text-xs">🎙️ DRIVER:</span>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isListening ? "Listening to driver comms..." : bridgeListening ? "Bridge recording radio message…" : "Tell your race engineer how the car feels or ask about telemetry..."}
              className="w-full bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none font-sans"
            />
          </div>

          <button
            type="button"
            disabled={!input.trim() || isLoading}
            onClick={() => handleSendMessage(input)}
            className="px-5 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40 text-black font-bold text-xs font-mono rounded-xl shadow-lg shadow-cyan-500/20 transition-all flex items-center gap-2"
          >
            <span>RADIO PIT WALL</span>
            <span>→</span>
          </button>
        </div>
      </div>
    </div>
  );
};
