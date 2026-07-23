#!/usr/bin/env node
// Playwright boot probe for the transpiled Habbo r31 client.
//
// Loads the exported TS player with the GOAL embed params (sw1..sw8 +
// venus.websocket.mode=wss), lets it boot, and programmatically verifies the
// cast-load milestone order from the NAMES of the sprites actually drawn:
//
//   Logo  ->  fuse_client  ->  hh_entry_au
//
// "Logo":           a sprite whose castMemberName is "Logo" is drawn.
// "fuse_client":    fuse_client.cct registers (host.registerCastlib fires) and at
//                    least one new named sprite owned by the fuse_client castlib appears.
// "hh_entry_au":    hh_entry_au.cct registers and at least one new named sprite owned
//                    by the hh_entry_au castlib appears.
//
// The probe is fully generic: it reads manifest.json to resolve the castlib slot
// numbers for "fuse_client" and "hh_entry_au" and asks the host which castlib owns
// each drawn sprite's member name. No Habbo-specific names are hard-coded.
//
// Requirements:
//   - The export must be built (build/bin/libreshockwave_export_ts ...).
//   - A Vite dev server must serve it. Set LS_PLAYER_URL to point at it, OR leave
//     it unset and the probe starts Vite itself from LS_EXPORT_DIR.
//   - Playwright + chromium must be resolvable (npm i -g playwright; playwright
//     install chromium), or install playwright inside LS_EXPORT_DIR.
//
// Env:
//   LS_EXPORT_DIR  export project dir (default: ./exported-habbo-r31)
//   LS_PLAYER_URL  player URL served by Vite (default: start Vite on a free port)
//   LS_BOOT_TIMEOUT_MS  max wait for all milestones (default: 30000)

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve playwright from (1) the export dir, (2) this script's vicinity,
// (3) the running process' node paths. Falls back with a clear message.
function loadPlaywright() {
  const exportDir = process.env.LS_EXPORT_DIR || resolve(__dirname, "..", "exported-habbo-r31");
  const candidates = [
    resolve(exportDir, "node_modules", "playwright"),
    resolve(__dirname, "node_modules", "playwright"),
  ];
  for (const p of candidates) {
    try { return require(p); } catch { /* try next */ }
  }
  try { return require("playwright"); } catch { /* fall through */ }
  throw new Error(
    "playwright not found. Run `npm i -g playwright && playwright install chromium`, " +
      "or `npm i playwright` inside the export dir (" + exportDir + ").",
  );
}

const exportDir = resolve(process.env.LS_EXPORT_DIR || resolve(__dirname, "..", "exported-habbo-r31"));
const manifest = JSON.parse(readFileSync(resolve(exportDir, "manifest.json"), "utf8"));
const castlibSlot = new Map();
for (const c of manifest.castlibs ?? []) castlibSlot.set(c.name, c.number);
const fuseSlot = castlibSlot.get("fuse_client");
const entrySlot = castlibSlot.get("hh_entry_au");
if (!fuseSlot || !entrySlot) {
  console.error("manifest is missing fuse_client or hh_entry_au castlib; got:", [...castlibSlot.keys()]);
  process.exit(2);
}

const PARAMS = {
  sw1: "client.allow.cross.domain=1;client.notify.cross.domain=0",
  sw2: "connection.info.host=verysecret.classichabbo.com;connection.info.port=30100",
  sw3: "connection.mus.host=verysecret.classichabbo.com;connection.mus.port=38201",
  sw4: "site.url=http://127.0.0.1;url.prefix=http://127.0.0.1",
  sw5: "client.reload.url=http://127.0.0.1/client/beta?x=reauthenticate;client.fatal.error.url=http://127.0.0.1/clientutils?key=error",
  sw6: "client.connection.failed.url=http://127.0.0.1/clientutils?key=connection_failed;external.variables.txt=http://127.0.0.1/gamedata/external_variables.txt?",
  sw7: "external.texts.txt=http://127.0.0.1/gamedata/external_texts.txt?",
  sw8: "use.sso.ticket=1;sso.ticket=venus-sso-Quackster-359dd746-a591-44dc-a29b-5707165d18e9",
  "venus.websocket.mode": "wss",
  // Vite serves stale modules across navigations; bust the cache per run.
  t: "" + Date.now(),
};
// NOTE: do NOT pass __lsPaused — `params.has("__lsPaused")` pauses the player
// regardless of value, and we need the RAF loop to drive the boot.

let vite = null;
async function ensurePlayerUrl() {
  if (process.env.LS_PLAYER_URL) return process.env.LS_PLAYER_URL;
  const port = 5180 + (Math.floor(Math.random() * 1000));
  vite = spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], {
    cwd: exportDir,
    stdio: "ignore",
  });
  // Wait for Vite to be ready (poll the URL).
  const url = `http://127.0.0.1:${port}/`;
  const { chromium } = loadPlaywright();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(url);
      if (res.ok) return url;
    } catch { /* not ready yet */ }
  }
  throw new Error("Vite dev server did not become ready at " + url);
}

function buildUrl(base) {
  const q = new URLSearchParams(PARAMS).toString();
  return base + (base.includes("?") ? "&" : "?") + q;
}

async function main() {
  const { chromium } = loadPlaywright();
  const base = await ensurePlayerUrl();
  const url = buildUrl(base);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("[console] " + m.text());
  });

  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !!window.__lsReady, { timeout: 20000 });

  // Wrap registerCastlib to capture the cast-load registration order. The boot
  // has already dispatched prepareMovie by the time __lsReady is true, so this
  // captures fuse_client / hh_entry_au (loaded after boot starts) reliably.
  await page.evaluate(() => {
    const host = window.__lsLingoHost;
    window.__lsCastlibLog = [];
    if (host && host.registerCastlib) {
      const orig = host.registerCastlib.bind(host);
      host.registerCastlib = (rec) => {
        window.__lsCastlibLog.push({ name: rec.name, number: rec.number });
        return orig(rec);
      };
    }
  });

  const timeout = Number(process.env.LS_BOOT_TIMEOUT_MS || 30000);
  const deadline = Date.now() + timeout;
  const milestones = { logo: null, fuse: null, entry: null };
  const seenNames = new Set();
  const registrationOrder = [];

  const sample = () => page.evaluate((slots) => {
    const host = window.__lsLingoHost;
    const sps = window.__lsSprites ? window.__lsSprites() : [];
    const names = sps.map((s) => s.castMemberName).filter((n) => n != null);
    const cast = (slot) => host && host.getCastlib ? host.getCastlib(slot) : null;
    const owns = (name, slot) => {
      const cl = cast(slot);
      return !!(cl && cl.membersByName && cl.membersByName.has(name));
    };
    return {
      hasLogo: names.includes("Logo"),
      fuseNames: names.filter((n) => owns(n, slots.fuse)),
      entryNames: names.filter((n) => owns(n, slots.entry)),
      fuseLoaded: !!(cast(slots.fuse) && cast(slots.fuse).loaded),
      entryLoaded: !!(cast(slots.entry) && cast(slots.entry).loaded),
      regs: window.__lsCastlibLog || [],
    };
  }, { fuse: fuseSlot, entry: entrySlot });

  // Record registration order from BOTH the registerCastlib wrapper (precise,
  // captures on-demand loads after __lsReady) and getCastlib().loaded transitions
  // (robust against any registration that fired before the wrapper was installed).
  const loadedSeen = new Set();
  const recordLoaded = (s, now) => {
    if (s.fuseLoaded && !loadedSeen.has("fuse_client")) { loadedSeen.add("fuse_client"); if (!registrationOrder.includes("fuse_client")) registrationOrder.push("fuse_client"); if (!milestones.fuseReg) milestones.fuseReg = now; }
    if (s.entryLoaded && !loadedSeen.has("hh_entry_au")) { loadedSeen.add("hh_entry_au"); if (!registrationOrder.includes("hh_entry_au")) registrationOrder.push("hh_entry_au"); if (!milestones.entryReg) milestones.entryReg = now; }
  };

  const snap = await sample();
  recordLoaded(snap, Date.now());
  for (const r of snap.regs) if (!registrationOrder.includes(r.name)) registrationOrder.push(r.name);

  while (Date.now() < deadline &&
         !(milestones.logo && milestones.fuse && milestones.entry)) {
    await page.waitForTimeout(100);
    const s = await sample();
    const now = Date.now();
    if (!milestones.logo && s.hasLogo) milestones.logo = now;
    for (const r of s.regs) if (!registrationOrder.includes(r.name)) registrationOrder.push(r.name);
    recordLoaded(s, now);
    if (!milestones.fuse && s.fuseNames.length > 0) milestones.fuse = now;
    if (!milestones.entry && s.entryNames.length > 0) milestones.entry = now;
  }

  const final = await sample();
  recordLoaded(final, Date.now());
  await browser.close();
  if (vite) vite.kill();

  // Verification.
  const order = [];
  if (milestones.logo) order.push("Logo");
  if (milestones.fuse) order.push("fuse_client");
  if (milestones.entry) order.push("hh_entry_au");

  const fuseRegistered = loadedSeen.has("fuse_client") || registrationOrder.includes("fuse_client");
  const entryRegistered = loadedSeen.has("hh_entry_au") || registrationOrder.includes("hh_entry_au");

  const report = {
    milestoneOrder: order,
    registrationOrder,
    fuseRegistered,
    entryRegistered,
    logoSeenAt: milestones.logo,
    fuseRegAt: milestones.fuseReg,
    fuseSpritesAt: milestones.fuse,
    entryRegAt: milestones.entryReg,
    entrySpritesAt: milestones.entry,
    fuseSpriteSample: final.fuseNames.slice(0, 6),
    entrySpriteSample: final.entryNames.slice(0, 12),
    pageErrors: errors.slice(0, 10),
  };

  // The GOAL ordering: Logo drawn -> fuse_client registers + fuse sprites appear
  // -> hh_entry_au registers + entry sprites appear. We require the sprite
  // milestones in order; registration must also have occurred. Registration and
  // first-sprite timestamps for the same castlib can interleave, but a castlib's
  // sprites cannot appear before it registers, so fuse <= entry on sprites
  // transitively implies the registration happened in time.
  const passed =
    milestones.logo && milestones.fuse && milestones.entry &&
    milestones.logo <= milestones.fuse && milestones.fuse <= milestones.entry &&
    fuseRegistered && entryRegistered;

  console.log("=== Boot probe result ===");
  console.log(JSON.stringify(report, null, 2));
  if (passed) {
    console.log("\nPASS: Logo -> fuse_client -> hh_entry_au (in order).");
    process.exit(0);
  } else {
    console.log("\nFAIL: milestone order not satisfied.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  if (vite) vite.kill();
  process.exit(1);
});