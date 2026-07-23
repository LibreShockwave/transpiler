#!/usr/bin/env node
// Launch the production build preview and open the browser at the Habbo r31
// embed URL (sw1..sw8 + venus.websocket.mode=wss), verbatim from GOAL.md.
//
//   npm run preview
//
// Env:
//   LS_PREVIEW_PORT   preferred port (default 4173; Vite falls back if taken)
//   LS_PREVIEW_HOST    bind host (default 127.0.0.1)
//   LS_PREVIEW_NO_OPEN set "1" to skip opening a browser
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exportDir = resolve(__dirname, "..");

// Embed params — verbatim from /opt/git/transpiler/GOAL.md.
// URLSearchParams encodes the ;/:/?/= inside each value, which is exactly what
// the player's externalparamValue reader expects (one query param per sw<n>).
const PARAMS = new URLSearchParams({
  sw1: "client.allow.cross.domain=1;client.notify.cross.domain=0",
  sw2: "connection.info.host=verysecret.classichabbo.com;connection.info.port=30100",
  sw3: "connection.info.mus.host=verysecret.classichabbo.com;connection.info.mus.port=38201",
  sw4: "site.url=http://127.0.0.1;url.prefix=http://127.0.0.1",
  sw5: "client.reload.url=http://127.0.0.1/client/beta?x=reauthenticate;client.fatal.error.url=http://127.0.0.1/clientutils?key=error",
  sw6: "client.connection.failed.url=http://127.0.0.1/clientutils?key=connection_failed;external.variables.txt=http://127.0.0.1/gamedata/external_variables.txt?",
  sw7: "external.texts.txt=http://127.0.0.1/gamedata/external_texts.txt?",
  sw8: "use.sso.ticket=1;sso.ticket=venus-sso-Quackster-359dd746-a591-44dc-a29b-5707165d18e9",
  "venus.websocket.mode": "wss",
});

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.status !== 0) {
    console.error(`\`${cmd} ${args.join(" ")}\` exited with ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

// Build first if dist/ is missing or stale.
const distIndex = resolve(exportDir, "dist", "index.html");
if (!existsSync(distIndex)) {
  console.log("dist/ not found — building (npm run build)…");
  run("npm", ["run", "build"], { cwd: exportDir });
}

const host = process.env.LS_PREVIEW_HOST || "127.0.0.1";
const port = process.env.LS_PREVIEW_PORT || "4173";
const child = spawn(
  "npx",
  ["vite", "preview", "--host", host, "--port", port, "--outDir", "dist"],
  { cwd: exportDir, stdio: ["ignore", "pipe", "inherit"] },
);

let base = null;
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!base) {
    const m = text.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (m) base = m[0];
  }
});

child.on("exit", (code) => process.exit(code ?? 0));

function openBrowser(url) {
  if (process.env.LS_PREVIEW_NO_OPEN === "1") return;
  try {
    if (process.platform === "darwin") spawnSync("open", [url]);
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { shell: true });
    else spawnSync("xdg-open", [url]);
    console.log(`Opening browser: ${url}`);
  } catch { /* non-fatal */ }
}

// Once Vite prints its local URL, build the full embed URL and open it.
const poll = setInterval(() => {
  if (base) {
    clearInterval(poll);
    const url = `${base}/?${PARAMS.toString()}`;
    console.log(`\nPlayer URL (with embed params):\n  ${url}\n`);
    openBrowser(url);
  }
}, 200);

// Safety: if Vite never prints a URL in 15s, just stop polling.
setTimeout(() => clearInterval(poll), 15000);