#!/usr/bin/env node
// Oracle cross-reference probe.
//
// Loads the WASM LibreShockwave oracle (external/LibreShockwave/web/test-harness.html)
// in a real browser, lets it boot the Habbo r31 movie against the local web server +
// the live Venus WebSocket, and records the cast-load order the *oracle* performs.
// It then asserts that order matches the TS boot probe's milestone ordering:
//
//   fuse_client  before  hh_entry_au
//
// (The TS probe additionally pins "Logo drawn before fuse_client", which is a
// sprite-rendering signal the oracle does not expose in the same form; the
// oracle cross-reference covers the cast-load ordering, which is the part the
// two runtimes share.)
//
// The oracle's cast-load order is derived two independent ways and cross-checked:
//   (1) HTTP request order for cast files (.cct/.cst) captured at the network
//       layer — this is the order the QueuedNetProvider actually fetches casts.
//   (2) __venusHarness.debug entries that name a cast file — the Lingo/log path.
// Both must agree that fuse_client precedes hh_entry_au.
//
// Env:
//   LS_ORACLE_DIR   dir containing test-harness.html + libreshockwave-cpp-player.js
//                   (default: ../external/LibreShockwave/web)
//   LS_ORACLE_URL   URL of test-harness.html (default: start a static server)
//   LS_ORACLE_TIMEOUT_MS  max boot wait (default: 40000)

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPlaywright() {
  const candidates = [
    resolve(__dirname, "..", "exported-habbo-r31", "node_modules", "playwright"),
    resolve(__dirname, "..", "node_modules", "playwright"),
    resolve(__dirname, "node_modules", "playwright"),
  ];
  for (const p of candidates) { try { return require(p); } catch {} }
  try { return require("playwright"); } catch {}
  throw new Error("playwright not found (npm i -g playwright; playwright install chromium).");
}

const oracleDir = resolve(process.env.LS_ORACLE_DIR || "/opt/git/LibreShockwave/cmake-build-wasm/cpp/wasm-dist");
const CAST_RE = /\.(cct|cst|dcr|dir|dxr)(?:\?|$)/i;
const TARGETS = ["fuse_client", "hh_entry_au"];
const wantsCast = (url) => {
  const file = url.split(/[?#]/, 1)[0].split("/").pop() || "";
  return TARGETS.some((t) => file.toLowerCase().startsWith(t.toLowerCase()) && CAST_RE.test(url));
};
const castName = (url) => {
  const file = (url.split(/[?#]/, 1)[0].split("/").pop() || "").toLowerCase();
  return TARGETS.find((t) => file.startsWith(t.toLowerCase())) || null;
};

let server = null;
async function ensureOracleUrl() {
  if (process.env.LS_ORACLE_URL) return process.env.LS_ORACLE_URL;
  const port = 5182;
  server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: oracleDir, stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}/test-harness.html`;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const res = await fetch(url); if (res.ok) return url; } catch {}
  }
  throw new Error("oracle static server did not become ready at " + url);
}

async function main() {
  const { chromium } = loadPlaywright();
  const base = await ensureOracleUrl();
  // debug=1 enables debug-message polling so __venusHarness.debug is populated.
  const url = base + (base.includes("?") ? "&" : "?") + "debug=1";

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const castFetchOrder = []; // cast name in HTTP-request order
  page.on("request", (req) => {
    const u = req.url();
    const c = castName(u);
    if (c && !castFetchOrder.includes(c)) castFetchOrder.push(c);
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });

  await page.goto(url, { waitUntil: "load", timeout: 30000 });

  const timeout = Number(process.env.LS_ORACLE_TIMEOUT_MS || 40000);
  const deadline = Date.now() + timeout;

  // Wait until both target casts have been fetched OR the deadline.
  await page.waitForFunction(
    () => !!(window.__venusHarness && window.__venusHarness.frames && window.__venusHarness.frames.length > 0),
    { timeout: 20000 },
  ).catch(() => {});

  while (Date.now() < deadline && castFetchOrder.length < TARGETS.length) {
    await page.waitForTimeout(250);
  }
  // Let it run a touch longer so debug log fills in for cross-check.
  await page.waitForTimeout(2000);

  const harness = await page.evaluate(() => {
    const h = window.__venusHarness || null;
    if (!h) return null;
    return {
      frameCount: (h.frames || []).length,
      firstFrame: (h.frames || [])[0] || null,
      lastFrame: (h.frames || [])[(h.frames || []).length - 1] || null,
      socketCount: (h.sockets || []).length,
      debugCastLines: (h.debug || [])
        .filter((e) => /fuse_client|hh_entry_au/i.test(String(e.message || "")))
        .map((e) => ({ time: e.time, kind: e.kind, message: String(e.message).slice(0, 160) })),
      errors: (h.errors || []).slice(0, 10),
    };
  });

  await browser.close();
  if (server) server.kill();

  // Derive debug-log cast order (first mention of each target).
  const debugCastOrder = [];
  for (const line of harness?.debugCastLines || []) {
    for (const t of TARGETS) {
      if (new RegExp(t, "i").test(line.message) && !debugCastOrder.includes(t)) {
        debugCastOrder.push(t);
      }
    }
  }

  const httpHas = TARGETS.map((t) => castFetchOrder.includes(t));
  const httpOrderOk = castFetchOrder.includes("fuse_client") && castFetchOrder.includes("hh_entry_au")
    && castFetchOrder.indexOf("fuse_client") < castFetchOrder.indexOf("hh_entry_au");
  const debugOrderOk = debugCastOrder.includes("fuse_client") && debugCastOrder.includes("hh_entry_au")
    && debugCastOrder.indexOf("fuse_client") < debugCastOrder.indexOf("hh_entry_au");

  const report = {
    httpCastFetchOrder: castFetchOrder,
    debugCastOrder,
    httpOrderOk,
    debugOrderOk,
    oracleFrameCount: harness?.frameCount ?? 0,
    oracleSocketCount: harness?.socketCount ?? 0,
    oracleErrors: harness?.errors ?? [],
    pageErrors: errors.slice(0, 10),
    debugCastSample: (harness?.debugCastLines || []).slice(0, 12),
  };

  console.log("=== Oracle cross-reference result ===");
  console.log(JSON.stringify(report, null, 2));

  // Pass requires the oracle actually booted (frames rendered) and produced the
  // fuse_client -> hh_entry_au cast-load order via HTTP, cross-confirmed by the
  // debug log when the debug channel named both casts.
  const booted = (harness?.frameCount ?? 0) > 0;
  const passed = booted && httpOrderOk && (debugCastOrder.length < 2 || debugOrderOk);

  if (passed) {
    console.log("\nPASS: oracle cast-load order fuse_client -> hh_entry_au matches TS probe.");
    process.exit(0);
  } else {
    console.log("\nFAIL: oracle cast-load order does not match TS probe ordering.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("oracle probe error:", e);
  if (server) server.kill();
  process.exit(1);
});