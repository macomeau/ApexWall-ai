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

const PORTS = {
  AMS2: 5606,
  FORZA: 5300,
  F1: 20777,
};

let activeGame = "Awaiting Sim Connection";
let totalPacketsReceived = 0;
let lastPacketTime = 0;

// Lap recorder state
let activeLapBuffer = [];
let lastCompletedLap = null;
let lapCounter = 0;
let lapStartTime = Date.now();
let lastLapDistance = 0;
let lastLapNumber = -1;

console.log("=================================================================");
console.log("  APEXWALL AI // SIM RIG TELEMETRY BRIDGE");
console.log("=================================================================");
if (isTestMode) {
  console.log("  Mode: Synthetic 60Hz test feed");
} else {
  console.log(`  Mode: ${gameFilter ? `Dedicated [${gameFilter.toUpperCase()}]` : "Auto-Detect (all sims)"}`);
  console.log("  Listening:");
  if (!gameFilter || gameFilter === "iracing") console.log("    - iRacing                  : Shared Memory");
  if (!gameFilter || gameFilter === "acc") console.log("    - Assetto Corsa Competizione: Shared Memory (Python bridge)");
  if (!gameFilter || ["ams2", "automobilista", "pcars2"].includes(gameFilter)) console.log(`    - Automobilista 2 / pCARS2 : UDP ${PORTS.AMS2}`);
  if (!gameFilter || gameFilter === "forza") console.log(`    - Forza Motorsport/Horizon : UDP ${PORTS.FORZA}`);
  if (!gameFilter || gameFilter === "f1") console.log(`    - F1 22 / 23 / 24 / 25     : UDP ${PORTS.F1}`);
}
console.log(`  HTTP API  : http://localhost:${WS_PORT}/api/status`);
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
      version: "1.0.0",
      activeGame,
      isReceiving,
      totalPackets: totalPacketsReceived,
      lapCounter,
      currentLapPointsCount: activeLapBuffer.length,
      hasCompletedLap: !!lastCompletedLap,
      lastLapTime: lastCompletedLap ? lastCompletedLap.lapTime : null,
      lastLapPointCount: lastCompletedLap ? lastCompletedLap.points.length : 0,
    }));
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
wss.on("connection", (ws) => {
  activeClients.push(ws);
  ws.on("close", () => { activeClients = activeClients.filter((c) => c !== ws); });
});

server.listen(WS_PORT, () => {
  console.log(`[BRIDGE] Listening on http://localhost:${WS_PORT}\n`);
});

// --- Frame pipeline: buffer into lap, detect lap completion ---

function broadcastFrame(frame) {
  totalPacketsReceived++;
  lastPacketTime = Date.now();

  if (activeGame !== frame.game) {
    activeGame = frame.game;
    console.log(`[DETECT] Active sim: ${activeGame}`);
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

function parseAMS2Packet(msg) {
  if (msg.length < 180) return null;
  if (msg.readUInt8(10) !== 0) return null; // eCarPhysics
  const speedKmh = Math.max(0, Math.round(msg.readFloatLE(36) * 3.6));
  const gearByte = msg.readUInt8(45);
  const gearNum = gearByte & 0x0f;
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
    lapDistance: 0,
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
    speed: speedKmh,
    rpm: Math.round(msg.readFloatLE(16)),
    gear, throttle, brake, steer, latG, longG,
    lapDistance: lapDist,
    tyreTemps: { FL: tFL, FR: tFR, RL: tRL, RR: tRR },
    tyrePressures: { FL: 28.0, FR: 28.0, RL: 27.5, RR: 27.5 },
  };
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

  // Validate packetId == 6 (CarTelemetry)
  if (packetId !== 6) return null;
  if (playerCarIndex < 0 || playerCarIndex >= 22) return null;

  const recordStride = 60;
  const recordOffset = headerSize + playerCarIndex * recordStride;
  if (msg.length < recordOffset + recordStride) return null;

  const speed = msg.readUInt16LE(recordOffset + 0);
  const throttleRaw = msg.readFloatLE(recordOffset + 2);
  const steerRaw = msg.readFloatLE(recordOffset + 6);
  const brakeRaw = msg.readFloatLE(recordOffset + 10);
  const gear = msg.readInt8(recordOffset + 15);
  const engineRPM = msg.readUInt16LE(recordOffset + 16);

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
    latG: 0,
    longG: 0,
    lapDistance: 0,
    tyreTemps: { FL: 95, FR: 93, RL: 92, RR: 90 },
    tyrePressures: { FL: 23.5, FR: 23.5, RL: 21.0, RR: 21.0 },
  };
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

  const poll = async () => {
    try {
      if (!ir) {
        ir = await IRSDK.connect(); // throws if iRacing not running
        console.log("[iRacing] Connected to shared memory");
      }
      ir.refreshSharedMemory();
      const g = (v) => { const a = ir.get(v); return a && a.length ? a[0] : 0; };

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

  const want = (n) => !gameFilter || gameFilter === n;

  if (want("iracing")) startIracingReader();
  if (want("ams2") || want("automobilista") || want("pcars2"))
    startUDPListener("Automobilista 2", PORTS.AMS2, parseAMS2Packet);
  if (want("forza")) startUDPListener("Forza", PORTS.FORZA, parseForzaPacket);
  if (want("f1")) startUDPListener("F1 22/23/24/25", PORTS.F1, parseF1Packet);

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
