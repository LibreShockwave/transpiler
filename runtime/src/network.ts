import { type LingoValue, LingoPropList } from "./lingo-runtime.js";

let networkBaseUrl = "";
let nextNetId = 1;
const netResults = new Map<number, { done: number; error: string; text: string }>();
const preloadedCastFiles = new Set<string>();

export function setNetworkBaseUrl(url: string): void {
  networkBaseUrl = url;
}

export function setPreloadedCastFiles(files: readonly string[]): void {
  preloadedCastFiles.clear();
  for (const file of files) {
    preloadedCastFiles.add(file.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "");
  }
}

function requestedFileName(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? url;
  return withoutQuery.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
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
  const fullUrl = resolveUrl(url);
  const result = { done: 0, error: "OK", text: "" };
  netResults.set(id, result);
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
    return 1;
  }
  const id = Number(netId);
  const r = netResults.get(id);
  return r?.done ?? 1;
}

export function netError(netId?: LingoValue): string {
  if (netId === undefined) {
    return "OK";
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
  const fullUrl = resolveUrl(url);
  if (preloadedCastFiles.has(requestedFileName(fullUrl))) {
    // The exporter has already parsed this cast and emitted it as TypeScript. Director's
    // castload state machine still requires a completed stream with non-zero byte counts.
    // Completion is asynchronous even when the bytes are already cached: reporting done
    // in the initiating call stack can re-enter constructors before their owners publish
    // the newly created instance.
    const result = { done: 0, error: "OK", text: "\0" };
    netResults.set(id, result);
    globalThis.setTimeout(() => {
      result.done = 1;
    }, 0);
    return id;
  }
  // Pre-mark the entry as not-done so callers polling netDone(id) see 0 until the
  // XHR completes. The castload_instance_class.update body relies on
  // `netDone(pNetId) == 1` and `getStreamStatus(pNetId).bytesSoFar` to fire
  // DoneCurrentDownLoad — a stub that pre-marks the entry as done with empty text
  // would cause the castload loop to spin through all 8 retries without ever
  // issuing a real download.
  const result = { done: 0, error: "OK", text: "" };
  netResults.set(id, result);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", fullUrl, true);
  xhr.onload = () => {
    const contentType = xhr.getResponseHeader("content-type")?.toLowerCase() ?? "";
    const unexpectedHtml = requestedFileName(fullUrl).endsWith(".cct")
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
  // The Director builtin `importFileInto(tmember, pURL, options?)` is called by
  // `download_instance_class` and `httpcookie_instance_class` to "import a
  // downloaded file into a cast member". For `.cct` downloads this is the castlib
  // load path. In our runtime, every castlib is pre-registered at startup via
  // `lingoHost.registerCastlib`, so by the time `importFileInto` runs the target
  // cast library is already in the host's registry. We return 1 so the Lingo
  // caller's error path isn't taken; if the castlib is missing, log so the issue
  // is visible (the eager loader should have caught this).
  const tmember = args[0] as { token?: { castLib?: number | string } } | undefined;
  const pURL = args[1];
  const castLibNum = tmember && typeof tmember === "object" && tmember.token && typeof tmember.token === "object"
    ? Number((tmember.token as { castLib?: number | string }).castLib)
    : NaN;
  if (Number.isFinite(castLibNum) && castLibNum > 0) {
    try {
      const host = (globalThis as { __lsLingoHost?: { getCastlib?: (n: number) => unknown } }).__lsLingoHost;
      const registered = host?.getCastlib?.(castLibNum);
      if (!registered) {
        // eslint-disable-next-line no-console
        console.warn(`[runtime] importFileInto called for castLib ${castLibNum} (url=${pURL}) but no castlib is registered; the eager loader should have pre-registered this.`);
      }
    } catch {
      // Diagnostic best-effort; never let the check throw into the Lingo caller.
    }
  }
  return 1;
}
