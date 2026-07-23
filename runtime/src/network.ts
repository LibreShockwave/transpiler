import { type LingoValue, LingoPropList } from "./lingo-runtime.js";

/**
 * A reference to an emitted castlib TS/JS module, keyed by the Director cast
 * filename the Lingo movie requests (`foo.cct`, `foo.cst`, ...). The exporter
 * emits one such module per cast and lists it in `manifest.castlibs`; the host
 * project builds the map at startup and registers a `CastlibRegistrar` that
 * imports the module and calls `host.registerCastlib(...)`.
 */
export interface CastlibModuleRef {
  /** URL/import specifier of the emitted TS module, e.g. `/src/castlibs/castlib_3_foo.ts`. */
  file: string;
  /** Director cast library number. */
  number: number;
  /** Cast library name (without extension). */
  name: string;
  /** Original Director filename, e.g. `foo.cct`. */
  fileName: string;
}

/** A registrar that imports an emitted castlib module and registers it on the host. */
export type CastlibRegistrar = (ref: CastlibModuleRef) => Promise<void> | void;

let networkBaseUrl = "";
let nextNetId = 1;
let lastNetId = 0;
const netResults = new Map<number, { done: number; error: string; text: string }>();
const netResultsByUrl = new Map<string, { done: number; error: string; text: string }>();

/** fileName (lowercased, bare) -> emitted castlib module reference. */
const castlibModuleMap = new Map<string, CastlibModuleRef>();
let castlibRegistrar: CastlibRegistrar | null = null;

/** Cast/container extensions that resolve to an emitted castlib TS module. */
const CAST_EXTENSIONS = [".cct", ".cst", ".dcr", ".dir", ".dxr"];

export function setNetworkBaseUrl(url: string): void {
  networkBaseUrl = url;
}

/**
 * Populate the fileName -> emitted-castlib-module map. Each ref is indexed under
 * its bare `fileName` and under `${name}.cct` / `${name}.cst` so the various
 * naming variants a movie may request all resolve to the same module.
 */
export function setCastlibModuleMap(refs: readonly CastlibModuleRef[]): void {
  castlibModuleMap.clear();
  for (const ref of refs) {
    const byFileName = requestedFileName(ref.fileName);
    if (byFileName) castlibModuleMap.set(byFileName, ref);
    castlibModuleMap.set(`${ref.name.toLowerCase()}.cct`, ref);
    castlibModuleMap.set(`${ref.name.toLowerCase()}.cst`, ref);
  }
}

export function setCastlibRegistrar(fn: CastlibRegistrar | null): void {
  castlibRegistrar = fn;
}

function requestedFileName(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? url;
  return withoutQuery.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isCastFile(fileName: string): boolean {
  return CAST_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

function resolveUrl(url: LingoValue): string {
  const s = String(url ?? "");
  if (s.startsWith("http://") || s.startsWith("https://")) {
    return s;
  }
  return networkBaseUrl + s;
}

export function getNetText(url: LingoValue): number {
  const id = nextNetId++;
  lastNetId = id;
  const fullUrl = resolveUrl(url);
  const result = { done: 0, error: "OK", text: "" };
  netResults.set(id, result);
  netResultsByUrl.set(fullUrl, result);
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", fullUrl, true);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        result.text = xhr.responseText;
        result.error = "OK";
      } else {
        result.text = "";
        result.error = String(xhr.status);
      }
      result.done = 1;
    };
    xhr.onerror = () => {
      result.text = "";
      result.error = "network error";
      result.done = 1;
    };
    xhr.onabort = () => {
      result.text = "";
      result.error = "aborted";
      result.done = 1;
    };
    xhr.ontimeout = () => {
      result.text = "";
      result.error = "timeout";
      result.done = 1;
    };
    xhr.send();
  } catch (e) {
    result.text = "";
    result.error = String(e);
    result.done = 1;
  }
  return id;
}

export function netDone(netId?: LingoValue): number {
  if (netId === undefined) {
    // LibreShockwave semantics: `netDone()` (no arg) reflects the most recently
    // started net task. With no current task it resolves to done (1); while the
    // last task is still in progress it is 0; once it completes (or fails) it is
    // 1 again. The Habbo boot's `init` score script polls this to gate
    // `initializeAndRun()` behind `preloadNetThing(fuse_client.cct)`.
    const last = lastNetId > 0 ? netResults.get(lastNetId) : undefined;
    return last && !last.done ? 0 : 1;
  }
  const id = Number(netId);
  const r = netResults.get(id);
  return r?.done ?? 1;
}

export function netError(netId?: LingoValue): string {
  if (netId === undefined) {
    const last = lastNetId > 0 ? netResults.get(lastNetId) : undefined;
    return last?.error ?? "OK";
  }
  const id = Number(netId);
  const r = netResults.get(id);
  return r?.error ?? "OK";
}

export function netTextResult(netId: LingoValue): string {
  const id = Number(netId);
  const r = netResults.get(id);
  return r?.text ?? "";
}

export function getStreamStatus(netId: LingoValue): LingoValue {
  const id = Number(netId);
  const r = netResults.get(id);
  if (!r) {
    return 0;
  }
  // Director's getStreamStatus returns a property list, so callers can probe fields with
  // `tStreamStatus[#bytesSoFar]` etc. and `listp(tStreamStatus)` is true.
  return new LingoPropList([
    "state", r.done ? 4 : 1,
    "bytesSoFar", r.text.length,
    "bytesTotal", r.text.length,
    "error", r.error,
    "errorCode", r.error === "OK" ? 0 : 1,
  ]) as unknown as LingoValue;
}

export function preloadNetThing(url: LingoValue): number {
  const id = nextNetId++;
  lastNetId = id;
  const fullUrl = resolveUrl(url);
  const fileName = requestedFileName(fullUrl);
  const result: { done: number; error: string; text: string } = { done: 0, error: "OK", text: "" };
  netResults.set(id, result);

  // A `.cct`/`.cst`/`.dcr`/`.dir`/`.dxr` request resolves to the transpiled
  // castlib TS/JS module the exporter emitted for that cast (mirroring how the
  // LibreShockwave C++ runtime feeds downloaded cast bytes into `DirectorFile::load`,
  // but with a transpiled module instead of binary bytes). Dynamic-import the
  // module, register the castlib on the host via the registrar, then complete
  // the Director net stream with a non-zero byte count so the Lingo castload
  // state machine (`netDone` / `getStreamStatus`) reports a finished stream.
  if (isCastFile(fileName)) {
    const ref = castlibModuleMap.get(fileName);
    if (ref && castlibRegistrar) {
      // Completion is asynchronous even though the module is local: reporting
      // done in the initiating call stack can re-enter constructors before their
      // owners publish the newly created instance (Director's castload polls
      // `netDone(id)` across frames).
      const finish = (error: string) => {
        result.error = error;
        result.text = error === "OK" ? "\0" : "";
        result.done = 1;
      };
      Promise.resolve()
        .then(() => castlibRegistrar!(ref))
        .then(() => finish("OK"))
        .catch((e) => {
          console.warn(`[runtime] castlib module load failed for ${fileName}`, e);
          finish("network error");
        });
      return id;
    }
    // No emitted module for this cast. Fall through to a real fetch so a
    // genuinely-untranspiled cast produces a visible Director net error rather
    // than a silent success.
    console.warn(`[runtime] no transpiled castlib module for ${fileName}; attempting direct fetch`);
  }

  // Pre-mark the entry as not-done so callers polling netDone(id) see 0 until the
  // XHR completes. The castload_instance_class.update body relies on
  // `netDone(pNetId) == 1` and `getStreamStatus(pNetId).bytesSoFar` to fire
  // DoneCurrentDownLoad — a stub that pre-marks the entry as done with empty text
  // would cause the castload loop to spin through all 8 retries without ever
  // issuing a real download.
  const xhr = new XMLHttpRequest();
  xhr.open("GET", fullUrl, true);
  xhr.onload = () => {
    const contentType = xhr.getResponseHeader("content-type")?.toLowerCase() ?? "";
    const unexpectedHtml = isCastFile(fileName)
      && (contentType.includes("text/html") || /^\s*<!doctype html/i.test(xhr.responseText));
    if (xhr.status >= 200 && xhr.status < 300 && !unexpectedHtml) {
      result.text = xhr.responseText;
      result.error = "OK";
    } else {
      result.text = "";
      result.error = unexpectedHtml ? "4149" : String(xhr.status);
    }
    result.done = 1;
  };
  xhr.onerror = () => {
    result.text = "";
    result.error = "network error";
    result.done = 1;
  };
  xhr.onabort = () => {
    result.text = "";
    result.error = "aborted";
    result.done = 1;
  };
  xhr.ontimeout = () => {
    result.text = "";
    result.error = "timeout";
    result.done = 1;
  };
  xhr.send();
  return id;
}

export function importFileInto(...args: LingoValue[]): number {
  // Director's `importFileInto(tmember, pURL, options?)` "imports a downloaded
  // file into a cast member". For a cast download the target castlib is already
  // registered (via the on-demand castlib module path above) by the time this
  // runs; for a text/asset download we copy the fetched text into the member.
  const tmember = args[0] as { token?: { castLib?: number | string; id?: number | string } } | undefined;
  const pURL = args[1];
  const fullUrl = resolveUrl(pURL);
  const castLibNum = tmember && typeof tmember === "object" && tmember.token && typeof tmember.token === "object"
    ? Number((tmember.token as { castLib?: number | string }).castLib)
    : NaN;
  if (Number.isFinite(castLibNum) && castLibNum > 0) {
    try {
      const host = (globalThis as { __lsLingoHost?: { getCastlib?: (n: number) => unknown } }).__lsLingoHost;
      const registered = host?.getCastlib?.(castLibNum);
      if (!registered) {
        console.warn(`[runtime] importFileInto: castLib ${castLibNum} not registered (url=${pURL}).`);
      }
    } catch {
      // Diagnostic best-effort; never let the check throw into the Lingo caller.
    }
  }
  const downloaded = netResultsByUrl.get(fullUrl);
  if (downloaded?.done && downloaded.error === "OK" && tmember && typeof tmember === "object" && tmember.token) {
    const host = (globalThis as {
      __lsLingoHost?: { setMemberProp?: (token: { id: number | string; castLib?: number | string }, prop: string, value: LingoValue) => void }
    }).__lsLingoHost;
    host?.setMemberProp?.(tmember.token as { id: number | string; castLib?: number | string }, "text", downloaded.text);
  }
  return 1;
}