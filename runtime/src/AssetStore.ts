// Asset byte store.
//
// The player loads thousands of baked RGBA bitmaps (and sounds). In dev the Vite
// server serves them as loose files; in a prod build the `copyStaticData` Vite
// plugin packs them all into a single `assets.zip` so boot is one fetch + an
// in-memory extract instead of thousands of serial round-trips. `AssetStore`
// abstracts both behind `getBytes(path)`, keyed by the verbatim asset path
// string stored in score.json / cast.json (e.g. "assets/bitmaps/<hash>_wNN_hNN.rgba").

/**
 * A provider of raw asset bytes keyed by the full relative asset path (the same
 * string the runtime uses as the `bitmaps` Map key and as a fetch URL in dev).
 */
export interface AssetStore {
  /** Resolve an asset to its raw bytes. Throws/rejects if the asset is missing. */
  getBytes(path: string): Promise<Uint8Array>;
  /** Optional: drop the cached raw bytes for a path (e.g. after it has been decoded). */
  release?(path: string): void;
}

/**
 * Dev store: fetches each asset as a loose file from the server root (the Vite
 * dev server serves the project's `assets/` tree). Mirrors the previous
 * `fetchBytes(\`/${asset}\`)` behaviour exactly (root-anchored, ignores
 * `__lsBaseUrl` — bitmaps are always served from the site root).
 */
export class HttpAssetStore implements AssetStore {
  async getBytes(path: string): Promise<Uint8Array> {
    const res = await fetch(`/${path}`);
    if (!res.ok) throw new Error(`AssetStore: failed to load /${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/**
 * Prod store: all assets have already been extracted from `assets.zip` into the
 * `entries` Map. `getBytes` is a synchronous Map lookup (no network); a miss
 * throws, which surfaces as a page error if a JSON-referenced asset is absent
 * from the zip.
 */
export class ZipAssetStore implements AssetStore {
  private readonly entries: Map<string, Uint8Array>;
  constructor(entries: Map<string, Uint8Array>) {
    this.entries = entries;
  }
  async getBytes(path: string): Promise<Uint8Array> {
    const bytes = this.entries.get(path);
    if (!bytes) throw new Error(`AssetStore: asset not in zip: ${path}`);
    return bytes;
  }
  release(path: string): void {
    this.entries.delete(path);
  }
}

/**
 * Fetch `assets.zip` once and extract every entry in a Web Worker (fflate's
 * async `unzip` offloads inflate off the main thread). Returns a `ZipAssetStore`
 * keyed by the zip entry names, which the build plugin writes as the full
 * relative asset paths.
 */
export async function loadZipAssetStore(zipUrl = "/assets.zip"): Promise<ZipAssetStore> {
  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`AssetStore: failed to load ${zipUrl}: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  // Dynamic import so Vite splits fflate into its own chunk loaded only in prod.
  const { unzip } = await import("fflate");
  const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, (err, out) => (err ? reject(err) : resolve(out as Record<string, Uint8Array>)));
  });
  const entries = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(unzipped)) {
    entries.set(name, bytes);
  }
  return new ZipAssetStore(entries);
}