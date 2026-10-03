// koffi loader shim for the SEA-bundled bridge.
// In script mode: loads koffi from node_modules normally.
// In SEA mode (.exe): koffi can't be bundled (native addon), so we load it
// from a sidecar folder shipped next to the exe: <exeDir>/koffi/
//
// NOTE: This file is aliased in via esbuild. It must avoid patterns that
// break under bundling — use createRequire (Node built-in) instead of
// eval("require"), which resolves to esbuild's shim in bundled output.
const path = require("path");
const fs = require("fs");
const { createRequire } = require("module");

function tryLoadSidecar(indexPath) {
  // createRequire anchored at the sidecar's package.json gives us a require
  // that resolves relative to the real on-disk koffi package, so its own
  // __dirname-based .node lookup works.
  const anchor = path.join(path.dirname(indexPath), "package.json");
  const req = createRequire(fs.existsSync(anchor) ? anchor : indexPath);
  return req(indexPath);
}

function loadKoffi() {
  const tried = [];

  // 1. Sidecar next to the executable (SEA .exe mode) — check first, since
  //    a bundled eval-require("koffi") can never succeed in SEA.
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, "koffi", "index.js"),
    path.join(process.cwd(), "koffi", "index.js"),
  ];
  for (const c of candidates) {
    tried.push(c);
    if (fs.existsSync(c)) {
      try {
        return tryLoadSidecar(c);
      } catch (e) {
        throw new Error(`koffi sidecar found at ${c} but failed to load: ${e.message}`);
      }
    }
  }

  // 2. Normal node_modules resolution (script / dev mode)
  try {
    return createRequire(__filename)("koffi");
  } catch (e) {
    tried.push(`node_modules:koffi (${e.message})`);
  }

  throw new Error(
    `koffi not found — iRacing shared memory unavailable. Tried: ${tried.join("; ")}`
  );
}

let koffi;
try {
  koffi = loadKoffi();
} catch (e) {
  // Don't throw at import time: let the bridge's try/catch around the SDK
  // require report it cleanly, and stash the reason for diagnostics.
  koffi = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "__koffiLoadError") return e.message;
        throw e;
      },
    }
  );
}

module.exports = koffi;
module.exports.default = koffi;
