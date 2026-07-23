import { defineConfig, type Plugin } from "vite";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { zipSync } from "fflate";

// `vite build` only bundles what's imported. The player loads boot data by URL
// (`fetch("/manifest.json")`, `/score.json`, `/cast.json`) — copy those into dist/.
// The thousands of baked RGBA bitmaps (and sounds) are fetched individually at
// runtime, which means thousands of serial round-trips. Instead of copying the
// loose `assets/` tree, pack the runtime-relevant assets into a single
// `assets.zip` that the player fetches once and extracts in-memory (see
// src/runtime/AssetStore.ts). `assets/reference/` is the C++ parity-oracle frame
// set, never fetched by the TS runtime, so it is deliberately excluded.
function copyStaticData(): Plugin {
  return {
    name: "copy-static-data",
    apply: "build",
    closeBundle() {
      const root = process.cwd();
      const dist = resolve(root, "dist");
      for (const f of ["manifest.json", "score.json", "cast.json"]) {
        copyFileSync(resolve(root, f), resolve(dist, f));
      }

      // Build a { entryName: bytes } tree from the runtime-fetched asset dirs.
      // Entry names are the full path relative to the project root, matching the
      // verbatim asset strings stored in score.json/cast.json.
      const tree: Record<string, Uint8Array> = {};
      const walk = (absDir: string, prefix: string) => {
        for (const name of readdirSync(absDir)) {
          const abs = join(absDir, name);
          if (statSync(abs).isDirectory()) {
            walk(abs, `${prefix}/${name}`);
          } else {
            tree[`${prefix}/${name}`] = readFileSync(abs);
          }
        }
      };
      const bitmapsDir = resolve(root, "assets", "bitmaps");
      if (existsSync(bitmapsDir)) walk(bitmapsDir, "assets/bitmaps");
      const soundsDir = resolve(root, "assets", "sounds");
      if (existsSync(soundsDir)) walk(soundsDir, "assets/sounds");

      const zipped = zipSync(tree, { level: 6 });
      writeFileSync(resolve(dist, "assets.zip"), zipped);
      console.log(
        `[copy-static-data] wrote dist/assets.zip (${Object.keys(tree).length} entries, ` +
          `${(zipped.length / 1_048_576).toFixed(1)} MiB) + manifest/score/cast.json`,
      );
    },
  };
}

export default defineConfig({
  server: { host: "127.0.0.1" },
  plugins: [copyStaticData()],
});