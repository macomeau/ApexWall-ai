// Builds a genuine Windows ApexWall-Bridge.exe from any platform.
// 1. Downloads the Windows x64 node.exe (cached in /tmp) if not present
// 2. Copies it to public/downloads/ApexWall-Bridge.exe
// 3. Injects the SEA blob (sea-prep.blob) via postject
// Run via: npm run build:bridge-exe  (runs esbuild + sea-config first)
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const NODE_VERSION = "v24.20.0"; // must match the node that generated sea-prep.blob
const NODE_EXE_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
const CACHE_DIR = path.join(__dirname, "..", ".bridge-build-cache");
const NODE_EXE_CACHE = path.join(CACHE_DIR, `node-${NODE_VERSION}-win-x64.exe`);
const OUT_EXE = path.join(__dirname, "..", "public", "downloads", "ApexWall-Bridge.exe");
const BLOB = path.join(__dirname, "..", "sea-prep.blob");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (e) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
  });
}

(async () => {
  if (!fs.existsSync(BLOB)) {
    throw new Error("sea-prep.blob not found — run node --experimental-sea-config sea-config.json first");
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OUT_EXE), { recursive: true });

  if (!fs.existsSync(NODE_EXE_CACHE)) {
    console.log(`Downloading Windows node.exe ${NODE_VERSION}...`);
    await download(NODE_EXE_URL, NODE_EXE_CACHE);
    console.log("Downloaded.");
  } else {
    console.log("Using cached Windows node.exe.");
  }

  // postject ships as a dependency of @yao-pkg/pkg
  let postjectBin;
  const candidates = [
    "node_modules/postject/dist/cli.js",
    "node_modules/@yao-pkg/pkg/node_modules/postject/dist/cli.js",
  ];
  for (const c of candidates) {
    const p = path.join(__dirname, "..", c);
    if (fs.existsSync(p)) { postjectBin = p; break; }
  }
  if (!postjectBin) throw new Error("postject not found — npm install @yao-pkg/pkg");

  fs.copyFileSync(NODE_EXE_CACHE, OUT_EXE);
  console.log("Injecting SEA blob into", OUT_EXE);
  execSync(
    `node "${postjectBin}" "${OUT_EXE}" NODE_SEA_BLOB "${BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { stdio: "inherit" }
  );
  const sizeMB = (fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1);
  console.log(`Built ${OUT_EXE} (${sizeMB} MB)`);

  // koffi sidecar for iRacing shared memory (native addon can't live inside the SEA blob).
  // Layout next to the exe: koffi/index.js + koffi/build/koffi/win32_x64/koffi.node
  // koffi's own loader resolves the .node via its real __dirname, so we ship the
  // package's index.js + win32_x64 binary as-is.
  const koffiPkg = path.join(__dirname, "..", "node_modules", "koffi");
  const sidecarDir = path.join(path.dirname(OUT_EXE), "koffi");
  const sidecarBinDir = path.join(sidecarDir, "build", "koffi", "win32_x64");
  fs.mkdirSync(sidecarBinDir, { recursive: true });
  for (const f of ["index.js", "package.json"]) {
    const src = path.join(koffiPkg, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(sidecarDir, f));
  }
  const nodeBin = path.join(koffiPkg, "build", "koffi", "win32_x64", "koffi.node");
  if (!fs.existsSync(nodeBin)) throw new Error(`koffi win32_x64 binary not found at ${nodeBin}`);
  fs.copyFileSync(nodeBin, path.join(sidecarBinDir, "koffi.node"));
  console.log("koffi sidecar staged at", sidecarDir);
})().catch((e) => {
  console.error("build-bridge-exe failed:", e.message);
  process.exit(1);
});
