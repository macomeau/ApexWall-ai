// koffi loader shim for the SEA-bundled bridge.
// In script mode (.bat): loads koffi from node_modules normally.
// In SEA mode (.exe): koffi can't be bundled (native addon), so we load it
// from a sidecar folder shipped next to the exe: <exeDir>/koffi/
const path = require("path");
const fs = require("fs");

function loadKoffi() {
  // 1. Normal node_modules resolution (script mode, dev)
  try {
    return eval("require")("koffi");
  } catch {}

  // 2. Sidecar next to the executable (SEA mode)
  const candidates = [
    path.join(path.dirname(process.execPath), "koffi", "index.js"),
    path.join(process.cwd(), "koffi", "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        return eval("require")(c);
      } catch (e) {
        throw new Error(`koffi sidecar found at ${c} but failed to load: ${e.message}`);
      }
    }
  }
  throw new Error(
    "koffi not found — iRacing shared memory unavailable. " +
    "Run the .bat script version (npm install @emiliosp/node-iracing-sdk) instead."
  );
}

module.exports = loadKoffi();
module.exports.default = module.exports;
