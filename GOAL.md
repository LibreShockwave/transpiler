# Goal: First-Pass TypeScript Export with WASM Parity

## Objective

`libreshockwave_export_ts` must turn a Director movie into a self-contained TypeScript project that typechecks, builds, starts, and runs correctly on its first clean export. Generated output must never require hand-editing.

The immediate parity target is the Habbo Hotel client used by the Quackster harness. Once the exported project renders, it must reach the same Hotel Navigator / Public Spaces state as the LibreShockwave C++ WASM player, with matching content, layout, assets, text, and interactions.

## Source of truth

- `../LibreShockwave/` is the semantic and rendering oracle. Runtime behavior must be faithfully ported from its C++ Director/Shockwave implementation.
- `/runtime/` is the only authored TypeScript runtime and export-project template source in this repository.
- `runtime-template/` and `export-template/` must not exist or be referenced.
- `ExportTsProbe.cpp` and its build configuration may be changed once to consume `/runtime/` exclusively. After that routing consolidation, all runtime behavior changes belong under `/runtime/`.
- Generated transpiler output is an immutable verification artifact. Never patch generated scripts, generated `main.ts`, or any other file in an export directory. Fix the source runtime and regenerate into a clean directory.

## Export contract

A clean invocation such as:

```bash
./build/bin/libreshockwave_export_ts \
  /var/www/html/dcr/r31_20090312_0433_13751_b40895fb6101dbe96dc7b9d6477eeeb4/habbo.dcr \
  --out exported-habbo
```

must emit everything needed to run the movie:

- A complete Vite/TypeScript project sourced from `/runtime/`.
- Runnable TypeScript produced from every required Lingo handler.
- Movie, score, cast, palette, bitmap, text, field, sound, and other required member data.
- All required sibling `.cct` cast libraries, including their scripts and renderable assets.
- Browser runtime support for Director semantics used by the movie, including script instances, ancestor and property lookup, dynamic cast slots, member access, network operations, input events, and frame rendering.
- Host-configurable Shockwave parameters such as `sw1` through `sw9`; these must not be hard-coded into generated Lingo scripts.

The resulting project must pass, without any manual fixes:

```bash
cd exported-habbo
npm install
npm run typecheck
npm run build
npm run dev
```

## Parity target

The primary oracle is:

```text
http://localhost:3000/venus-quackster-harness
```

The repository references are:

- `/screenshots/target.png`
- `/screenshots/oracle_habbo.png`
- `/screenshots/wasm_60s.png`

The exported project must reach the same functional and visual state:

- The Habbo Hotel scene is rendered with the correct assets and composition.
- The bottom toolbar and Quackster user content are present.
- The Hotel Navigator is open to Public Spaces.
- Room categories, room names, occupancy text, controls, and selected-room details are present and usable.
- Mouse and keyboard interaction required to operate the Navigator works.

Screenshot comparison is a regression aid, not a substitute for working behavior. Minor pixel differences caused by browser text rasterization, renderer rounding, or live network timing are acceptable only when the displayed state, content, geometry, assets, and interactions remain equivalent to the WASM player.

## Implementation rules

1. **Edit the source, never the export.** Diagnose generated output read-only, make the real fix under `/runtime/`, then create a fresh export.
2. **Use one runtime tree.** The export probe must read only `/runtime/`; do not recreate parallel template or runtime copies.
3. **Port real semantics.** Implement behavior from `../LibreShockwave/`. Do not use Habbo-specific branches, fake server data, hard-coded return values, silent no-op stubs, or visual shortcuts.
4. **Keep the exporter generic.** A fix required by Habbo must improve equivalent Director behavior for other movies.
5. **Emit working TypeScript first time.** Missing handlers, anonymous handler names, invalid imports, type errors, startup exceptions, and required post-export patches are failures.
6. **Keep failures visible.** Unsupported semantics should fail with actionable context during development rather than silently producing incorrect output.
7. **Remove diagnostics.** Temporary logging and probes may be used while investigating, but must be removed before a change is considered complete.
8. **Use headless automation.** Browser verification must use headless Playwright, Selenium, or an equivalent harness.
9. **Avoid machine-temporary dependencies.** Long-lived code, documentation, and tests must not depend on `/tmp` or on a previously hand-modified export.

## Verification

Every completed change must run the checks appropriate to its scope:

1. Build `libreshockwave_export_ts`.
2. Run the `/runtime/` typecheck and unit tests.
3. Export Habbo into a new, empty directory.
4. Install dependencies and run the exported project's typecheck and production build.
5. Start the exported project and exercise it with a headless browser.
6. Confirm there are no uncaught browser errors, unresolved handlers, missing required assets, or manual output changes.
7. Capture the rendered state and compare it side by side with the Quackster WASM harness and `/screenshots/`.

The goal is complete only when a clean, untouched transpiler output reaches the Hotel Navigator / Public Spaces view with functional and visual parity to the WASM player.
