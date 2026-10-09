// Self-contained bridge configuration dashboard, served at http://localhost:9001/config
// Bundled into the bridge exe via esbuild — no external assets.
const CONFIG_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ApexWall Bridge — Configuration</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0b0e14; color: #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif; padding: 24px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  h1 .tag { font-size: 11px; font-weight: 400; color: #64748b; font-family: ui-monospace, monospace; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 20px; }
  .card { background: #111726; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; font-family: ui-monospace, monospace; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 14px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .row:last-child { border-bottom: none; }
  .lbl { font-size: 13px; color: #cbd5e1; }
  .hint { font-size: 11px; color: #64748b; margin-top: 2px; }
  input[type=text], input[type=password], select { background: #0b0e14; border: 1px solid rgba(255,255,255,0.12); color: #e2e8f0; border-radius: 8px; padding: 8px 10px; font-size: 13px; width: 280px; max-width: 100%; }
  input:focus, select:focus { outline: none; border-color: #06b6d4; }
  button { cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: 600; padding: 8px 16px; border: 1px solid transparent; transition: all 0.15s; }
  .btn-primary { background: #0891b2; color: #fff; border-color: #06b6d4; }
  .btn-primary:hover { background: #06b6d4; }
  .btn-ghost { background: rgba(255,255,255,0.04); color: #cbd5e1; border-color: rgba(255,255,255,0.1); }
  .btn-ghost:hover { border-color: #06b6d4; color: #fff; }
  .btn-danger { background: transparent; color: #64748b; border: none; padding: 4px 8px; font-size: 12px; }
  .btn-danger:hover { color: #f87171; }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
  .chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.3); color: #6ee7b7; font-family: ui-monospace, monospace; font-size: 12px; padding: 5px 10px; border-radius: 999px; }
  .chip button { background: none; border: none; color: #6ee7b7; font-size: 14px; padding: 0; line-height: 1; }
  .chip button:hover { color: #f87171; }
  .empty { color: #475569; font-size: 12px; padding: 6px 0; }
  .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { background: #0b0e14; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 12px; }
  .stat .k { font-size: 10px; color: #64748b; font-family: ui-monospace, monospace; letter-spacing: 0.06em; }
  .stat .v { font-size: 15px; font-weight: 600; margin-top: 2px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.ok { background: #34d399; } .dot.bad { background: #475569; } .dot.warn { background: #fbbf24; }
  .toggle { position: relative; width: 40px; height: 22px; background: #1e293b; border-radius: 999px; border: 1px solid rgba(255,255,255,0.1); cursor: pointer; flex-shrink: 0; }
  .toggle.on { background: #0891b2; border-color: #06b6d4; }
  .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #94a3b8; transition: all 0.15s; }
  .toggle.on::after { left: 20px; background: #fff; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #111726; border: 1px solid rgba(16,185,129,0.4); color: #6ee7b7; padding: 10px 20px; border-radius: 10px; font-size: 13px; display: none; z-index: 99; }
  .restart-note { font-size: 11px; color: #fbbf24; margin-top: 10px; }
  .footer { text-align: center; color: #334155; font-size: 11px; margin-top: 24px; font-family: ui-monospace, monospace; }
  @media (max-width: 560px) { .status-grid { grid-template-columns: 1fr; } input[type=text], input[type=password], select { width: 100%; } .row { flex-direction: column; align-items: stretch; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>APEXWALL BRIDGE <span class="tag" id="ver">v1.0.0</span></h1>
  <div class="sub">Rig telemetry bridge — configuration &amp; status. Served locally by the bridge.</div>

  <div class="card">
    <h2>STATUS</h2>
    <div class="status-grid">
      <div class="stat"><div class="k">BRIDGE</div><div class="v"><span class="dot ok" id="dot-bridge"></span><span id="st-bridge">Running</span></div></div>
      <div class="stat"><div class="k">ACTIVE SIM</div><div class="v" id="st-sim">—</div></div>
      <div class="stat"><div class="k">UPTIME</div><div class="v" id="st-uptime">—</div></div>
      <div class="stat"><div class="k">PACKETS</div><div class="v" id="st-packets">—</div></div>
      <div class="stat"><div class="k">PTT SIDECAR</div><div class="v"><span class="dot bad" id="dot-ptt"></span><span id="st-ptt">—</span></div></div>
      <div class="stat"><div class="k">MIC</div><div class="v" id="st-mic" style="font-size:12px">—</div></div>
    </div>
  </div>

  <div class="card">
    <h2>CLOUD CONNECTION</h2>
    <div class="row"><div><div class="lbl">API URL</div><div class="hint">Your ApexWall cloud function base URL.</div></div>
      <input type="text" id="cfg-apiUrl" placeholder="https://…"></div>
    <div class="row"><div><div class="lbl">Bridge key</div><div class="hint">Pre-shared key (BRIDGE_API_KEY). Stored locally on this PC only.</div></div>
      <input type="password" id="cfg-bridgeKey" placeholder="••••••••"></div>
    <div class="row"><div><div class="lbl">User ID</div><div class="hint">BRIDGE_USER_ID — your ApexWall user id.</div></div>
      <input type="text" id="cfg-bridgeUserId" placeholder="user_…"></div>
    <div style="margin-top:12px; display:flex; gap:8px;">
      <button class="btn-primary" onclick="saveCloud()">Save</button>
      <button class="btn-ghost" onclick="testCloud()">Test connection</button>
      <span id="cloud-test" style="font-size:12px; align-self:center;"></span>
    </div>
  </div>

  <div class="card">
    <h2>VOICE PTT</h2>
    <div class="row"><div><div class="lbl">Microphone</div><div class="hint">Input device for push-to-talk recording.</div></div>
      <select id="cfg-pttMic"><option value="">System default</option></select></div>
    <div class="row"><div><div class="lbl">Engineer voice output</div><div class="hint">Where the engineer's spoken replies play (e.g. wireless headphones).</div></div>
      <select id="cfg-pttSpeaker"><option value="">System default</option></select></div>
    <div class="row"><div><div class="lbl">Bridge voice replies</div><div class="hint">Speak engineer answers on the rig via Windows TTS.</div></div>
      <div class="toggle" id="tgl-bridgeVoice" onclick="toggleVoice()"></div></div>
    <div style="margin-top:14px;">
      <div class="lbl" style="margin-bottom:4px;">Mapped PTT buttons <span class="hint">(joystick:button — works in-game)</span></div>
      <div class="chips" id="ptt-chips"></div>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button class="btn-ghost" id="btn-learn" onclick="learnPtt()">+ Learn wheel button</button>
      </div>
      <div class="hint" id="learn-hint" style="display:none; color:#fbbf24;">Press a wheel button now… (15s timeout)</div>
    </div>
    <div style="margin-top:12px;"><button class="btn-primary" onclick="savePtt()">Save</button></div>
    <div class="hint" style="margin-top:8px;">Device changes apply on bridge restart. Button map applies immediately.</div>
  </div>

  <div class="card">
    <h2>SIM INPUTS</h2>
    <div id="sim-toggles"></div>
    <div class="restart-note">⚠ Sim toggles take effect after restarting the bridge.</div>
    <div style="margin-top:12px;"><button class="btn-primary" onclick="saveSims()">Save</button></div>
  </div>

  <div class="footer">ApexWall Bridge · config stored on this PC · <span id="cfg-path"></span></div>
</div>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
let cfg = {};
let learning = false;

function toast(msg, ok=true) {
  const t = $("toast");
  t.textContent = msg;
  t.style.borderColor = ok ? "rgba(16,185,129,0.4)" : "rgba(248,113,113,0.4)";
  t.style.color = ok ? "#6ee7b7" : "#fca5a5";
  t.style.display = "block";
  setTimeout(() => t.style.display = "none", 2500);
}

async function loadConfig() {
  const r = await fetch("/api/config");
  cfg = await r.json();
  $("cfg-apiUrl").value = cfg.apiUrl || "";
  $("cfg-bridgeKey").value = cfg.bridgeKey || "";
  $("cfg-bridgeUserId").value = cfg.bridgeUserId || "";
  $("cfg-pttMic").value = cfg.pttMic || "";
  $("cfg-pttSpeaker").value = cfg.pttSpeaker || "";
  $("tgl-bridgeVoice").classList.toggle("on", cfg.bridgeVoice !== false);
  $("cfg-path").textContent = cfg._path || "";
  renderChips();
  renderSims();
}

async function loadDevices() {
  try {
    const r = await fetch("/api/devices");
    const d = await r.json();
    const micSel = $("cfg-pttMic"), spkSel = $("cfg-pttSpeaker");
    const curMic = cfg.pttMic || "", curSpk = cfg.pttSpeaker || "";
    (d.inputs || []).forEach((dev) => {
      const o = document.createElement("option");
      o.value = dev.name; o.textContent = dev.name;
      if (dev.name === curMic) o.selected = true;
      micSel.appendChild(o);
    });
    (d.outputs || []).forEach((dev) => {
      const o = document.createElement("option");
      o.value = dev.name; o.textContent = dev.name;
      if (dev.name === curSpk) o.selected = true;
      spkSel.appendChild(o);
    });
    if (!d.sidecar) {
      micSel.disabled = spkSel.disabled = true;
      micSel.title = spkSel.title = "PTT sidecar not running (pip install pygame sounddevice)";
    }
  } catch (e) {}
}

function renderChips() {
  const box = $("ptt-chips");
  box.innerHTML = "";
  const btns = cfg.pttButtons || [];
  if (!btns.length) { box.innerHTML = '<div class="empty">No buttons mapped yet.</div>'; return; }
  btns.forEach((b) => {
    const s = document.createElement("span");
    s.className = "chip";
    s.innerHTML = b + ' <button title="Unmap">×</button>';
    s.querySelector("button").onclick = () => {
      cfg.pttButtons = cfg.pttButtons.filter((x) => x !== b);
      renderChips(); pushMap();
    };
    box.appendChild(s);
  });
}

const SIMS = [["iracing","iRacing"],["acc","Assetto Corsa Competizione"],["ams2","Automobilista 2 / pCARS2"],["forza","Forza Motorsport / Horizon"],["f1","F1 22–25"]];
function renderSims() {
  const box = $("sim-toggles");
  box.innerHTML = "";
  SIMS.forEach(([key, label]) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = '<div><div class="lbl">' + label + '</div></div>';
    const t = document.createElement("div");
    t.className = "toggle" + ((cfg.sims || {})[key] !== false ? " on" : "");
    t.onclick = () => {
      cfg.sims = cfg.sims || {};
      cfg.sims[key] = !(cfg.sims[key] !== false);
      t.classList.toggle("on", cfg.sims[key]);
    };
    row.appendChild(t);
    box.appendChild(row);
  });
}

async function postConfig(patch) {
  const r = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const j = await r.json();
  if (j.ok) { cfg = j.config; toast("Saved"); }
  else toast(j.error || "Save failed", false);
  return j;
}

function saveCloud() {
  postConfig({ apiUrl: $("cfg-apiUrl").value.trim(), bridgeKey: $("cfg-bridgeKey").value, bridgeUserId: $("cfg-bridgeUserId").value.trim() });
}
function savePtt() {
  postConfig({ pttMic: $("cfg-pttMic").value, pttSpeaker: $("cfg-pttSpeaker").value, bridgeVoice: $("tgl-bridgeVoice").classList.contains("on"), pttButtons: cfg.pttButtons || [] });
}
function saveSims() {
  const sims = {};
  document.querySelectorAll("#sim-toggles .toggle").forEach((t, i) => { sims[SIMS[i][0]] = t.classList.contains("on"); });
  postConfig({ sims });
}
function toggleVoice() { $("tgl-bridgeVoice").classList.toggle("on"); }

async function pushMap() {
  // Push button map to the sidecar immediately (no full save needed)
  try {
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pttButtons: cfg.pttButtons || [] }) });
  } catch (e) {}
}

async function testCloud() {
  const el = $("cloud-test");
  el.textContent = "testing…"; el.style.color = "#94a3b8";
  try {
    const r = await fetch("/api/config/test", { method: "POST" });
    const j = await r.json();
    el.textContent = j.ok ? "✓ " + (j.detail || "connected") : "✗ " + (j.error || "failed");
    el.style.color = j.ok ? "#34d399" : "#f87171";
  } catch (e) { el.textContent = "✗ request failed"; el.style.color = "#f87171"; }
}

async function learnPtt() {
  if (learning) return;
  learning = true;
  $("btn-learn").disabled = true;
  $("learn-hint").style.display = "block";
  const before = JSON.stringify(cfg.pttButtons || []);
  try { await fetch("/api/ptt/learn", { method: "POST" }); } catch (e) {}
  // Poll for the newly learned button
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await fetch("/api/config");
      const fresh = await r.json();
      if (JSON.stringify(fresh.pttButtons || []) !== before) {
        cfg = fresh; renderChips();
        toast("Button learned: " + fresh.pttButtons[fresh.pttButtons.length - 1]);
        break;
      }
    } catch (e) {}
  }
  learning = false;
  $("btn-learn").disabled = false;
  $("learn-hint").style.display = "none";
}

async function pollStatus() {
  try {
    const r = await fetch("/api/status");
    const s = await r.json();
    $("st-sim").textContent = s.activeGame || "—";
    $("st-packets").textContent = (s.totalPackets || 0).toLocaleString();
    if (s.uptimeSec != null) {
      const h = Math.floor(s.uptimeSec / 3600), m = Math.floor((s.uptimeSec % 3600) / 60);
      $("st-uptime").textContent = h > 0 ? h + "h " + m + "m" : m + "m";
    }
    $("ver").textContent = "v" + (s.version || "1.0.0");
    const pttOk = !!s.pttSidecar;
    $("dot-ptt").className = "dot " + (pttOk ? "ok" : "bad");
    $("st-ptt").textContent = pttOk ? "Running" : "Not running";
    $("st-mic").textContent = s.pttMic || "—";
  } catch (e) {}
}

loadConfig().then(loadDevices);
pollStatus();
setInterval(pollStatus, 3000);
</script>
</body>
</html>`;

module.exports = { CONFIG_PAGE };
