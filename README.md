# transpiler

A Lingo-to-TypeScript transpiler that turns Director/Shockwave bytecode into runnable browser
handlers and drives the LibreShockwave exporter to bit-exact parity against the C++ runtime
oracle.

`ExportTsProbe.cpp` is a read-only pass over a parsed Director movie: it loads the movie through the
LibreShockwave C++ pipeline, renders every frame, and emits a **self-contained TypeScript/PixiJS
project** you can `npm install && npm run dev`. The hand-written runtime under `runtime-template/`
re-implements the C++ render pipeline in TypeScript and is checked for bit-exact parity against
the C++ reference frames the exporter ships inside each export.

LibreShockwave (the parser/player library) is vendored as a git submodule at `external/LibreShockwave`.
LibreShockwave no longer builds the transpiler itself — this repo owns the exporter probe and its
build. The RenderProbe lives in LibreShockwave, not here.

## Prerequisites

- **CMake** ≥ 3.20
- A **C++20** compiler (GCC 11+, Clang 14+, MSVC 2022+)
- **zlib** development headers (for Afterburner-compressed movies)
- **Node.js 20+** and npm, to build/run the exported TypeScript project
- A **Director movie** to export: `.dir`, `.dcr`, `.cst`, or `.cct`. (Use `--self-test-inks` if you
  don't have one handy — see below.)

## Clone with submodules

```
git clone --recurse-submodules https://github.com/LibreShockwave/transpiler.git
```

If you already cloned without submodules:

```
git submodule update --init --recursive
```

> The `external/LibreShockwave` submodule is pinned to a LibreShockwave commit that has the
> TypeScript exporter target removed (it lives in this repo now). If a fresh `git submodule update`
> checks out a commit that still references the transpiler, the configure step will fail on a
> missing `apps/tools/ts/ExportTsProbe.cpp` — bump the submodule to a decoupled commit.

## Build the exporter

```
./build.sh
```

This configures a Release build in `./build` (with LibreShockwave's own tests skipped via
`-DBUILD_TESTING=OFF`) and builds the `libreshockwave_export_ts` target. The binary lands at:

```
build/bin/libreshockwave_export_ts
```

Other useful `build.sh` flags: `--debug`, `--build-dir <dir>`, `--jobs N`.

Or run CMake directly:

```
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build build --target libreshockwave_export_ts
```

## Launch / export a movie

```
build/bin/libreshockwave_export_ts <movie> [--out <dir>] [--frames <N>] [--no-preload-casts]
```

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | Output project directory (default: `exported-movie`) |
| `--frames <N>` | Export only the first N frames (default: all) |
| `--no-preload-casts` | Skip preloading external cast libraries |
| `--self-test-inks` | Emit synthetic frames covering every InkMode (no movie required) |

Example:

```
build/bin/libreshockwave_export_ts movie.dcr --out exported-movie
```

### Self-test mode (no movie fixture needed)

```
build/bin/libreshockwave_export_ts --self-test-inks --out export-ts-out
```

Emits 60 synthetic frames (20 inks × 3 variants) and the full project skeleton, so you can verify
the toolchain end-to-end without a real Director file.

## Run the exported project

The exporter writes a self-contained Vite + PixiJS project (skeleton from `export-template/`,
runtime copied from `runtime-template/src/` into `<out>/src/runtime/`, plus the movie data and C++
reference frames under `assets/`):

```
cd exported-movie
npm install
npm run dev        # vite dev server (opens the exported movie in the browser)
# or a production build:
npm run build && npm run preview
```

Verify the export:

```
npm run typecheck   # tsc --noEmit across runtime + emitted modules
npm test            # vitest run, including the self-contained differential harness
                    # (TS compositor vs. the C++ reference frames shipped under assets/)
```

## Repository layout

| Path | What it is |
| --- | --- |
| `ExportTsProbe.cpp` | The exporter probe (CMake target `libreshockwave_export_ts`). |
| `export-template/` | Vite/PixiJS project skeleton copied into each export. |
| `runtime-template/` | Hand-written TypeScript runtime — the source of truth copied to `<out>/src/runtime/`. |
| `external/LibreShockwave/` | Submodule: the Director parser/player library (`LibreShockwave::libreshockwave`). |
| `CMakeLists.txt` | Top-level build; compiles `ExportTsProbe.cpp` against the LibreShockwave library. |
| `build.sh` | Thin CMake wrapper that builds the exporter. |