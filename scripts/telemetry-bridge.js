/**
 * =========================================================================
 * APEXWALL AI // SIM RIG TELEMETRY BRIDGE
 * =========================================================================
 * Listens for live telemetry from your sims and serves the latest completed
 * lap to the ApexWall web app for 1-click ingestion.
 *
 * Supported Sims (auto-detect):
 *   - iRacing                  : Shared Memory (via @emiliosp/node-iracing-sdk)
 *   - Assetto Corsa Competizione: Shared Memory (Python bridge)
 *   - Automobilista 2 / pCARS2 : UDP Port 5606
 *   - Forza Motorsport/Horizon : UDP Port 5300 ("Data Out")
 *   - F1 22 / 23 / 24 / 25     : UDP Port 20777
 *
 * The ApexWall Telemetry tab polls http://localhost:9001/api/status and shows
 * a "Live Rig" banner when this bridge is running. Click "Import Live Lap"
 * to pull the latest completed lap straight into the analyzer.
 *
 * Usage:
 *   node scripts/telemetry-bridge.js              # Auto-detect all sims
 *   node scripts/telemetry-bridge.js --game iracing
 *   node scripts/telemetry-bridge.js --game ams2
 *   node scripts/telemetry-bridge.js --game forza
 *   node scripts/telemetry-bridge.js --game f1
 *   node scripts/telemetry-bridge.js --test       # Synthetic 60Hz test feed
 *
 * Requires: npm install ws @emiliosp/node-iracing-sdk
 * (iRacing reader only; UDP sims need just `ws`)
 * =========================================================================
 */

const dgram = require("dgram");
const http = require("http");
const { WebSocketServer } = require("ws");

const args = process.argv.slice(2);
const isTestMode = args.includes("--test");
const gameArgIndex = args.indexOf("--game");
const gameFilter = gameArgIndex !== -1 && args[gameArgIndex + 1]
  ? args[gameArgIndex + 1].toLowerCase()
  : null;

const WS_PORT = 9001;
const BRIDGE_VERSION = "1.1.0";
const bootTime = Date.now();

const PORTS = {
  AMS2: 5606,
  FORZA: 5300,
  F1: 20777,
};

let activeGame = "Awaiting Sim Connection";
let totalPacketsReceived = 0;
let lastPacketTime = 0;

// ---------------------------------------------------------------------------
// Persistent config (%APPDATA%/ApexWall/bridge-config.json on Windows).
// Env vars still override the file, so existing setups keep working.
// ---------------------------------------------------------------------------
const path = require("path");
const fs = require("fs");
const CONFIG_PATH = (() => {
  const base = process.env.APPDATA || path.join(require("os").homedir(), ".config");
  return path.join(base, "ApexWall", "bridge-config.json");
})();

const DEFAULT_CONFIG = {
  apiUrl: "",
  bridgeKey: "",
  bridgeUserId: "",
  pttMic: "",
  pttSpeaker: "",
  pttButtons: [],
  bridgeVoice: true,
  sims: { iracing: true, acc: true, ams2: true, forza: true, f1: true },
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return { ...DEFAULT_CONFIG, ...raw, sims: { ...DEFAULT_CONFIG.sims, ...(raw.sims || {}) } };
    }
  } catch (e) {
    console.warn(`[CONFIG] Could not read ${CONFIG_PATH}: ${e.message}`);
  }
  return { ...DEFAULT_CONFIG, sims: { ...DEFAULT_CONFIG.sims } };
}

function saveConfigFile(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const { _path, ...persist } = cfg;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(persist, null, 2));
    return true;
  } catch (e) {
    console.warn(`[CONFIG] Could not write ${CONFIG_PATH}: ${e.message}`);
    return false;
  }
}

const fileConfig = loadConfig();
console.log(`[CONFIG] Loaded from ${CONFIG_PATH}`);

// Effective config: env vars win over the file.
function eff(key, envName) {
  const envVal = process.env[envName];
  if (envVal != null && envVal !== "") return envVal;
  return fileConfig[key];
}

// Device cache from the PTT sidecar (populated via ptt_status messages)
const deviceCache = { inputs: [], outputs: [], joysticks: [], mic: "", speaker: "", sidecar: false };

// Lap recorder state
let activeLapBuffer = [];
let lastCompletedLap = null;
let lapCounter = 0;
let lapStartTime = Date.now();
let lastLapDistance = 0;
let lastLapNumber = -1;

// F-006: Cloud auto-upload config (config file, env vars override)
const CLOUD_API_URL = (eff("apiUrl", "APEXWALL_API_URL") || "").replace(/\/$/, "");
const CLOUD_BRIDGE_KEY = eff("bridgeKey", "APEXWALL_BRIDGE_KEY") || eff("bridgeKey", "BRIDGE_API_KEY") || "";
const CLOUD_USER_ID = eff("bridgeUserId", "BRIDGE_USER_ID") || "";
let cloudSessionId = null;
let cloudSessionKey = ""; // game|car|track — new session when this changes
let cloudCarName = "";
let cloudTrackName = "";

/**
 * Upload a completed lap to the cloud ingest API.
 * Downsamples to 30Hz to stay under the function payload limit.
 */
async function uploadLapToCloud(lap) {
  if (!CLOUD_API_URL || !CLOUD_BRIDGE_KEY) return;
  try {
    const sessionKey = `${lap.game}|${cloudCarName}|${cloudTrackName}`;
    if (cloudSessionId == null || cloudSessionKey !== sessionKey) {
      const r = await fetch(`${CLOUD_API_URL}/api/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Key": CLOUD_BRIDGE_KEY,
        },
        body: JSON.stringify({
          game: lap.game,
          car: cloudCarName || undefined,
          track: cloudTrackName || undefined,
          source: "bridge",
        }),
      });
      if (!r.ok) throw new Error(`session create: ${r.status}`);
      const data = await r.json();
      cloudSessionId = data.session_id;
      cloudSessionKey = sessionKey;
      console.log(`[CLOUD] New session ${cloudSessionId} for ${lap.game}`);
    }

    // Downsample to 30Hz: keep every 2nd point (bridge runs at ~60Hz)
    const pts = lap.points.filter((_, i) => i % 2 === 0);
    const channels = {
      speed: pts.map((p) => p.speed ?? 0),
      throttle: pts.map((p) => p.throttle ?? 0),
      brake: pts.map((p) => p.brake ?? 0),
      steer: pts.map((p) => p.steer ?? 0),
      gear: pts.map((p) => p.gear ?? 0),
      rpm: pts.map((p) => p.rpm ?? 0),
      lat_g: pts.map((p) => p.latG ?? 0),
      long_g: pts.map((p) => p.longG ?? 0),
      dist: pts.map((p) => p.dist ?? 0),
    };
    const r = await fetch(`${CLOUD_API_URL}/api/sessions/${cloudSessionId}/laps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Key": CLOUD_BRIDGE_KEY,
      },
      body: JSON.stringify({
        lap_number: lapCounter,
        lap_time: parseFloat(lap.lapTime),
        is_valid: true,
        channels,
        sample_rate: 30,
        sample_count: pts.length,
      }),
    });
    if (!r.ok) throw new Error(`lap upload: ${r.status}`);
    console.log(`[CLOUD] Uploaded lap ${lapCounter} (${pts.length} pts @30Hz)`);
  } catch (e) {
    console.warn(`[CLOUD] Upload failed: ${e.message}`);
  }
}

console.log("=================================================================");
console.log("  APEXWALL AI // SIM RIG TELEMETRY BRIDGE");
console.log("=================================================================");
if (isTestMode) {
  console.log("  Mode: Synthetic 60Hz test feed");
} else {
  console.log(`  Mode: ${gameFilter ? `Dedicated [${gameFilter.toUpperCase()}]` : "Auto-Detect (all sims)"}`);
  console.log("  Listening:");
  const simOn = (k) => gameFilter ? true : fileConfig.sims[k] !== false;
  if (!gameFilter || gameFilter === "iracing") { if (simOn("iracing")) console.log("    - iRacing                  : Shared Memory"); }
  if (!gameFilter || gameFilter === "acc") { if (simOn("acc")) console.log("    - Assetto Corsa Competizione: Shared Memory (Python bridge)"); }
  if (!gameFilter || ["ams2", "automobilista", "pcars2"].includes(gameFilter)) { if (simOn("ams2")) console.log(`    - Automobilista 2 / pCARS2 : UDP ${PORTS.AMS2}`); }
  if (!gameFilter || gameFilter === "forza") { if (simOn("forza")) console.log(`    - Forza Motorsport/Horizon : UDP ${PORTS.FORZA}`); }
  if (!gameFilter || gameFilter === "f1") { if (simOn("f1")) console.log(`    - F1 22 / 23 / 24 / 25     : UDP ${PORTS.F1}`); }
}
console.log(`  HTTP API  : http://localhost:${WS_PORT}/api/status`);
console.log(`  Config UI : http://localhost:${WS_PORT}/config`);
console.log(`  Lap ingest: http://localhost:${WS_PORT}/api/latest-lap.csv`);
console.log("=================================================================\n");

// --- CSV export (matches ApexWall telemetry-parser header) ---

function pointsToCSV(points) {
  if (!points || points.length === 0) return "";
  const headers = [
    "Time", "Distance", "Speed", "Throttle", "Brake", "Steer", "Gear", "RPM",
    "LatG", "LongG", "TempFL", "TempFR", "TempRL", "TempRR",
    "PressFL", "PressFR", "PressRL", "PressRR",
  ];
  const rows = [headers.join(",")];
  for (const p of points) {
    rows.push([
      (p.time || 0).toFixed(3),
      Math.round(p.dist || 0),
      Math.round(p.speed || 0),
      Math.round(p.throttle || 0),
      Math.round(p.brake || 0),
      (p.steer || 0).toFixed(1),
      p.gear || 0,
      Math.round(p.rpm || 0),
      (p.latG || 0).toFixed(2),
      (p.longG || 0).toFixed(2),
      (p.tempFL || 85).toFixed(1),
      (p.tempFR || 85).toFixed(1),
      (p.tempRL || 85).toFixed(1),
      (p.tempRR || 85).toFixed(1),
      (p.pressFL || 27.0).toFixed(2),
      (p.pressFR || 27.0).toFixed(2),
      (p.pressRL || 27.0).toFixed(2),
      (p.pressRR || 27.0).toFixed(2),
    ].join(","));
  }
  return rows.join("\n");
}

// --- HTTP + WebSocket server ---

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/api/health" || req.url === "/api/status")) {
    const isReceiving = Date.now() - lastPacketTime < 3000;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: BRIDGE_VERSION,
      activeGame,
      isReceiving,
      uptimeSec: Math.floor((Date.now() - bootTime) / 1000),
      totalPackets: totalPacketsReceived,
      lapCounter,
      currentLapPointsCount: activeLapBuffer.length,
      hasCompletedLap: !!lastCompletedLap,
      lastLapTime: lastCompletedLap ? lastCompletedLap.lapTime : null,
      lastLapPointCount: lastCompletedLap ? lastCompletedLap.points.length : 0,
      pttSidecar: !!pttSidecar,
      pttMic: deviceCache.mic || null,
    }));
    return;
  }

  // ---- Bridge config dashboard ----
  if (req.method === "GET" && req.url === "/config") {
    try {
      const { CONFIG_PAGE } = require("./bridge-config-page.js");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CONFIG_PAGE);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Config page unavailable: " + e.message);
    }
    return;
  }

  const publicConfig = () => ({
    apiUrl: CLOUD_API_URL,
    bridgeKey: CLOUD_BRIDGE_KEY ? "••••••••" : "",
    bridgeUserId: CLOUD_USER_ID,
    pttMic: eff("pttMic", "PTT_MIC"),
    pttSpeaker: eff("pttSpeaker", "PTT_SPEAKER"),
    pttTtsEngine: eff("pttTtsEngine", "PTT_TTS_ENGINE") || "sapi",
    pttTtsFull: eff("pttTtsFull", "PTT_TTS_FULL") || "",
    pttButtons: fileConfig.pttButtons || [],
    bridgeVoice: fileConfig.bridgeVoice !== false,
    sims: fileConfig.sims,
    _path: CONFIG_PATH,
    _envOverride: {
      apiUrl: !!process.env.APEXWALL_API_URL,
      bridgeKey: !!(process.env.APEXWALL_BRIDGE_KEY || process.env.BRIDGE_API_KEY),
    },
  });

  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(publicConfig()));
    return;
  }

  if (req.method === "POST" && req.url === "/api/config") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 16384) req.destroy(); });
    req.on("end", () => {
      try {
        const patch = JSON.parse(body || "{}");
        const allowed = ["apiUrl", "bridgeKey", "bridgeUserId", "pttMic", "pttSpeaker", "pttTtsEngine", "pttTtsFull", "pttButtons", "bridgeVoice", "sims"];
        for (const k of allowed) {
          if (patch[k] !== undefined) {
            // Don't overwrite a real key with the masked placeholder
            if (k === "bridgeKey" && patch[k] === "••••••••") continue;
            fileConfig[k] = patch[k];
          }
        }
        if (patch.sims && typeof patch.sims === "object") {
          fileConfig.sims = { ...fileConfig.sims, ...patch.sims };
        }
        if (Array.isArray(patch.pttButtons)) {
          fileConfig.pttButtons = patch.pttButtons.filter((s) => typeof s === "string");
          // Push the map to the sidecar immediately
          if (pttSidecar && pttSidecar.stdin) {
            try { pttSidecar.stdin.write(JSON.stringify({ cmd: "map", buttons: fileConfig.pttButtons }) + "\n"); } catch (_e) {}
          }
        }
        const ok = saveConfigFile(fileConfig);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok, config: publicConfig() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/config/test") {
    (async () => {
      if (!CLOUD_API_URL) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "API URL not set" }));
        return;
      }
      try {
        const r = await fetch(`${CLOUD_API_URL}/api/health`);
        const detail = r.ok ? `cloud reachable (HTTP ${r.status})` : `cloud returned HTTP ${r.status}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: r.ok, detail }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  if (req.method === "GET" && req.url === "/api/devices") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      sidecar: deviceCache.sidecar,
      inputs: deviceCache.inputs,
      outputs: deviceCache.outputs,
      joysticks: deviceCache.joysticks,
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/ptt/learn") {
    if (pttSidecar && pttSidecar.stdin) {
      try { pttSidecar.stdin.write(JSON.stringify({ cmd: "learn_start" }) + "\n"); } catch (_e) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "PTT sidecar not running" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/ptt/monitor") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const { active } = JSON.parse(body || "{}");
        if (pttSidecar && pttSidecar.stdin) {
          pttSidecar.stdin.write(JSON.stringify({ cmd: active ? "monitor_start" : "monitor_stop" }) + "\n");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, monitoring: !!active }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/latest-lap.csv") {
    const points = lastCompletedLap ? lastCompletedLap.points : activeLapBuffer;
    if (!points || points.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("No telemetry points available yet. Drive on track to buffer telemetry.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="apexwall_${activeGame.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_lap.csv"`,
    });
    res.end(pointsToCSV(points));
    return;
  }

  if (req.method === "POST" && req.url === "/api/save-lap") {
    if (activeLapBuffer.length < 20) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Lap buffer too short to save." }));
      return;
    }
    const lapTime = ((Date.now() - lapStartTime) / 1000).toFixed(2);
    lastCompletedLap = { game: activeGame, lapTime, points: [...activeLapBuffer] };
    lapCounter++;
    activeLapBuffer = [];
    lapStartTime = Date.now();
    console.log(`[LAP] Manually saved lap ${lapCounter} (${lapTime}s, ${lastCompletedLap.points.length} pts)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, lapCounter, lapTime, pointCount: lastCompletedLap.points.length }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({ server });
let activeClients = [];
let pttSidecar = null; // PTT voice sidecar process (spawned at startup)
wss.on("connection", (ws) => {
  activeClients.push(ws);
  ws.on("close", () => { activeClients = activeClients.filter((c) => c !== ws); });
  ws.on("message", (data) => {
    // Web app -> bridge commands (currently: PTT button mapping + TTS replies)
    try {
      const msg = JSON.parse(data.toString());
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "ptt_speak") {
        // Engineer reply -> Windows TTS on the rig (in-game voice loop)
        speakViaBridge(msg.payload && msg.payload.text);
        return;
      }
      if (msg.type.startsWith("ptt_") && pttSidecar) {
        // Forward to the PTT sidecar as a command: {cmd, ...}
        const cmd = { cmd: msg.type.replace(/^ptt_/, ""), ...(msg.payload || {}) };
        try { pttSidecar.stdin.write(JSON.stringify(cmd) + "\n"); } catch (_e) {}
      }
    } catch (_e) {}
  });
});

/** Send a typed message to all connected web clients. */
function broadcastMessage(type, payload) {
  const msg = JSON.stringify({ type, payload: payload || {} });
  for (const c of activeClients) {
    try { if (c.readyState === 1) c.send(msg); } catch (_e) {}
  }
}

server.listen(WS_PORT, () => {
  console.log(`[BRIDGE] Listening on http://localhost:${WS_PORT}\n`);
});

// --- Frame pipeline: buffer into lap, detect lap completion ---

function broadcastFrame(frame) {
  totalPacketsReceived++;
  lastPacketTime = Date.now();

  if (frame.game && activeGame !== frame.game) {
    activeGame = frame.game;
    console.log(`[DETECT] Active sim: ${activeGame}`);
  }

  // Generic car/track change detection (ACC frames carry car/track; iRacing handled separately)
  if (frame.car || frame.track) {
    const fc = frame.car || "", ft = frame.track || "";
    if ((fc && fc !== cloudCarName) || (ft && ft !== cloudTrackName)) {
      if (cloudCarName || cloudTrackName) {
        console.log(`[DETECT] Car/track changed: ${fc || "?"} @ ${ft || "?"}`);
      }
      cloudCarName = fc;
      cloudTrackName = ft;
      cloudSessionId = null; // new cloud session on change
    }
  }

  const payload = JSON.stringify({ type: "telemetry_frame", payload: frame });
  for (const c of activeClients) {
    if (c.readyState === 1) c.send(payload);
  }

  if (frame.speed > 3) {
    const elapsedSec = (Date.now() - lapStartTime) / 1000;
    const dist = frame.lapDistance || activeLapBuffer.length * 6;

    // Lap completion: lap counter incremented (iRacing) or distance wrap (UDP sims)
    const lapWrapped = frame.lapDistance != null && frame.lapDistance < 100 &&
      lastLapDistance > 1000 && activeLapBuffer.length > 200;
    const lapIncremented = frame.lapNumber != null && lastLapNumber !== -1 &&
      frame.lapNumber > lastLapNumber && activeLapBuffer.length > 200;

    if (lapWrapped || lapIncremented) {
      lapCounter++;
      lastCompletedLap = { game: activeGame, lapTime: elapsedSec.toFixed(2), points: [...activeLapBuffer] };
      console.log(`[LAP] Lap ${lapCounter} complete (${elapsedSec.toFixed(2)}s, ${lastCompletedLap.points.length} pts)`);
      // F-006: auto-upload to cloud (fire and forget)
      uploadLapToCloud(lastCompletedLap).catch(() => {});
      activeLapBuffer = [];
      lapStartTime = Date.now();
      const msg = JSON.stringify({
        type: "lap_completed",
        payload: { lapNumber: lapCounter, lapTime: lastCompletedLap.lapTime, pointCount: lastCompletedLap.points.length },
      });
      for (const c of activeClients) {
        if (c.readyState === 1) c.send(msg);
      }
    }

    lastLapDistance = frame.lapDistance || 0;
    if (frame.lapNumber != null) lastLapNumber = frame.lapNumber;

    activeLapBuffer.push({
      time: Number(elapsedSec.toFixed(3)),
      dist: Math.round(dist),
      speed: Math.round(frame.speed || 0),
      throttle: Math.round(frame.throttle || 0),
      brake: Math.round(frame.brake || 0),
      steer: Number((frame.steer || 0).toFixed(1)),
      gear: frame.gear || 0,
      rpm: Math.round(frame.rpm || 0),
      latG: Number((frame.latG || 0).toFixed(2)),
      longG: Number((frame.longG || 0).toFixed(2)),
      tempFL: frame.tyreTemps?.FL ?? 85,
      tempFR: frame.tyreTemps?.FR ?? 85,
      tempRL: frame.tyreTemps?.RL ?? 85,
      tempRR: frame.tyreTemps?.RR ?? 85,
      pressFL: frame.tyrePressures?.FL ?? 27.0,
      pressFR: frame.tyrePressures?.FR ?? 27.0,
      pressRL: frame.tyrePressures?.RL ?? 27.0,
      pressRR: frame.tyrePressures?.RR ?? 27.0,
    });

    if (activeLapBuffer.length > 20000) activeLapBuffer.shift();
  }
}

// =========================================================================
// UDP DECODERS
// =========================================================================

// State caches for multi-packet UDP protocols
const f1LapData = {
  lapDistance: 0,
  totalDistance: 5891,
  lapTime: 0,
  latG: 0,
  longG: 0,
};

const ams2State = {
  lapDistance: 0,
  totalDistance: 5000,
  lapTime: 0,
  lastSpeedMs: 0,
  lastTimestamp: 0,
};

function parseAMS2Packet(msg) {
  if (msg.length < 180) return null;
  const packetType = msg.readUInt8(10);

  // Packet 2: eTimings (Track Length and Lap Distance)
  if (packetType === 2 && msg.length >= 32) {
    try {
      const trackLength = msg.readFloatLE(24);
      if (trackLength > 500 && trackLength < 30000) {
        ams2State.totalDistance = Math.round(trackLength);
      }
      // Participant 0 (Player) lap distance at offset 32
      if (msg.length >= 36) {
        const p0LapDist = msg.readUInt16LE(32);
        if (p0LapDist > 0) ams2State.lapDistance = p0LapDist;
      }
    } catch (_e) {}
    return null;
  }

  if (packetType !== 0) return null; // 0 = eCarPhysics

  const now = Date.now();
  const speedMs = msg.readFloatLE(36);
  const speedKmh = Math.max(0, Math.round(speedMs * 3.6));
  const gearByte = msg.readUInt8(45);
  const gearNum = gearByte & 0x0f;

  // Integrate lap distance if eTimings packet not received
  if (ams2State.lastTimestamp > 0 && speedMs > 1) {
    const dt = Math.min(0.1, (now - ams2State.lastTimestamp) / 1000);
    ams2State.lapDistance = Math.round((ams2State.lapDistance + speedMs * dt) % ams2State.totalDistance);
  }
  ams2State.lastTimestamp = now;

  return {
    game: "Automobilista 2",
    speed: speedKmh,
    rpm: msg.readUInt16LE(40),
    gear: gearNum === 0 ? 0 : gearNum === 15 ? -1 : gearNum,
    throttle: Math.round((msg.readUInt8(30) / 255) * 100),
    brake: Math.round((msg.readUInt8(29) / 255) * 100),
    steer: Math.round((msg.readInt8(44) / 127) * 45),
    latG: Number((msg.readFloatLE(100) / 9.80665).toFixed(2)) || 0,
    longG: Number((msg.readFloatLE(108) / 9.80665).toFixed(2)) || 0,
    lapDistance: ams2State.lapDistance,
    totalDistance: ams2State.totalDistance,
    tyreTemps: {
      FL: msg.readUInt8(176) || 85, FR: msg.readUInt8(177) || 85,
      RL: msg.readUInt8(178) || 85, RR: msg.readUInt8(179) || 85,
    },
    tyrePressures: { FL: 26.8, FR: 26.8, RL: 26.4, RR: 26.4 },
  };
}

function parseForzaPacket(msg) {
  if (msg.length < 311) return null;
  const latG = Number((msg.readFloatLE(20) / 9.80665).toFixed(2)) || 0;
  const longG = Number((msg.readFloatLE(28) / 9.80665).toFixed(2)) || 0;
  const speedKmh = msg.length >= 236 ? Math.max(0, Math.round(msg.readFloatLE(232) * 3.6)) : 0;
  let tFL = 85, tFR = 85, tRL = 85, tRR = 85;
  if (msg.length >= 260) {
    const f = (o) => { const v = msg.readFloatLE(o); return v > 50 ? Math.round((v - 32) * 5 / 9) : 85; };
    tFL = f(244); tFR = f(248); tRL = f(252); tRR = f(256);
  }
  const lapDist = msg.length >= 272 ? Math.round(msg.readFloatLE(268)) : 0;
  // CarOrdinal at offset 212 (Forza Motorsport Data Out) — numeric ID, not a name
  const carOrdinal = msg.length >= 216 ? msg.readInt32LE(212) : 0;
  let throttle = 0, steer = 0, brake = 0, gear = 0;
  if (msg.length >= 297) {
    throttle = Math.round((msg.readUInt8(291) / 255) * 100);
    steer = Math.round((msg.readInt8(292) / 127) * 45);
    brake = Math.round((msg.readUInt8(293) / 255) * 100);
    const g = msg.readUInt8(296);
    gear = g === 0 ? -1 : g === 11 ? 0 : g;
  }
  return {
    game: "Forza Motorsport",
    car: carOrdinal ? `Car #${carOrdinal}` : "",
    speed: speedKmh,
    rpm: Math.round(msg.readFloatLE(16)),
    gear, throttle, brake, steer, latG, longG,
    lapDistance: lapDist,
    tyreTemps: { FL: tFL, FR: tFR, RL: tRL, RR: tRR },
    tyrePressures: { FL: 28.0, FR: 28.0, RL: 27.5, RR: 27.5 },
  };
}

// F1 track IDs → names (per Codemasters UDP spec)
const F1_TRACKS = {
  0: "Melbourne", 1: "Paul Ricard", 2: "Shanghai", 3: "Sakhir", 4: "Catalunya",
  5: "Monaco", 6: "Montreal", 7: "Silverstone", 8: "Hockenheim", 9: "Hungaroring",
  10: "Spa", 11: "Monza", 12: "Singapore", 13: "Suzuka", 14: "Abu Dhabi",
  15: "Texas", 16: "Brazil", 17: "Austria", 18: "Sochi", 19: "Mexico",
  20: "Baku", 21: "Sakhir Short", 22: "Silverstone Short", 23: "Texas Short",
  24: "Suzuka Short", 25: "Hanoi", 26: "Zandvoort", 27: "Imola", 28: "Portimão",
  29: "Jeddah", 30: "Miami", 31: "Las Vegas", 32: "Losail", 33: "Qatar",
};
// F1 team IDs → names
const F1_TEAMS = {
  0: "Mercedes", 1: "Ferrari", 2: "Red Bull Racing", 3: "Williams",
  4: "Aston Martin", 5: "Alpine", 6: "AlphaTauri", 7: "Haas",
  8: "McLaren", 9: "Alfa Romeo",
};

let f1TrackName = "";
let f1TeamName = "";

/**
 * F1 UDP wrapper: intercepts Session (1) and Participants (4) packets for
 * track/team detection, delegates Telemetry (6) packets to parseF1Packet.
 */
function parseF1Wrapper(msg) {
  if (!msg || msg.length < 24) return null;
  const packetFormat = msg.readUInt16LE(0);
  let headerSize, packetId, playerCarIndex;
  if (packetFormat >= 2023) {
    if (msg.length < 29) return null;
    headerSize = 29; packetId = msg.readUInt8(6); playerCarIndex = msg.readUInt8(27);
  } else if (packetFormat === 2022) {
    if (msg.length < 24) return null;
    headerSize = 24; packetId = msg.readUInt8(5); playerCarIndex = msg.readUInt8(22);
  } else return null;

  // Session packet (1): trackId at offset headerSize+12 (uint8)
  if (packetId === 1 && msg.length >= headerSize + 13) {
    const trackId = msg.readUInt8(headerSize + 12);
    const name = F1_TRACKS[trackId] || "";
    if (name && name !== f1TrackName) {
      console.log(`[F1] Track: ${name}`);
      f1TrackName = name;
      cloudTrackName = name;
      cloudSessionId = null;
    }
    return null;
  }
  // Participants packet (4): player teamId
  if (packetId === 4) {
    const stride = packetFormat >= 2023 ? 60 : 58; // approx participant record size
    const off = headerSize + playerCarIndex * stride;
    if (msg.length >= off + 2 && playerCarIndex >= 0) {
      // teamId is at a fixed offset within participant record (varies by version; try common)
      // For 2023+: header(29) + 22*60 records, teamId at record+1
      const teamId = msg.readUInt8(off + 1);
      const name = F1_TEAMS[teamId] || "";
      if (name && name !== f1TeamName) {
        console.log(`[F1] Team: ${name}`);
        f1TeamName = name;
        cloudCarName = name;
        cloudSessionId = null;
      }
    }
    return null;
  }
  // Telemetry packet (6)
  if (packetId === 6) {
    const frame = parseF1Packet(msg);
    if (frame) {
      if (f1TrackName) frame.track = f1TrackName;
      if (f1TeamName) frame.car = f1TeamName;
    }
    return frame;
  }
  return null;
}

// F1 22 / 23 / 24 / 25 (Port 20777, Packet 6: Car Telemetry)
function parseF1Packet(msg) {
  if (!msg || msg.length < 24) return null;

  const packetFormat = msg.readUInt16LE(0);
  let headerSize;
  let packetId;
  let playerCarIndex;

  if (packetFormat >= 2023) {
    if (msg.length < 29) return null;
    headerSize = 29;
    packetId = msg.readUInt8(6);
    playerCarIndex = msg.readUInt8(27);
  } else if (packetFormat === 2022) {
    if (msg.length < 24) return null;
    headerSize = 24;
    packetId = msg.readUInt8(5);
    playerCarIndex = msg.readUInt8(22);
  } else {
    return null;
  }

  if (playerCarIndex < 0 || playerCarIndex >= 22) return null;

  // Packet 2: Lap Data (Current Lap Distance, Lap Time, Lap Count)
  if (packetId === 2) {
    try {
      const lapStride = packetFormat >= 2024 ? 58 : packetFormat === 2023 ? 57 : 43;
      const offset = headerSize + playerCarIndex * lapStride;
      if (msg.length >= offset + 26) {
        const curLapTimeMs = msg.readUInt32LE(offset + 4);
        const lapDist = msg.readFloatLE(offset + 18);
        const totDist = msg.readFloatLE(offset + 22);

        if (!isNaN(lapDist)) f1LapData.lapDistance = Math.max(0, Math.round(lapDist));
        if (!isNaN(totDist) && totDist > 0) f1LapData.totalDistance = Math.max(5000, Math.round(totDist));
        if (curLapTimeMs > 0) f1LapData.lapTime = Number((curLapTimeMs / 1000).toFixed(2));
      }
    } catch (_e) {}
    return null; // Return null so we don't double broadcast, telemetry frame broadcasts on packet 6
  }

  // Packet 0: Motion (G-Forces)
  if (packetId === 0) {
    try {
      const motionStride = 60;
      const offset = headerSize + playerCarIndex * motionStride;
      if (msg.length >= offset + 44) {
        const gLat = msg.readFloatLE(offset + 36);
        const gLong = msg.readFloatLE(offset + 40);
        if (!isNaN(gLat)) f1LapData.latG = Number(gLat.toFixed(2));
        if (!isNaN(gLong)) f1LapData.longG = Number(gLong.toFixed(2));
      }
    } catch (_e) {}
    return null;
  }

  // Validate packetId == 6 (CarTelemetry)
  if (packetId !== 6) return null;

  const recordStride = 60;
  const recordOffset = headerSize + playerCarIndex * recordStride;
  if (msg.length < recordOffset + recordStride) return null;

  const speed = msg.readUInt16LE(recordOffset + 0);
  const throttleRaw = msg.readFloatLE(recordOffset + 2);
  const steerRaw = msg.readFloatLE(recordOffset + 6);
  const brakeRaw = msg.readFloatLE(recordOffset + 10);
  const gear = msg.readInt8(recordOffset + 15);
  const engineRPM = msg.readUInt16LE(recordOffset + 16);

  // F1 Tyre Surface Temps (RL, RR, FL, FR at byte 30..33)
  const tempRL = msg.readUInt8(recordOffset + 30);
  const tempRR = msg.readUInt8(recordOffset + 31);
  const tempFL = msg.readUInt8(recordOffset + 32);
  const tempFR = msg.readUInt8(recordOffset + 33);

  // F1 Tyre Pressures in PSI (RL, RR, FL, FR floats at byte 40..55)
  const pressRL = Math.round(msg.readFloatLE(recordOffset + 40) * 10) / 10;
  const pressRR = Math.round(msg.readFloatLE(recordOffset + 44) * 10) / 10;
  const pressFL = Math.round(msg.readFloatLE(recordOffset + 48) * 10) / 10;
  const pressFR = Math.round(msg.readFloatLE(recordOffset + 52) * 10) / 10;

  const throttle = Math.min(100, Math.max(0, Math.round(throttleRaw * 100)));
  const brake = Math.min(100, Math.max(0, Math.round(brakeRaw * 100)));
  const steer = Math.round(steerRaw * 100);

  return {
    game: packetFormat === 2022 ? "F1 22" : packetFormat === 2023 ? "F1 23" : "F1 24",
    speed,
    rpm: engineRPM,
    maxRpm: 15000,
    gear: gear === 0 ? 0 : gear === -1 ? -1 : gear,
    throttle,
    brake,
    steer,
    latG: f1LapData.latG || 0,
    longG: f1LapData.longG || 0,
    lapDistance: f1LapData.lapDistance || 0,
    totalDistance: f1LapData.totalDistance || 5891,
    lapTime: f1LapData.lapTime || 0,
    tyreTemps: {
      FL: tempFL > 0 ? tempFL : 95,
      FR: tempFR > 0 ? tempFR : 95,
      RL: tempRL > 0 ? tempRL : 95,
      RR: tempRR > 0 ? tempRR : 95,
    },
    tyrePressures: {
      FL: pressFL > 10 ? pressFL : 23.5,
      FR: pressFR > 10 ? pressFR : 23.5,
      RL: pressRL > 10 ? pressRL : 21.0,
      RR: pressRR > 10 ? pressRR : 21.0,
    },
  };
}

/**
 * Speak text on the rig via Windows Speech API (SAPI).
 * If PTT_SPEAKER is set (output device name/index) and the PTT sidecar is
 * alive, the sidecar renders the WAV and plays it on that device (e.g.
 * wireless headphones). Otherwise falls back to direct SAPI on the default
 * device. Fire-and-forget.
 */
function speakViaBridge(text) {
  if (!text || typeof text !== "string") return;
  const short = text.slice(0, 600);
  const routed = process.env.PTT_SPEAKER && pttSidecar && pttSidecar.stdin;
  if (routed) {
    try {
      pttSidecar.stdin.write(JSON.stringify({ cmd: "speak", text: short }) + "\n");
      console.log(`[PTT] Speaking engineer reply on "${process.env.PTT_SPEAKER}" (${short.length} chars)`);
    } catch (e) {
      console.warn(`[PTT] Sidecar speak failed: ${e.message}`);
    }
    return;
  }
  try {
    const { execFile } = require("child_process");
    const b64 = Buffer.from(short, "utf16le").toString("base64");
    const voiceName = (process.env.PTT_VOICE || "").replace(/'/g, "");
    const ps = [
      "$t=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"+b64+"'));",
      "Add-Type -AssemblyName System.Speech;",
      "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      voiceName ? "$s.SelectVoice('"+voiceName+"');" : "",
      "$s.Rate=1;",
      "$s.Speak($t)|Out-Null",
    ].join(" ");
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 30000 }, () => {});
    console.log(`[PTT] Speaking engineer reply (${short.length} chars)`);
  } catch (e) {
    console.warn(`[PTT] TTS failed: ${e.message}`);
  }
}

/**
 * Transcribe PTT audio via the cloud /api/ptt/transcribe endpoint.
 * wavBuffer: 16kHz mono 16-bit WAV, <=280KB (~8s).
 * Returns the transcript string, or null on failure.
 */
async function transcribePTTAudio(wavBuffer) {
  if (!CLOUD_API_URL || !CLOUD_BRIDGE_KEY) {
    console.warn("[PTT] Skipping transcription: APEXWALL_API_URL / APEXWALL_BRIDGE_KEY not set");
    return null;
  }
  try {
    const r = await fetch(`${CLOUD_API_URL}/api/ptt/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Bridge-Key": CLOUD_BRIDGE_KEY,
      },
      body: wavBuffer,
    });
    if (!r.ok) {
      console.warn(`[PTT] Transcription failed: HTTP ${r.status}`);
      return null;
    }
    const data = await r.json();
    return data.transcript || null;
  } catch (e) {
    console.warn(`[PTT] Transcription error: ${e.message}`);
    return null;
  }
}

/**
 * PTT voice sidecar: spawns scripts/ptt-bridge.py, which watches wheel
 * buttons (DirectInput) and records the mic while PTT is held.
 * Audio comes back over stdout as base64 WAV -> transcribed -> broadcast.
 */
function startPTTSidecar() {
  const path = require("path");
  const fs = require("fs");
  const { spawn } = require("child_process");
  const readline = require("readline");
  const scriptPath = (() => {
    const candidates = [
      path.join(path.dirname(process.execPath), "ptt-bridge.py"),
      path.join(__dirname, "ptt-bridge.py"),
      path.join(__dirname, "..", "scripts", "ptt-bridge.py"),
    ];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  })();
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[PTT] ptt-bridge.py not found at ${scriptPath} — voice PTT disabled`);
    return;
  }
  console.log("[PTT] Starting wheel-button PTT sidecar (pip install pygame-ce sounddevice if it fails)...");
  try {
    const py = spawn("python", [scriptPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        // Config file values feed the sidecar; explicit env vars still win.
        PTT_MIC: process.env.PTT_MIC || fileConfig.pttMic || "",
        PTT_SPEAKER: process.env.PTT_SPEAKER || fileConfig.pttSpeaker || "",
        PTT_TTS_ENGINE: process.env.PTT_TTS_ENGINE || fileConfig.pttTtsEngine || "",
        PTT_TTS_FULL: process.env.PTT_TTS_FULL || fileConfig.pttTtsFull || "",
      },
    });
    pttSidecar = py;
    deviceCache.sidecar = true;
    py.on("error", (e) => {
      console.warn(`[PTT] Sidecar failed to start: ${e.message} (is Python installed?)`);
      pttSidecar = null;
      deviceCache.sidecar = false;
    });
    py.on("exit", (code) => {
      console.warn(`[PTT] Sidecar exited (code ${code})`);
      if (pttSidecar === py) pttSidecar = null;
      deviceCache.sidecar = false;
    });
    const rl = readline.createInterface({ input: py.stdout });
    rl.on("line", (line) => {
      let msg;
      try {
        if (!line.trim()) return;
        msg = JSON.parse(line.trim());
      } catch (_e) { return; }
      if (!msg || !msg.type) return;

      if (msg.type === "ptt_audio" && msg.wav_b64) {
        const wav = Buffer.from(msg.wav_b64, "base64");
        console.log(`[PTT] Got ${(wav.length / 1024).toFixed(0)}KB audio, transcribing...`);
        transcribePTTAudio(wav).then((transcript) => {
          if (transcript) {
            console.log(`[PTT] Transcript: "${transcript}"`);
            broadcastMessage("ptt_transcript", { text: transcript });
          }
        });
      } else if (msg.type === "ptt_button") {
        // Diagnostic monitor: log button activity to the bridge console
        console.log(`[PTT] Button ${msg.button} ${msg.state}`);
        broadcastMessage("ptt_button", { button: msg.button, state: msg.state });
      } else if (msg.type === "ptt_learned" && msg.button) {
        console.log(`[PTT] Learned wheel button: ${msg.button}`);
        // Persist to config so it survives restarts
        if (!fileConfig.pttButtons.includes(msg.button)) {
          fileConfig.pttButtons.push(msg.button);
          fileConfig.pttButtons.sort();
          saveConfigFile(fileConfig);
        }
        broadcastMessage("ptt_learned", { button: msg.button });
      } else if (msg.type === "ptt_listening") {
        broadcastMessage("ptt_listening", { active: !!msg.active });
      } else if (msg.type === "ptt_status") {
        if (msg.ok === false && msg.error) console.warn(`[PTT] ${msg.error}`);
        else {
          if (msg.joysticks) {
            const names = msg.joysticks.map((j) => `#${j.index} ${j.name}`).join(", ");
            console.log(`[PTT] Joysticks: ${names || "none"} | Mic: ${msg.mic || "none"}`);
            deviceCache.joysticks = msg.joysticks;
            if (msg.mic) deviceCache.mic = msg.mic;
          }
          if (msg.output_devices) {
            const outs = msg.output_devices.map((d) => `#${d.index} ${d.name}`).join(" | ");
            console.log(`[PTT] Output devices: ${outs || "none"} — set PTT_SPEAKER to (part of) a name to route engineer voice there`);
            deviceCache.outputs = msg.output_devices.map((d) => ({ name: d.name }));
          }
          if (msg.input_devices) {
            deviceCache.inputs = msg.input_devices.map((d) => ({ name: d.name }));
          }
          if (msg.speaker) { console.log(`[PTT] Engineer voice -> "${msg.speaker}"`); deviceCache.speaker = msg.speaker; }
          // Push the persisted button map once the sidecar is up
          if (fileConfig.pttButtons.length && pttSidecar && pttSidecar.stdin && !startPTTSidecar._mapSent) {
            startPTTSidecar._mapSent = true;
            try { pttSidecar.stdin.write(JSON.stringify({ cmd: "map", buttons: fileConfig.pttButtons }) + "\n"); } catch (_e) {}
          }
        }
        broadcastMessage("ptt_status", msg);
      }
    });
  } catch (e) {
    console.warn(`[PTT] Could not start sidecar: ${e.message}`);
    pttSidecar = null;
  }
}

// =========================================================================
// iRACING (shared memory via @emiliosp/node-iracing-sdk)
// =========================================================================

let iracingActive = false;

async function startIracingReader() {
  let sdk;
  try {
    sdk = require("@emiliosp/node-iracing-sdk");
  } catch (e) {
    console.warn(`[iRacing] shared memory unavailable: ${e.message}`);
    // Hint for .exe users: the koffi/ sidecar folder must sit next to the exe
    try {
      const path = require("path");
      const fs = require("fs");
      const sidecar = path.join(path.dirname(process.execPath), "koffi", "index.js");
      if (!fs.existsSync(sidecar)) {
        console.warn(`[iRacing] koffi sidecar not found at ${sidecar} — extract the full zip (exe + koffi folder).`);
      }
    } catch {}
    return;
  }

  const { IRSDK, VARS } = sdk;
  let ir = null;
  let pollCount = 0;
  let lastCarName = "";
  let lastTrackName = "";

  // Check session info for car/track changes (every ~5s, not every frame)
  const checkSessionInfo = () => {
    try {
      const weekend = ir.getSessionInfo("WeekendInfo");
      const driverInfo = ir.getSessionInfo("DriverInfo");
      const track = weekend?.TrackDisplayName || "";
      let car = "";
      if (driverInfo?.Drivers && typeof driverInfo.DriverCarIdx === "number") {
        car = driverInfo.Drivers[driverInfo.DriverCarIdx]?.CarScreenName || "";
      }
      if ((track && track !== lastTrackName) || (car && car !== lastCarName)) {
        if (lastTrackName || lastCarName) {
          console.log(`[iRacing] Car/track changed: ${car || "?"} @ ${track || "?"}`);
        } else {
          console.log(`[iRacing] ${car || "?"} @ ${track || "?"}`);
        }
        lastCarName = car;
        lastTrackName = track;
        // Reset cloud session so laps go to a new session
        cloudSessionId = null;
        cloudCarName = car;
        cloudTrackName = track;
        // Update activeGame label with car/track
        if (car || track) {
          activeGame = `iRacing - ${car}${track ? ` @ ${track}` : ""}`;
        }
      }
    } catch {}
  };

  const poll = async () => {
    try {
      if (!ir) {
        ir = await IRSDK.connect(); // throws if iRacing not running
        console.log("[iRacing] Connected to shared memory");
      }
      ir.refreshSharedMemory();
      const g = (v) => { const a = ir.get(v); return a && a.length ? a[0] : 0; };

      // Session info check every ~5s (300 polls at 60Hz)
      if (++pollCount % 300 === 0) checkSessionInfo();

      const speedMs = g(VARS.SPEED);
      if (speedMs < 1 && !iracingActive) { setTimeout(poll, 1000); return; }
      iracingActive = true;

      const kpaToPsi = (kpa) => (kpa ? Number((kpa * 0.145038).toFixed(2)) : 27.0);

      broadcastFrame({
        game: "iRacing",
        speed: Math.round(speedMs * 3.6),
        rpm: Math.round(g(VARS.RPM)),
        gear: Math.round(g(VARS.GEAR)),
        throttle: Math.round(g(VARS.THROTTLE) * 100),
        brake: Math.round(g(VARS.BRAKE) * 100),
        steer: Number((g(VARS.STEERING_WHEEL_ANGLE) * 57.2958).toFixed(1)),
        latG: Number((g(VARS.LAT_ACCEL) / 9.81).toFixed(2)),
        longG: Number((g(VARS.LONG_ACCEL) / 9.81).toFixed(2)),
        lapDistance: Math.round(g(VARS.LAP_DIST)),
        lapNumber: Math.round(g(VARS.LAP)),
        tyreTemps: {
          FL: Math.round(g(VARS.L_FTEMP_CM)) || 85,
          FR: Math.round(g(VARS.R_FTEMP_CM)) || 85,
          RL: Math.round(g(VARS.L_RTEMP_CM)) || 85,
          RR: Math.round(g(VARS.R_RTEMP_CM)) || 85,
        },
        tyrePressures: {
          FL: kpaToPsi(g(VARS.L_FCOLD_PRESSURE)),
          FR: kpaToPsi(g(VARS.R_FCOLD_PRESSURE)),
          RL: kpaToPsi(g(VARS.L_RCOLD_PRESSURE)),
          RR: kpaToPsi(g(VARS.R_RCOLD_PRESSURE)),
        },
      });
    } catch {
      if (ir) { try { ir.shutdown(); } catch {} ir = null; }
      if (iracingActive) { console.log("[iRacing] Disconnected"); iracingActive = false; }
    }
    setTimeout(poll, 1000 / 60);
  };

  console.log("[iRacing] Watching for iRacing shared memory...");
  poll();
}

// =========================================================================
// STARTUP
// =========================================================================

if (isTestMode) {
  console.log("[SIM] Synthetic 60Hz test feed...");
  activeGame = "Synthetic Test";
  let progress = 0;
  setInterval(() => {
    progress = (progress + 0.002) % 1;
    const speed = 120 + Math.sin(progress * 15) * 80;
    const thr = Math.max(0, Math.sin(progress * 10) * 100);
    const brk = thr > 20 ? 0 : 85;
    const steer = Math.sin(progress * 25) * 45;
    broadcastFrame({
      game: "Synthetic Test",
      speed: Math.round(speed),
      rpm: 7200, gear: speed > 180 ? 5 : speed > 130 ? 4 : 3,
      throttle: Math.round(thr), brake: Math.round(brk), steer: Math.round(steer),
      latG: Number(((steer / 45) * 2.5).toFixed(2)),
      longG: brk > 0 ? -3.2 : 1.1,
      lapDistance: Math.round(progress * 7004),
      tyreTemps: { FL: 90, FR: 88, RL: 85, RR: 84 },
      tyrePressures: { FL: 26.9, FR: 27.1, RL: 26.8, RR: 27.0 },
    });
  }, 1000 / 60);
} else {
  function startUDPListener(name, port, parserFn) {
    try {
      const sock = dgram.createSocket("udp4");
      sock.on("error", (err) => {
        console.warn(`[UDP ${name}] ${err.message}`);
        try { sock.close(); } catch {}
      });
      sock.on("message", (msg) => {
        try {
          const frame = parserFn(msg);
          if (frame) broadcastFrame(frame);
        } catch {}
      });
      sock.bind(port, () => console.log(`[UDP] Listening: ${name} on port ${port}`));
    } catch (e) {
      console.warn(`[UDP ${name}] Could not bind port ${port}: ${e.message}`);
    }
  }

  // Sim enablement: --game CLI filter wins; otherwise the config file toggles apply.
  const want = (n) => {
    if (gameFilter) return gameFilter === n;
    const key = { iracing: "iracing", acc: "acc", "assetto-corsa-competizione": "acc", ams2: "ams2", automobilista: "ams2", pcars2: "ams2", forza: "forza", f1: "f1" }[n] || n;
    return fileConfig.sims[key] !== false;
  };

  if (want("iracing")) startIracingReader();
  if (want("ams2") || want("automobilista") || want("pcars2"))
    startUDPListener("Automobilista 2", PORTS.AMS2, parseAMS2Packet);
  if (want("forza")) startUDPListener("Forza", PORTS.FORZA, parseForzaPacket);
  if (want("f1")) startUDPListener("F1 22/23/24/25", PORTS.F1, parseF1Wrapper);

  // PTT voice sidecar — wheel-button push-to-talk for the race engineer.
  // Runs always (not game-filtered): the driver may key the mic in any sim.
  // Requires: pip install pygame-ce sounddevice (one-time on the rig).
  startPTTSidecar();

  // Assetto Corsa Competizione — Python shared-memory bridge (spawns acc-bridge.py)
  if (want("acc") || want("assetto-corsa-competizione")) {
    console.log("[ACC] Launching Assetto Corsa Competizione Shared Memory Bridge...");
    const path = require("path");
    const fs = require("fs");
    const { spawn } = require("child_process");
    const readline = require("readline");
    const scriptPath = (() => {
      // When running as a SEA exe, __dirname is inside the blob — look next to the exe.
      const candidates = [
        path.join(path.dirname(process.execPath), "acc-bridge.py"),
        path.join(__dirname, "acc-bridge.py"),
        path.join(__dirname, "..", "scripts", "acc-bridge.py"),
      ];
      return candidates.find((p) => fs.existsSync(p)) || candidates[0];
    })();
    if (fs.existsSync(scriptPath)) {
      const pyProcess = spawn("python", [scriptPath], { stdio: ["ignore", "pipe", "inherit"] });
      const rl = readline.createInterface({ input: pyProcess.stdout });
      rl.on("line", (line) => {
        try {
          if (!line.trim()) return;
          const frame = JSON.parse(line.trim());
          activeGame = "Assetto Corsa Competizione";
          broadcastFrame(frame);
        } catch (_e) {}
      });
      pyProcess.on("error", (e) => {
        console.warn(`[ACC] Python bridge failed to start: ${e.message} (is Python installed?)`);
      });
    } else {
      console.warn(`[ACC] acc-bridge.py not found at ${scriptPath}`);
    }
  }
}
