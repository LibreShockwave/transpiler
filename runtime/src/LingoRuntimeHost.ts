// TypeScript Lingo host implementation.
//
// This wires the transpiled Lingo handlers (lingo-runtime.ts accessors + callBuiltin) to the live
// exported movie state: the score JSON, the current FrameSnapshot, cast members, and globals.
// It is intentionally minimal for the Stage 7 first slice; unimplemented surfaces throw
// LingoNotImplemented so failures are loud rather than silently wrong.

import type { Bitmap } from "./Bitmap.js";
import { buildSprite, coerceSpriteType, type BitmapLoader, type ScoreJson, type ScoreSpriteJson } from "./ScoreData.js";
import { inkModeFromCode } from "./InkMode.js";
import type { FrameSnapshot, RenderSprite } from "./FrameSnapshot.js";
import type { ScorePlayer } from "./ScorePlayer.js";
import {
  LingoNotImplemented,
  LingoList,
  LingoPropList,
  LingoCastLibProxy,
  LingoMemberProxy,
  LingoSpriteProxy,
  LingoImage,
  type LingoHost,
  type LingoMe,
  type LingoSymbol,
  type LingoValue,
  isSymbol,
  symbol,
  getItemDelimiter,
  setItemDelimiter,
  lingoKeyToString,
  dispatchValueBuiltin,
  SUPPORTED_LINGO_BUILTINS,
  LINGO_VOID_SENTINEL,
  LINGO_VOID,
  meProp,
  setMeProp,
  pushScriptContext,
  popScriptContext,
  currentScriptContext,
} from "./lingo-runtime.js";
import {
  getNetText,
  netDone,
  netError,
  netTextResult,
  getStreamStatus,
  preloadNetThing,
} from "./network.js";

/** Sentinel allowing a global handler to legitimately return VOID. */
export const LINGO_HANDLER_NOT_FOUND = Object.freeze({
  __lingoHandlerNotFound: true,
}) as unknown as LingoValue;

/** A cast member token used by `member()` and `sprite(...).member`. */
export interface MemberToken {
  readonly id: number | string;
  readonly castLib?: number | string;
}

export function isMemberToken(value: LingoValue): value is MemberToken {
  return typeof value === "object" && value !== null && "id" in value &&
    (typeof (value as MemberToken).id === "number" ||
     typeof (value as MemberToken).id === "string");
}

/** Convert platform line endings to Director's internal Mac-style RETURN (\r). */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r");
}

/** Create a default Director player object used by global `_player`. */
function makePlayerObject(): LingoValue {
  const player = new LingoPropList();
  player.add("windowList", new LingoList([]));
  player.add("traceScript", 0);
  player.add("traceLogFile", "");
  player.add("activeWindow", { name: "stage" } as LingoValue);
  player.add("runMode", "Plugin");
  player.add("externalParams", new LingoPropList());
  return new Proxy(player, {
    get(target, prop) {
      if (typeof prop === "string") {
        if (prop in target) {
          return (target as unknown as Record<string, unknown>)[prop];
        }
        const val = target.get(prop);
        if (val !== undefined) {
          return val;
        }
        if (prop === "count" || prop === "length") {
          return target.count;
        }
      }
      return undefined;
    },
    set(target, prop, value) {
      if (typeof prop === "string") {
        target.add(prop, value as LingoValue);
      }
      return true;
    },
  }) as unknown as LingoValue;
}

/** Create a default Director movie object used by global `_movie`. */
function makeMovieObject(): LingoValue {
  const movie = new LingoPropList();
  movie.add("traceScript", 0);
  movie.add("name", "habbo");
  return new Proxy(movie, {
    get(target, prop) {
      if (typeof prop === "string") {
        if (prop in target) {
          return (target as unknown as Record<string, unknown>)[prop];
        }
        const val = target.get(prop);
        if (val !== undefined) {
          return val;
        }
        if (prop === "count" || prop === "length") {
          return target.count;
        }
      }
      return undefined;
    },
    set(target, prop, value) {
      if (typeof prop === "string") {
        target.add(prop, value as LingoValue);
      }
      return true;
    },
  }) as unknown as LingoValue;
}

export interface LingoRuntimeHostOptions {
  score: ScoreJson;
  loadBitmap: BitmapLoader;
  player: ScorePlayer;
  audio?: { play(name: string): void };
  cast?: import("./ScoreData.js").CastJson;
}

/** Mutable host state that survives across frames. */
interface HostState {
  globals: Map<string, LingoValue>;
  frameIndexOverride: number | null;
  pendingSound: string | null;
  memberTextCache: Map<string, LingoValue>;
  randomSeed: number;
  randomState: number;
  startTime: number;
  moviePath: string;
  mouseH: number;
  mouseV: number;
  mouseDown: boolean;
  key: string;
  keyCode: number;
  shiftDown: boolean;
}

interface DynamicMember {
  id: number;
  castLib: number;
  type: string;
  name: string;
  text: string;
}

/** A cast library loaded into the runtime. Each `.cct` file the exporter emits becomes
 * one of these — registered at startup by the eager loader in main.ts. Subsequent
 * `member(name, castLib)` / `castLib(n).name = ...` lookups hit this registry. */
export interface CastlibRecord {
  /** Director cast library number (1, 2, 3, ...). */
  number: number;
  /** Human-readable name (e.g. "fuse_client", "hh_human"). */
  name: string;
  /** Original `.cct` filename on disk (e.g. "fuse_client.cct"). */
  fileName: string;
  /** `id → member` for the castlib's static members. */
  members: Map<number, import("./ScoreData.js").CastMemberJson>;
  /** `name → id` secondary index for the castlib's members. */
  membersByName: Map<string, number>;
  /** `script name → castMember number` so `new(script("Name"))` can find the script. */
  scriptsByName: Map<string, number>;
  /** `castMember → script name` reverse index. */
  scriptsByCastMember: Map<number, string>;
  /** True once `registerCastlib` has been called for this number. */
  loaded: boolean;
}

export class LingoRuntimeHost implements LingoHost {
  private readonly score: ScoreJson;
  private readonly loadBitmap: BitmapLoader;
  private readonly player: ScorePlayer;
  private readonly audio?: { play(name: string): void };
  private readonly cast?: import("./ScoreData.js").CastJson;
  private readonly state: HostState;
  private readonly spriteMemberTokens = new WeakMap<RenderSprite, MemberToken>();
  private nextDynamicMemberId = 1_000_000_000_000_000;
  private dynamicMembers = new Map<number, DynamicMember>();
  private memberImages = new Map<string, LingoValue>();
  private dynamicMemberImages = new Map<number, LingoValue>();
  private readonly memberRuntimeProps = new Map<string, Map<string, LingoValue>>();
  /** Secondary index: dynamic member name → dynamic member id. Populated by
   * `setMemberProp` when a downloaded cast member names itself (e.g. `tmember.name = url`).
   * This lets `field(name)` / `member(name)` resolve the same dynamic member later, so
   * the text stored in `tmember.text = netTextResult(...)` is visible to subsequent
   * callers like `dumpVariableField(getExtVarPath())`. */
  private dynamicMembersByName = new Map<string, number>();

  /** Registry of every cast library loaded into the runtime. Each entry corresponds to
   * one `.cct` file the C++ exporter emitted as `src/castlibs/castlib_<n>_<name>.ts`.
   * Populated eagerly at startup by main.ts via `registerCastlib`. The cross-library
   * `resolveMember` fallback (line ~605) and the new `castLib(n)` proxy both read from
   * this map. */
  private castlibs = new Map<number, CastlibRecord>();
  private readonly namedTimeouts = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  /** Cached value for `the number of castLibs`. Invalidated/updated whenever a new
   * castlib number is registered. This property is queried O(n²) inside cast-loading
   * loops, so recomputing it from the full registry on every access is a hotspot. */
  private cachedNumberOfCastlibs: number | null = null;

  /** The snapshot the host is currently reading/writing. Set by the frame loop before handlers run. */
  public snapshot: FrameSnapshot | null = null;

  private spriteDispatcher: ((channel: number, symbolName: string, args: LingoValue[]) => LingoValue) | null = null;
  private scriptInstanceCreator: ((scriptName: string, args: LingoValue[]) => LingoValue) | null = null;
  private instanceDispatcher: ((scriptName: string, handlerName: string, me: LingoMe, args: LingoValue[]) => LingoValue) | null = null;
  private instanceHandlerChecker: ((instance: LingoMe, handlerName: string) => boolean) | null = null;
  private globalDispatcher: ((handlerName: string, args: LingoValue[]) => LingoValue) | null = null;

  setSpriteDispatcher(dispatcher: typeof this.spriteDispatcher): void {
    this.spriteDispatcher = dispatcher;
  }

  setScriptInstanceCreator(creator: typeof this.scriptInstanceCreator): void {
    this.scriptInstanceCreator = creator;
  }

  setInstanceDispatcher(dispatcher: typeof this.instanceDispatcher): void {
    this.instanceDispatcher = dispatcher;
  }

  setInstanceHandlerChecker(checker: typeof this.instanceHandlerChecker): void {
    this.instanceHandlerChecker = checker;
  }

  setGlobalDispatcher(dispatcher: typeof this.globalDispatcher): void {
    this.globalDispatcher = dispatcher;
  }

  getCastMembers(): import("./ScoreData.js").CastMemberJson[] {
    return this.cast?.members ?? [];
  }

  /** Register a cast library loaded from a `src/castlibs/castlib_<n>_<name>.ts` module.
   * Called once per castlib during startup, after the eager `await import()` resolves.
   * The members are folded into `memberIdIndex` so `resolveMember` already returns them
   * (the cross-library fallback at line ~605 also picks them up by name). */
  registerCastlib(record: Omit<CastlibRecord, "loaded">): void {
    const full: CastlibRecord = { ...record, loaded: true };
    this.castlibs.set(record.number, full);
    if (this.cachedNumberOfCastlibs === null || record.number > this.cachedNumberOfCastlibs) {
      this.cachedNumberOfCastlibs = record.number;
    }
    this.ensureMemberIdIndex();
    for (const m of record.members.values()) {
      this.memberIdIndex.set(`${m.castLib}:${m.id}`, m);
    }
  }

  /** Look up a registered cast library by number. Returns null if no such castlib. */
  getCastlib(num: number): CastlibRecord | null {
    return this.castlibs.get(num) ?? null;
  }

  /** Returns the display name for cast library `n`, or "" if not registered. */
  castLibName(num: number): string {
    return this.castlibs.get(num)?.name ?? "";
  }

  castLibNumberByName(name: string): number {
    const wanted = name.toLowerCase();
    for (const [num, record] of this.castlibs) {
      if (record.name.toLowerCase() === wanted) return num;
    }
    return 0;
  }

  /** Returns the original `.cct` filename for cast library `n`, or "" if not registered. */
  castLibFileName(num: number): string {
    return this.castlibs.get(num)?.fileName ?? "";
  }

  /** Set the display name for cast library `n`. The Lingo `castLib(n).name = "foo"`
   * setter calls this. Creates an empty record if the castlib hasn't been registered
   * yet (so the castload manager's `setImportedCast` call works for any castlib
   * number, not just ones the eager loader pre-registered). */
  setCastlibName(num: number, name: string): void {
    const existing = this.castlibs.get(num);
    const isPlaceholderName = /^empty\s+/i.test(name);
    const hasLoadedRealCast = !!existing
      && existing.loaded
      && existing.members.size > 0
      && !!existing.fileName
      && !/empty\.(?:cct|cst)$/i.test(existing.fileName);
    if (isPlaceholderName && hasLoadedRealCast) {
      return;
    }
    const source = [...this.castlibs.values()].find(
      (candidate) => candidate.number !== num && candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      existing.name = name;
      if (source) {
        existing.members = new Map(
          [...source.members].map(([id, member]) => [id, { ...member, castLib: num }]),
        );
        existing.membersByName = new Map(source.membersByName);
        existing.scriptsByName = new Map(source.scriptsByName);
        existing.scriptsByCastMember = new Map(source.scriptsByCastMember);
        existing.loaded = true;
        this.ensureMemberIdIndex();
        for (const member of existing.members.values()) {
          this.memberIdIndex.set(`${num}:${member.id}`, member);
        }
      }
    } else {
      this.castlibs.set(num, {
        number: num,
        name,
        fileName: "",
        members: new Map(),
        membersByName: new Map(),
        scriptsByName: new Map(),
        scriptsByCastMember: new Map(),
        loaded: false,
      });
      if (this.cachedNumberOfCastlibs === null || num > this.cachedNumberOfCastlibs) {
        this.cachedNumberOfCastlibs = num;
      }
    }
  }

  /** Set the original `.cct` filename for cast library `n`. Symmetric to
   * `setCastlibName`. Creates an empty record if needed.
   *
   * The castload manager's `resetCastLibs` renames every dynamic slot to
   * "empty N" and sets its fileName to a placeholder like `.../empty.cct`.
   * Because we eagerly preload all external castlibs at startup, those slots
   * already hold the real `.cct` filename and their registered members. Keep
   * the real filename so `verifyReset` (which fatalErrors when an "empty" slot
   * still has members) does not abort the boot. */
  setCastlibFileName(num: number, fileName: string): void {
    const existing = this.castlibs.get(num);
    if (existing) {
      const isPlaceholder = /empty\.cct$/i.test(fileName);
      const hasRealFileName = existing.fileName && !/empty\.cct$/i.test(existing.fileName);
      if (isPlaceholder && hasRealFileName) {
        return;
      }
      existing.fileName = fileName;
    } else {
      this.castlibs.set(num, {
        number: num,
        name: "",
        fileName,
        members: new Map(),
        membersByName: new Map(),
        scriptsByName: new Map(),
        scriptsByCastMember: new Map(),
        loaded: false,
      });
      if (this.cachedNumberOfCastlibs === null || num > this.cachedNumberOfCastlibs) {
        this.cachedNumberOfCastlibs = num;
      }
    }
  }

  private paramsStack: LingoValue[][] = [];
  private castLibStack: number[] = [];
  private pendingExplicitCastLib: number | null = null;

  pushParams(args: LingoValue[]): void {
    this.paramsStack.push(args);
  }

  popParams(): void {
    this.paramsStack.pop();
  }

  getParam(index: number): LingoValue {
    const frame = this.paramsStack[this.paramsStack.length - 1];
    if (!frame || index < 1 || index > frame.length) {
      return undefined;
    }
    return frame[index - 1];
  }

  getParamCount(): number {
    const frame = this.paramsStack[this.paramsStack.length - 1];
    return frame ? frame.length : 0;
  }

  /** `externalParamValue(name)` reads embed parameters supplied to the Shockwave plugin. */
  getExternalParam(name: string): LingoValue {
    const player = this.state.globals.get("_player");
    if (player === undefined) {
      return undefined;
    }
    const params = (player as unknown as { externalParams?: LingoPropList }).externalParams;
    if (params === undefined) {
      return undefined;
    }
    return params.get(name);
  }

  /** The default castLib for numeric member/script lookups when none is supplied. */
  pushCastLib(castLib: number): void {
    this.castLibStack.push(castLib);
  }

  popCastLib(): void {
    this.castLibStack.pop();
  }

  /** Clear the current-castlib stack. Used by the dispatcher at the start of each
   * handler invocation to discard any leaks from the previous expression's
   * `member(name, castlib)` calls. */
  clearCastLibStack(): void {
    this.castLibStack.length = 0;
  }

  getCurrentCastLib(): number {
    return this.castLibStack[this.castLibStack.length - 1] ?? 1;
  }

  constructor(options: LingoRuntimeHostOptions) {
    this.score = options.score;
    this.loadBitmap = options.loadBitmap;
    this.player = options.player;
    this.audio = options.audio;
    this.cast = options.cast;
    this.state = {
      globals: new Map(),
      frameIndexOverride: null,
      pendingSound: null,
      memberTextCache: new Map(),
      randomSeed: 0,
      randomState: 0,
      startTime: Date.now(),
      moviePath: "",
      mouseH: 0,
      mouseV: 0,
      mouseDown: false,
      key: "",
      keyCode: 0,
      shiftDown: false,
    };
    // Pre-populate Director built-in globals so handlers can read _player.windowList etc.
    this.state.globals.set("_player", makePlayerObject());
    this.state.globals.set("_movie", makeMovieObject());
    this.setRandomSeed(0);
  }

  // --- Deterministic random (matches C++ LingoVM / java.util.Random) ------------
  private setRandomSeed(seed: number): void {
    const MASK = (1n << 48n) - 1n;
    const MULTIPLIER = 0x5DEECE66Dn;
    this.state.randomSeed = seed;
    let s = (BigInt(seed) ^ MULTIPLIER) & MASK;
    this.state.randomState = Number(s);
  }

  private nextRandomBits(bits: number): number {
    const MASK = (1n << 48n) - 1n;
    const MULTIPLIER = 0x5DEECE66Dn;
    const ADDEND = 0xBn;
    let s = (BigInt(this.state.randomState) * MULTIPLIER + ADDEND) & MASK;
    this.state.randomState = Number(s);
    return Number(s >> BigInt(48 - bits));
  }

  private randomInt(max: number): number {
    if (max <= 0) {
      return 1;
    }
    let result = 0;
    if ((max & -max) === max) {
      // max is a power of two: fast path.
      result = Number((BigInt(max) * BigInt(this.nextRandomBits(31))) >> 31n);
    } else {
      let bits = 0;
      do {
        bits = this.nextRandomBits(31);
        result = bits % max;
      } while (bits - result + (max - 1) < 0);
    }
    return result + 1;
  }

  private memberCacheKey(member: import("./ScoreData.js").CastMemberJson | null, token?: MemberToken): string {
    if (member) {
      return `${member.castLib}:${member.id}`;
    }
    if (token) {
      if (typeof token.id === "string") {
        return `name:${token.id}`;
      }
      return `${token.castLib ?? 0}:${token.id}`;
    }
    return "";
  }

  private requireSnapshot(): FrameSnapshot {
    if (!this.snapshot) {
      throw new LingoNotImplemented("Lingo host has no active snapshot (frame loop not running).");
    }
    return this.snapshot;
  }

  private findSpriteIndex(channel: number): number {
    const snapshot = this.requireSnapshot();
    return snapshot.sprites.findIndex((s) => s.channel === channel);
  }

  private currentScoreSpriteJson(channel: number): ScoreSpriteJson | null {
    const snapshot = this.requireSnapshot();
    const frameIndex = (snapshot.frameNumber >= 1 ? snapshot.frameNumber : 1) - 1;
    const frame = this.score.frames[frameIndex];
    if (!frame) {
      return null;
    }
    return frame.sprites.find((s) => s.channel === channel) ?? null;
  }

  private ensureSprite(channel: number): RenderSprite {
    const snapshot = this.requireSnapshot();
    const index = this.findSpriteIndex(channel);
    if (index >= 0) {
      const sprite = snapshot.sprites[index];
      if (!this.spriteMemberTokens.has(sprite)) {
        const json = this.currentScoreSpriteJson(channel);
        if (json && json.castMemberId) {
          this.spriteMemberTokens.set(sprite, { id: json.castMemberId });
        } else {
          this.spriteMemberTokens.set(sprite, { id: 0 });
        }
      }
      return sprite;
    }
    // Create a dynamic placeholder sprite for Lingo-puppetted channels.
    const placeholder: ScoreSpriteJson = {
      channel,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      locZ: channel,
      visible: true,
      type: "BITMAP",
      ink: 0,
      blend: 100,
      flipH: false,
      flipV: false,
      rotation: 0,
      skew: 0,
      bakedBitmapAsset: null,
    };
    const sprite = buildSprite(placeholder, this.loadBitmap);
    snapshot.sprites.push(sprite);
    return sprite;
  }

  getSpriteProp(channel: number, prop: string): LingoValue {
    const sprite = this.ensureSprite(channel);
    switch (prop.toLowerCase()) {
      case "loch":
        return this.spriteLocH(sprite);
      case "locv":
        return this.spriteLocV(sprite);
      case "loc":
        return [this.spriteLocH(sprite), this.spriteLocV(sprite)];
      case "locz":
        return sprite.locZ;
      case "width":
        return sprite.width;
      case "height":
        return sprite.height;
      case "rect":
        return new LingoList([
          this.spriteLocH(sprite),
          this.spriteLocV(sprite),
          this.spriteLocH(sprite) + sprite.width,
          this.spriteLocV(sprite) + sprite.height,
        ]);
      case "visible":
        return sprite.visible;
      case "puppet":
        return true;
      case "ink":
        return sprite.ink;
      case "blend":
        return sprite.blend;
      case "color":
      case "forecolor":
        return sprite.foreColor;
      case "bgcolor":
      case "backcolor":
        return sprite.backColor;
      case "fliph":
        return sprite.flipH;
      case "flipv":
        return sprite.flipV;
      case "rotation":
        return sprite.rotation;
      case "skew":
        return sprite.skew;
      case "member":
      case "castnum":
      case "membernum":
        return new LingoMemberProxy(this.memberFromSprite(sprite), this);
      case "cursor":
        return null;
      case "palette":
        return null;
      case "scriptinstancelist":
        return null;
      default:
        throw new LingoNotImplemented(`sprite(${channel}).${prop} is not implemented in the TS host.`);
    }
  }

  setSpriteProp(channel: number, prop: string, value: LingoValue): void {
    const sprite = this.ensureSprite(channel);
    const num = (v: LingoValue): number => (typeof v === "number" ? v : Number(v));
    const color = (v: LingoValue): number => {
      if (typeof v === "number") return v;
      if (v && typeof v === "object" && "red" in v && "green" in v && "blue" in v) {
        const c = v as unknown as { red: number; green: number; blue: number };
        return ((c.red & 0xff) << 16) | ((c.green & 0xff) << 8) | (c.blue & 0xff);
      }
      return num(v);
    };
    const bool = (v: LingoValue): boolean => {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      return !!v;
    };
    switch (prop.toLowerCase()) {
      case "loch":
        this.setSpriteLocH(sprite, num(value));
        break;
      case "locv":
        this.setSpriteLocV(sprite, num(value));
        break;
      case "loc": {
        if (value instanceof LingoList) {
          this.setSpriteLocH(sprite, num(value.get(1)));
          this.setSpriteLocV(sprite, num(value.get(2)));
        } else if (Array.isArray(value)) {
          this.setSpriteLocH(sprite, num(value[0]));
          this.setSpriteLocV(sprite, num(value[1]));
        }
        break;
      }
      case "locz":
        sprite.locZ = num(value);
        break;
      case "width":
        sprite.width = num(value);
        break;
      case "height":
        sprite.height = num(value);
        break;
      case "rect": {
        const values = value instanceof LingoList
          ? value.toArray()
          : Array.isArray(value) ? value : [];
        if (values.length >= 4) {
          const left = num(values[0]);
          const top = num(values[1]);
          this.setSpriteLocH(sprite, left);
          this.setSpriteLocV(sprite, top);
          sprite.width = num(values[2]) - left;
          sprite.height = num(values[3]) - top;
        }
        break;
      }
      case "visible":
        sprite.visible = bool(value);
        break;
      case "ink":
        sprite.ink = inkModeFromCode(num(value));
        break;
      case "blend":
        sprite.blend = num(value);
        break;
      case "color":
      case "forecolor":
        sprite.foreColor = color(value);
        sprite.hasForeColor = true;
        break;
      case "bgcolor":
      case "backcolor":
        sprite.backColor = color(value);
        sprite.hasBackColor = true;
        break;
      case "fliph":
        sprite.flipH = bool(value);
        break;
      case "flipv":
        sprite.flipV = bool(value);
        break;
      case "rotation":
        sprite.rotation = num(value);
        break;
      case "skew":
        sprite.skew = num(value);
        break;
      case "stretch":
        // Director stretch mode is not yet emulated; ignore to let dynamic sprites build.
        break;
      case "member":
      case "castnum":
      case "membernum":
        this.setMemberOnSprite(sprite, value);
        break;
      case "cursor":
      case "palette":
      case "scriptinstancelist":
        // Silently ignored for first slice.
        break;
      default:
        throw new LingoNotImplemented(`set sprite(${channel}).${prop} is not implemented in the TS host.`);
    }
  }

  private memberFromSprite(sprite: RenderSprite): MemberToken {
    const token = this.spriteMemberTokens.get(sprite);
    if (token) {
      return token;
    }
    const json = this.currentScoreSpriteJson(sprite.channel);
    if (json && json.castMemberId) {
      return { id: json.castMemberId };
    }
    return { id: 0 };
  }

  private spriteCastLib(sprite: RenderSprite): number | undefined {
    const token = this.spriteMemberTokens.get(sprite);
    if (token && typeof token.castLib === "number") {
      return token.castLib;
    }
    return undefined;
  }

  // Director sprite.locH/.locV are the registration point coordinates, not the top-left
  // corner. For bitmap cast members the registration point is the member's centre, so the
  // rendered top-left is locH/locV minus half the current width/height. This matters whenever
  // Lingo moves a sprite (e.g. random stars) or changes its member after moving it.
  private regX(sprite: RenderSprite): number {
    return Math.floor(sprite.width / 2);
  }

  private regY(sprite: RenderSprite): number {
    return Math.floor(sprite.height / 2);
  }

  private spriteLocH(sprite: RenderSprite): number {
    return sprite.x + this.regX(sprite);
  }

  private spriteLocV(sprite: RenderSprite): number {
    return sprite.y + this.regY(sprite);
  }

  private setSpriteLocH(sprite: RenderSprite, value: number): void {
    sprite.x = value - this.regX(sprite);
  }

  private setSpriteLocV(sprite: RenderSprite, value: number): void {
    sprite.y = value - this.regY(sprite);
  }

  private applyMemberBitmap(sprite: RenderSprite, member: import("./ScoreData.js").CastMemberJson | null): void {
    if (member) {
      // Preserve the registration-point location while the bitmap dimensions change.
      const oldLocH = this.spriteLocH(sprite);
      const oldLocV = this.spriteLocV(sprite);
      const baked = member.bakedBitmapAsset
        ? this.loadBitmap(member.bakedBitmapAsset)
        : null;
      sprite.bakedBitmap = baked;
      // Some exported cast members (notably #shape members) carry no baked
      // dimensions. The visualizer assigns explicit widths/heights from the layout
      // definition, so keep those when the member metadata is empty.
      if (member.bakedWidth > 0) {
        sprite.width = member.bakedWidth;
      }
      if (member.bakedHeight > 0) {
        sprite.height = member.bakedHeight;
      }
      sprite.type = coerceSpriteType(member.type);
      this.setSpriteLocH(sprite, oldLocH);
      this.setSpriteLocV(sprite, oldLocV);
    } else {
      sprite.bakedBitmap = null;
    }
  }

  private setMemberOnSprite(sprite: RenderSprite, value: LingoValue): void {
    if (value instanceof LingoMemberProxy) {
      this.setMemberOnSprite(sprite, value.token);
      return;
    }
    if (isMemberToken(value)) {
      if (typeof value.id === "number" && this.isDynamicMemberId(value.id)) {
        const dyn = this.dynamicMembers.get(value.id);
        const image = this.dynamicMemberImages.get(value.id);
        this.spriteMemberTokens.set(sprite, { id: value.id, castLib: value.castLib });
        if (image instanceof LingoImage) {
          const oldLocH = this.spriteLocH(sprite);
          const oldLocV = this.spriteLocV(sprite);
          sprite.bakedBitmap = image.bitmap;
          sprite.width = image.width;
          sprite.height = image.height;
          sprite.type = coerceSpriteType(dyn?.type ?? "bitmap");
          this.setSpriteLocH(sprite, oldLocH);
          this.setSpriteLocV(sprite, oldLocV);
        } else {
          sprite.bakedBitmap = null;
          sprite.type = coerceSpriteType(dyn?.type ?? "bitmap");
        }
        return;
      }
      const member = this.resolveMember(value.id, value.castLib);
      this.spriteMemberTokens.set(sprite, { id: value.id, castLib: value.castLib });
      this.applyMemberBitmap(sprite, member);
      return;
    }
    if (typeof value === "string") {
      const member = this.findCastMemberByName(value);
      if (member) {
        this.spriteMemberTokens.set(sprite, { id: member.id, castLib: member.castLib });
      }
      this.applyMemberBitmap(sprite, member);
      return;
    }
    if (typeof value === "number") {
      if (this.isDynamicMemberId(value) && this.dynamicMembers.has(value)) {
        this.setMemberOnSprite(sprite, { id: value, castLib: this.getDynamicMember(value)?.castLib });
        return;
      }
      // Member numbers stored by Lingo (e.g. from `member(...).number`) are global
      // slot ids; decode them so `sprite.member = someGlobalNumber` resolves to the
      // correct cast library rather than the sprite's own cast library.
      let castLib = this.spriteCastLib(sprite);
      let memberId = value;
      if (value > 65535) {
        const decodedCastLib = (value >>> 16) & 0xFFFF;
        const decodedMember = value & 0xFFFF;
        if (decodedCastLib >= 1 && decodedMember >= 1) {
          castLib = decodedCastLib;
          memberId = decodedMember;
        }
      }
      const member = this.resolveMember(memberId, castLib);
      if (member) {
        this.spriteMemberTokens.set(sprite, { id: member.id, castLib: member.castLib });
      }
      this.applyMemberBitmap(sprite, member);
      return;
    }
  }

  private memberIdIndex = new Map<string, import("./ScoreData.js").CastMemberJson>();

  private ensureMemberIdIndex(): void {
    if (this.memberIdIndex.size > 0 || !this.cast) {
      return;
    }
    for (const m of this.cast.members) {
      this.memberIdIndex.set(`${m.castLib}:${m.id}`, m);
    }
  }

  private resolveMember(id: number | string, castLib?: number | string): import("./ScoreData.js").CastMemberJson | null {
    const members = this.cast?.members;
    if (!members) {
      return null;
    }
    let rawLib = castLib === undefined ? undefined : Number(castLib);
    // Director casts are numbered from 1; a castLib of 0 means "unspecified" in Lingo
    // shorthand like `field "x"` / `member("x", 0)` and should resolve by name across all libs.
    if (rawLib === undefined && typeof id === "number") {
      rawLib = this.pendingExplicitCastLib ?? this.getCurrentCastLib();
      this.pendingExplicitCastLib = null;
    }
    let libNum = (rawLib !== undefined && rawLib !== 0 && !Number.isNaN(rawLib)) ? rawLib : undefined;
    const explicitLib = libNum;
    if (typeof id === "string") {
      const currentLib = libNum === undefined ? this.getCurrentCastLib() : undefined;
      // Prefer the active cast library when no explicit castLib is supplied, so
      // common script names like "Manager Template Class" resolve to the same
      // library as the executing handler rather than the first global match.
      for (const m of members) {
        if (m.name !== id) {
          continue;
        }
        if (libNum !== undefined && m.castLib !== libNum) {
          continue;
        }
        if (currentLib !== undefined && m.castLib !== currentLib) {
          continue;
        }
        return m;
      }
      // Search dynamically-loaded castlibs (the eager loader registers them via
      // `registerCastlib` at startup). Mirror the per-castlib `membersByName` index
      // for every registered castlib, then verify the candidate's castLib matches
      // any libNum constraint or the active cast library. Falls through to the
      // cross-library name scan if no libNum is supplied.
      for (const cl of this.castlibs.values()) {
        const memberNum = cl.membersByName.get(id);
        if (memberNum === undefined) continue;
        if (libNum !== undefined && cl.number !== libNum) continue;
        if (currentLib !== undefined && cl.number !== currentLib) continue;
        const m = cl.members.get(memberNum);
        if (m) return m;
      }
      // No match in the requested library. Only fall back to a global name scan
      // when no explicit cast library was supplied (Lingo shorthand like
      // `field "x"` / `member("x", 0)`). If the caller wrote `member("x", 37)`,
      // returning a member from a different castlib is wrong.
      if (libNum === undefined) {
        for (const m of members) {
          if (m.name === id) return m;
        }
        for (const cl of this.castlibs.values()) {
          const memberNum = cl.membersByName.get(id);
          if (memberNum === undefined) continue;
          const m = cl.members.get(memberNum);
          if (m) return m;
        }
      }
      return null;
    }
    this.ensureMemberIdIndex();
    // Director stores `member(...).number` as a global slot id. Decode bare
    // global references when no explicit cast library is supplied.
    if (
      typeof id === "number" &&
      !this.isDynamicMemberId(id) &&
      id > 65535 &&
      libNum === undefined
    ) {
      const decodedCastLib = (id >>> 16) & 0xFFFF;
      const decodedMember = id & 0xFFFF;
      if (decodedCastLib >= 1 && decodedMember >= 1) {
        id = decodedMember;
        libNum = decodedCastLib;
      }
    }
    if (libNum !== undefined) {
      const exact = this.memberIdIndex.get(`${libNum}:${id}`);
      if (exact) return exact;
      // Cast-library-agnostic fallback: when Lingo passes a member number without
      // an explicit cast library (e.g. the variable container's `dump(field)` looks
      // up a member it was given a numeric ID for, or `field(13)` without a castlib
      // hint), search every cast library so the lookup succeeds. If the caller
      // supplied a specific library, only scan that library.
      if (explicitLib === undefined) {
        for (const m of members) {
          if (m.id === id) return m;
        }
        for (const [key, m] of this.memberIdIndex) {
          if (m.id === id) return m;
        }
        for (const cl of this.castlibs.values()) {
          for (const m of cl.members.values()) {
            if (m.id === id) return m;
          }
        }
      } else {
        for (const cl of this.castlibs.values()) {
          if (cl.number !== libNum) continue;
          for (const m of cl.members.values()) {
            if (m.id === id) return m;
          }
        }
      }
      return null;
    }
    const inCurrent = this.memberIdIndex.get(`${this.getCurrentCastLib()}:${id}`);
    if (inCurrent) return inCurrent;
    for (const m of members) {
      if (m.id === id) return m;
    }
    for (const [key, m] of this.memberIdIndex) {
      if (m.id === id) return m;
    }
    for (const cl of this.castlibs.values()) {
      for (const m of cl.members.values()) {
        if (m.id === id) return m;
      }
    }
    return null;
  }

  private findCastMemberByName(name: string): import("./ScoreData.js").CastMemberJson | null {
    return this.resolveMember(name, undefined);
  }


  getMember(numOrName: LingoValue, castLib?: LingoValue): LingoValue {
    // Director accepts an existing member reference anywhere a member
    // expression is accepted (for example `member(resource.createMember(...))`).
    // Preserve its identity instead of coercing the object to member 0.
    if (numOrName instanceof LingoMemberProxy) {
      return numOrName.token;
    }
    if (isMemberToken(numOrName)) {
      return numOrName;
    }
    // If the caller asks for a member by name and we have a dynamic member with that
    // name (typically a downloaded cast member), return the dynamic token so reads
    // and writes hit the same backing store that `tmember.text = ...` used.
    if (typeof numOrName === "string" && numOrName.length > 0) {
      const dynId = this.dynamicMembersByName.get(numOrName);
      if (dynId !== undefined) {
        const dyn = this.dynamicMembers.get(dynId);
        if (dyn) {
          return { id: dyn.id, castLib: dyn.castLib };
        }
      }
    }
    // Numeric references to dynamic members are synthetic ids (>= 1e15) and must
    // not be decoded as Director slot ids.
    if (typeof numOrName === "number" && this.isDynamicMemberId(numOrName)) {
      const dyn = this.dynamicMembers.get(numOrName);
      if (dyn) {
        return { id: dyn.id, castLib: dyn.castLib };
      }
    }
    let safeId: number | string =
      numOrName === null || numOrName === undefined ? 0 :
      typeof numOrName === "number" ? numOrName :
      typeof numOrName === "string" ? numOrName :
      0;
    let safeCastLib: number | string | undefined =
      castLib === null || castLib === undefined ? undefined :
      typeof castLib === "number" ? castLib :
      typeof castLib === "string" ? castLib :
      undefined;
    // Director encodes a member's global "number" property as
    // `(castLib << 16) | member`. Decode bare numeric references so that code
    // which stores `member(...).number` and later passes it back to `member()` or
    // `field()` resolves to the correct cast library.
    let decodedSlotId = false;
    if (safeCastLib === undefined && typeof safeId === "number" && !this.isDynamicMemberId(safeId) && safeId > 65535) {
      const decodedCastLib = (safeId >>> 16) & 0xFFFF;
      const decodedMember = safeId & 0xFFFF;
      if (decodedCastLib >= 1 && decodedMember >= 1) {
        safeCastLib = decodedCastLib;
        safeId = decodedMember;
        decodedSlotId = true;
      }
    }
    if (safeCastLib === undefined && typeof safeId === "number" && this.pendingExplicitCastLib !== null) {
      safeCastLib = this.pendingExplicitCastLib;
      this.pendingExplicitCastLib = null;
    }
    // Director semantic: when Lingo evaluates `member(name, castlib)`, the castlib
    // is pushed onto the runtime's current-castlib stack so a subsequent bare
    // `field(num)` / `member(num)` in the same expression resolves in that castlib.
    // The transpiled `member(name, castlib).number` + `field(number)` pattern
    // (e.g. `pVarMngrObj.dump(member(tThreadField, tCastNum).number)` in
    // Thread Manager::initThread) depends on this — without it, the per-castlib
    // `thread.index` fields in hh_entry / hh_ig_gamesys / etc. collide with the
    // same member number in fuse_client castlib 2 and `initAll` only ever finds
    // the core thread. The stack is cleared by the instanceDispatcher frame on
    // each handler invocation so the leaked push from the previous expression
    // doesn't bleed into unrelated lookups.
    if (safeCastLib !== undefined && !decodedSlotId) {
      const libNum = Number(safeCastLib);
      if (!Number.isNaN(libNum) && libNum > 0) {
        this.pendingExplicitCastLib = libNum;
      }
    }
    return { id: safeId, castLib: safeCastLib };
  }

  private isDynamicMemberId(id: number | string): boolean {
    return typeof id === "number" && id >= 1_000_000_000_000_000;
  }

  private getDynamicMember(id: number): DynamicMember | undefined {
    return this.dynamicMembers.get(id);
  }

  getMemberProp(member: LingoValue, prop: string): LingoValue {
    if (!isMemberToken(member)) {
      return undefined;
    }
    if (typeof member.id === "number" && this.isDynamicMemberId(member.id)) {
      const dyn = this.getDynamicMember(member.id);
      if (!dyn) {
        return undefined;
      }
      const lower = prop.toLowerCase();
      if (lower === "name") {
        return dyn.name;
      }
      if (lower === "type") {
        return symbol(dyn.type);
      }
      if (lower === "number" || lower === "num") {
        return dyn.id;
      }
      if (lower === "text" || lower === "htmltext") {
        return dyn.text;
      }
      if (lower === "image") {
        const existing = this.dynamicMemberImages.get(dyn.id);
        if (existing !== undefined) {
          return existing;
        }
        // Text/field members do not have a baked bitmap asset, but scripts
        // such as Common Button Class read member(...).image to build button
        // labels. Generate a blank surface sized from the member's rect so
        // image-based UI construction can proceed.
        if (dyn.type === "text" || dyn.type === "field") {
          const props = this.memberRuntimeProps.get(`dynamic:${dyn.id}`);
          const width = Math.max(1, Number(props?.get("rect")?.width ?? props?.get("width") ?? 1) || 1);
          const height = Math.max(1, Number(props?.get("rect")?.height ?? props?.get("height") ?? 1) || 1);
          const img = new LingoImage(width, height, 32);
          this.dynamicMemberImages.set(dyn.id, img);
          return img;
        }
        return existing;
      }
      return this.memberRuntimeProps.get(`dynamic:${dyn.id}`)?.get(lower);
    }
    const resolved = this.resolveMember(member.id, member.castLib);
    const lower = prop.toLowerCase();
    if (lower === "name") {
      return resolved?.name ?? "";
    }
    if (lower === "type") {
      return symbol(resolved?.type ?? "unknown");
    }
    if (lower === "number" || lower === "num") {
      // Director's `the number of member` is the global slot id:
      // `(castLib << 16) | member`. This is what Lingo scripts store in
      // resource-manager maps and pass back to `script()` / `field()`.
      if (resolved) {
        return (resolved.castLib << 16) | (resolved.id & 0xFFFF);
      }
      if (typeof member.id === "number") {
        return member.id;
      }
      return 0;
    }
    if (lower === "castlib" || lower === "cast") {
      return resolved?.castLib ?? 0;
    }
    if (lower === "text" || lower === "htmltext") {
      const key = this.memberCacheKey(resolved, member as MemberToken);
      if (key && this.state.memberTextCache.has(key)) {
        return this.state.memberTextCache.get(key);
      }
      // Initial static text exported from the Director text cast member.
      if (resolved && "text" in resolved && resolved.text !== undefined) {
        return resolved.text;
      }
      return "";
    }
    if (lower === "width" || lower === "height") {
      return resolved ? (lower === "width" ? resolved.bakedWidth : resolved.bakedHeight) : 0;
    }
    if (lower === "image") {
      const key = this.memberCacheKey(resolved, member as MemberToken);
      if (!key) return undefined;
      const existing = this.memberImages.get(key);
      if (existing !== undefined) return existing;
      if (resolved) {
        const bitmap = resolved.bakedBitmapAsset
          ? (this.loadBitmap(resolved.bakedBitmapAsset) ?? undefined)
          : undefined;
        const surface = new LingoImage(
          bitmap?.width() ?? Math.max(resolved.bakedWidth || 1, 1),
          bitmap?.height() ?? Math.max(resolved.bakedHeight || 1, 1),
          bitmap?.bitDepth() ?? 32,
          undefined,
          bitmap,
        );
        this.memberImages.set(key, surface);
        return surface;
      }
      // Unresolved member: return a minimal blank surface so scripts that
      // duplicate() or flip an image don't throw during UI construction.
      const surface = new LingoImage(1, 1, 32);
      this.memberImages.set(key, surface);
      return surface;
    }
    if (lower === "number of castmembers") {
      // The emitter represents `the number of castMembers of castLib n` as
      // `thePropOf(member(n), "number of castMembers")`. Here the member id is
      // the cast-library number; a current-cast context attached by `member()`
      // must not redirect the query to (typically) fuse_client.
      const lib = Number(member.id) || 1;
      const registered = this.castlibs.get(lib);
      if (registered) return registered.members.size;
      let max = 0;
      for (const m of this.cast?.members ?? []) {
        if (m.castLib === lib && m.id > max) {
          max = m.id;
        }
      }
      return max;
    }
    const key = this.memberCacheKey(resolved, member as MemberToken);
    return key ? this.memberRuntimeProps.get(key)?.get(lower) : undefined;
  }

  getScriptMemberInfo(
    nameOrNum: LingoValue,
  ): { name: string; castLib: number; memberId: number; type?: string } | undefined {
    if (isMemberToken(nameOrNum)) {
      const resolved = this.resolveMember(nameOrNum.id, nameOrNum.castLib);
      if (!resolved) return undefined;
      return { name: resolved.name, castLib: resolved.castLib, memberId: resolved.id, type: resolved.type };
    }
    if (typeof nameOrNum === "number") {
      if (nameOrNum <= 0) return undefined;
      let castLib: number;
      let memberId: number;
      if (nameOrNum > 65535) {
        castLib = (nameOrNum >>> 16) & 0xFFFF;
        memberId = nameOrNum & 0xFFFF;
        if (castLib < 1 || memberId < 1) return undefined;
      } else {
        // Director's script() builtin treats small ids as castlib 1.
        castLib = 1;
        memberId = nameOrNum;
      }
      const resolved = this.resolveMember(memberId, castLib);
      if (!resolved) return undefined;
      return { name: resolved.name, castLib, memberId, type: resolved.type };
    }
    let name: string;
    if (isSymbol(nameOrNum)) {
      name = nameOrNum.name;
    } else if (typeof nameOrNum === "string") {
      name = nameOrNum;
    } else {
      name = String(nameOrNum);
    }
    const resolved = this.resolveMember(name, undefined);
    if (!resolved) return undefined;
    return { name: resolved.name, castLib: resolved.castLib, memberId: resolved.id, type: resolved.type };
  }

  setMemberProp(member: LingoValue, prop: string, value: LingoValue): void {
    if (!isMemberToken(member)) {
      return;
    }
    const lower = prop.toLowerCase();
    if (typeof member.id === "number" && this.isDynamicMemberId(member.id)) {
      const dyn = this.getDynamicMember(member.id);
      if (!dyn) {
        return;
      }
      if (lower === "text" || lower === "htmltext") {
        const text = normalizeLineEndings(String(value));
        dyn.text = text;
      }
      if (lower === "name") {
        const newName = String(value);
        // Keep the secondary index in sync so `field(name)` resolves to this dynamic
        // member. Remove any previous name mapping to avoid stale entries.
        if (dyn.name && dyn.name !== newName) {
          this.dynamicMembersByName.delete(dyn.name);
        }
        dyn.name = newName;
        if (newName.length > 0) {
          this.dynamicMembersByName.set(newName, dyn.id);
        }
      }
      if (lower === "image") {
        this.dynamicMemberImages.set(dyn.id, value);
        for (const sprite of this.snapshot?.sprites ?? []) {
          const token = this.spriteMemberTokens.get(sprite);
          if (token?.id === dyn.id) this.setMemberOnSprite(sprite, token);
        }
      }
      if (!["text", "htmltext", "name", "image"].includes(lower)) {
        let props = this.memberRuntimeProps.get(`dynamic:${dyn.id}`);
        if (!props) {
          props = new Map();
          this.memberRuntimeProps.set(`dynamic:${dyn.id}`, props);
        }
        props.set(lower, value);
      }
      return;
    }
    if (lower === "image") {
      const resolved = this.resolveMember(member.id, member.castLib);
      const key = this.memberCacheKey(resolved, member as MemberToken);
      if (key) {
        this.memberImages.set(key, value);
      }
      return;
    }
    if (lower === "text" || lower === "htmltext") {
      const resolved = this.resolveMember(member.id, member.castLib);
      const key = this.memberCacheKey(resolved, member as MemberToken);
      if (key) {
        this.state.memberTextCache.set(key, normalizeLineEndings(String(value)));
      }
      return;
    }
    if (lower === "name") {
      // Rename is not supported; ignored.
      return;
    }
    const resolved = this.resolveMember(member.id, member.castLib);
    const key = this.memberCacheKey(resolved, member as MemberToken);
    if (key) {
      let props = this.memberRuntimeProps.get(key);
      if (!props) {
        props = new Map();
        this.memberRuntimeProps.set(key, props);
      }
      props.set(lower, value);
    }
  }


  getGlobal(name: string): LingoValue {
    return this.state.globals.get(name);
  }

  setGlobal(name: string, value: LingoValue): void {
    this.state.globals.set(name, value);
    // Director globals are referenced as bare identifiers by the emitted TS, so mirror them
    // onto the global object. Avoid clobbering non-function browser globals (e.g. performance).
    const existing = (globalThis as unknown as Record<string, unknown>)[name];
    if (existing === undefined || typeof existing === "function") {
      (globalThis as unknown as Record<string, unknown>)[name] = value;
    }
  }

  private playerProp(name: string): LingoValue | undefined {
    const player = this.state.globals.get("_player");
    if (player === undefined) {
      return undefined;
    }
    return (player as unknown as Record<string, LingoValue>)[name];
  }

  getThe(name: string): LingoValue {
    switch (name.toLowerCase()) {
      case "frame":
        return this.currentFrame();
      case "itemdelimiter":
        return getItemDelimiter();
      case "key":
        return this.state.key;
      case "keycode":
        return this.state.keyCode;
      case "mouseh":
        return this.state.mouseH;
      case "mousev":
        return this.state.mouseV;
      case "mousedown":
        return this.state.mouseDown ? 1 : 0;
      case "shiftdown":
        return this.state.shiftDown;
      case "randomseed":
        return this.state.randomSeed;
      case "tracescript":
        return 0;
      case "tracelogfile":
        return "";
      case "runmode":
        return this.playerProp("runMode") ?? "Plugin";
      case "platform":
        return "Win,Projector";
      case "machinetype":
        return 256;
      case "activewindow":
        return this.playerProp("activeWindow") ?? ({ name: "stage" } as LingoValue);
      case "stagewidth":
        return this.score.stageWidth;
      case "stageheight":
        return this.score.stageHeight;
      case "milliseconds":
        return Date.now() - this.state.startTime;
      case "frametempo":
        return this.player.tempo(this.currentFrame());
      case "stageleft":
        return 0;
      case "stageright":
        return this.score.stageWidth;
      case "stagetop":
        return 0;
      case "stagebottom":
        return this.score.stageHeight;
      case "colordepth":
        return 32;
      case "environment":
        // Director's environment property list: #osVersion, #machineType, etc.
        return new LingoPropList([
          "osVersion", "Windows 10",
          "machineType", "Windows",
          "cpuType", "Intel",
          "colorDepth", 32,
          "network", 1,
        ]) as unknown as LingoValue;
      case "alerthook":
        return 0;
      case "stage":
        // Director's stage is `{name, image, rect, drawRect, ...}` so Lingo like
        // `(the stage).image.width` / `(the stage).rect.height` / `(the stage).title = ...`
        // works. The runtime owns stageWidth/stageHeight via score.json, so we
        // expose those as both `.image.{width,height}` and `.rect.{left,top,right,bottom}`.
        return {
          name: "stage",
          bgColor: this.score.backgroundColor,
          image: { width: this.score.stageWidth, height: this.score.stageHeight },
          rect: {
            left: 0,
            top: 0,
            right: this.score.stageWidth,
            bottom: this.score.stageHeight,
            width: this.score.stageWidth,
            height: this.score.stageHeight,
          },
          drawRect: {
            left: 0,
            top: 0,
            right: this.score.stageWidth,
            bottom: this.score.stageHeight,
          },
        } as unknown as LingoValue;
      case "moviepath":
        return this.state.moviePath;
      case "milliseconds":
        return Date.now() - this.state.startTime;
      case "maxinteger":
        return 2147483647;
      case "date":
        return new Date().toLocaleDateString("en-US");
      case "time":
        return new Date().toLocaleTimeString("en-US");
      case "long time":
        return new Date().toLocaleTimeString("en-US", { hour12: false });
      case "paramcount":
        return this.getParamCount();
      case "number of castlibs":
        // Director's `the number of castLibs` returns the highest castLib number in
        // use, not the count — the Lingo `initAll`/`resetCastLibs`/`closeAll` loops
        // walk `the number of castLibs down to 1` and use the loop variable as a
        // castlib number. Our castlib numbers are non-sequential (2, 36, 37, …,
        // 348) because the C++ exporter assigns each `.cct` a stable slot that
        // matches the production Director movie, so we must return the maximum
        // castlib number we know about — otherwise loops like Thread Manager's
        // `initAll` skip every castlib above the count, and the navigator / entry
        // / login / openinghours threads in hh_entry (castlib 202) never spawn.
        //
        // This value is queried O(n²) inside cast-loading loops, so we keep a
        // cached maximum and only fall back to a full scan before the first
        // registration or if the cache has been invalidated.
        if (this.cachedNumberOfCastlibs !== null) {
          return this.cachedNumberOfCastlibs;
        }
        const staticMax = this.cast?.castLibraries ? Math.max(0, ...this.cast.castLibraries.map((cl: { number: number }) => cl.number)) : 0;
        const registeredMax = this.castlibs.size > 0 ? Math.max(...this.castlibs.keys()) : 0;
        this.cachedNumberOfCastlibs = Math.max(staticMax, registeredMax, 1);
        return this.cachedNumberOfCastlibs;
      case "lastchannel":
        // Director's default maxChannel / lastChannel is 120, but Habbo's UI uses
        // more than 200 channels across Hotel Navigator + room + toolbars. Use
        // a number that comfortably accommodates the working set so the sprite
        // manager's preIndexChannels loop populates pFreeSprList / pTotalSprList.
        return 1000;
      case "exitlock":
        return 0;
      case "floatprecision":
        return 4;
      case "timeoutkeydown":
      case "timeoutmouse":
      case "timeoutlapsed":
        return 0;
      default:
        // For Habbo exploration: return a safe default instead of aborting the handler.
        // This is intentionally permissive and will be tightened as properties are verified.
        console.warn(`the ${name} is not implemented in the TS host; returning default.`);
        return 0;
    }
  }

  setThe(name: string, value: LingoValue): void {
    switch (name.toLowerCase()) {
      case "itemdelimiter":
        setItemDelimiter(String(value));
        return;
      case "moviepath":
        this.state.moviePath = String(value);
        return;
      case "mouseh":
        this.state.mouseH = Number(value) || 0;
        return;
      case "mousev":
        this.state.mouseV = Number(value) || 0;
        return;
      case "mousedown":
        this.state.mouseDown = Boolean(value);
        return;
      case "key":
        this.state.key = String(value);
        return;
      case "keycode":
        this.state.keyCode = Number(value) || 0;
        return;
      case "shiftdown":
        this.state.shiftDown = Boolean(value);
        return;
      case "randomseed":
        this.setRandomSeed(Number(value) | 0);
        return;
      case "tracescript":
      case "tracelogfile":
      case "exitlock":
        return;
      default:
        // No-op for unimplemented global properties in the first slice.
        return;
    }
  }

  currentFrame(): number {
    if (this.state.frameIndexOverride !== null) {
      return this.state.frameIndexOverride + 1;
    }
    return this.snapshot?.frameNumber ?? 1;
  }

  go(target: LingoValue): void {
    if (typeof target === "number") {
      this.state.frameIndexOverride = Math.max(0, target - 1);
    } else if (typeof target === "string") {
      const idx = this.player.indexForLabel(target);
      if (idx !== null && idx >= 0) {
        this.state.frameIndexOverride = idx;
      }
    } else if (isSymbol(target)) {
      const idx = this.player.indexForLabel(target.name);
      if (idx !== null && idx >= 0) {
        this.state.frameIndexOverride = idx;
      }
    }
  }

  callBuiltin(name: string, args: LingoValue[]): LingoValue {
    const lower = name.toLowerCase();
    switch (lower) {
      case "callnamed": {
        const handlerName = String(args[0] ?? "");
        const handlerArgs = args.slice(1);
        const doCall = (): LingoValue => {
          const receiver = handlerArgs[0];
          if (receiver && typeof receiver === "object" && "props" in receiver) {
            let layer: LingoValue = receiver;
            const visited = new Set<LingoMe>();
            while (layer && typeof layer === "object" && "props" in layer) {
              const instance = layer as LingoMe;
              if (visited.has(instance)) break;
              visited.add(instance);
              if (this.instanceHandlerChecker?.(instance, handlerName)) {
                return this.callBuiltin("callMethod", [handlerName, ...handlerArgs]);
              }
              layer = instance.props.get("ancestor");
            }
          }
          // Director resolves names registered by its builtin registry before movie
          // handlers. Habbo contains API handlers named `value`, `member`, etc.; using
          // those for emitted bare builtin calls corrupts initialization.
          if (SUPPORTED_LINGO_BUILTINS.has(handlerName.toLowerCase())) {
            const dispatched = dispatchValueBuiltin(handlerName, handlerArgs);
            if (dispatched.handled) return dispatched.value;
            return this.callBuiltin(handlerName, handlerArgs);
          }
          if (this.globalDispatcher) {
            const result = this.globalDispatcher(handlerName, handlerArgs);
            if (result !== LINGO_HANDLER_NOT_FOUND) return result;
          }
          return this.callBuiltin(handlerName, handlerArgs);
        };
        return doCall();
      }
      case "random":
        return this.randomInt(Number(args[0]) || 1);
      case "point":
        return [Number(args[0] ?? 0), Number(args[1] ?? 0)];
      case "go":
        this.go(args[0]);
        return undefined;
      case "marker":
        if (isSymbol(args[0])) {
          const idx = this.player.indexForLabel(args[0].name);
          return idx !== null && idx >= 0 ? idx + 1 : 0;
        }
        if (typeof args[0] === "string") {
          const idx = this.player.indexForLabel(args[0]);
          return idx !== null && idx >= 0 ? idx + 1 : 0;
        }
        return 0;
      case "updatestage":
        return undefined;
      case "preload":
        return undefined;
      case "sendallsprites": {
        const symbol = isSymbol(args[0]) ? args[0] : null;
        if (!symbol) return undefined;
        // Handled by the event dispatcher; this host-level call is a no-op.
        return undefined;
      }
      case "sendfusemsg":
        // Network messages are not replayable in the browser.
        return undefined;
      case "play": {
        const member = args[0];
        if (isMemberToken(member) && typeof member.id === "string" && this.audio) {
          this.audio.play(member.id);
        }
        return undefined;
      }
      case "puppetsprite": {
        // Director: puppetSprite(channel, flag) marks a channel as Lingo-controlled
        // (1 = puppeteer active, 0 = release to score). For our purposes we only
        // need the side effect that the channel stays alive so setSpriteProp
        // works; the runtime already routes sprite reads/writes to the snapshot
        // sprite list, so a no-op return is sufficient.
        return 1;
      }
      case "sprite":
        return new LingoSpriteProxy(Number(args[0]), this);
      case "member":
        return new LingoMemberProxy(this.getMember(args[0], args[1]), this);
      case "createmember": {
        const id = this.nextDynamicMemberId++;
        const memberName = String(args[0] ?? "");
        const memberType = isSymbol(args[1])
          ? args[1].name.toLowerCase()
          : String(args[1] ?? "field").toLowerCase();
        this.dynamicMembers.set(id, {
          id,
          castLib: this.getCurrentCastLib(),
          type: memberType,
          name: memberName,
          text: "",
        });
        if (memberName) this.dynamicMembersByName.set(memberName, id);
        return id;
      }
      case "param":
        return this.getParam(Number(args[0]));
      case "call": {
        const handler = isSymbol(args[0]) ? args[0].name : String(args[0] ?? "");
        const target = args[1];
        const methodArgs = args.slice(2);
        // Director's `call(#handler, target, ...)` is a dynamic message send to
        // the target object.  The handler must be resolved starting from the
        // target's own script layer, not from the caller's current handler layer,
        // otherwise inherited base-class handlers cannot dynamically invoke
        // leaf-class handlers (e.g. Object Base Class executeDelay calling
        // #addAnimTask on the Entry Interface instance).
        const invoke = (value: LingoValue): LingoValue => {
          const savedContext = currentScriptContext();
          if (savedContext) {
            popScriptContext();
          }
          try {
            return this.callBuiltin("callMethod", [handler, value, ...methodArgs]);
          } finally {
            if (savedContext) {
              pushScriptContext(savedContext);
            }
          }
        };
        if (target instanceof LingoList) {
          return new LingoList(target.toArray().map(invoke));
        }
        if (target instanceof LingoPropList) {
          const results: LingoValue[] = [];
          for (let i = 1; i <= target.count; i++) {
            const value = target.get(target.getPropAt(i));
            if (value !== undefined) results.push(invoke(value));
          }
          return new LingoList(results);
        }
        if (Array.isArray(target)) {
          return new LingoList((target as LingoValue[]).map(invoke));
        }
        return invoke(target);
      }
      case "sendsprite": {
        const channel = Number(args[0]);
        const sym = args[1];
        const symbolName = isSymbol(sym) ? sym.name : typeof sym === "string" ? sym : "";
        const handlerArgs = args.slice(2);
        if (this.spriteDispatcher) {
          return this.spriteDispatcher(channel, symbolName, handlerArgs);
        }
        return undefined;
      }
      case "newobj": {
        const type = typeof args[0] === "string" ? args[0] : isSymbol(args[0]) ? args[0].name : "";
        const lowerType = type.toLowerCase();
        let ctorArgs: LingoValue[] = [];
        if (Array.isArray(args[1])) {
          ctorArgs = args[1] as LingoValue[];
        } else if (args[1] instanceof LingoList) {
          ctorArgs = args[1].toArray();
        }
        // Director `new(#field, castLib(n))` / `new(#bitmap, castLib(n))` create dynamic cast members.
        if (lowerType === "field" || lowerType === "bitmap") {
          const castLibProxy = args[1];
          const castLibNum =
            castLibProxy && typeof castLibProxy === "object" && "num" in castLibProxy
              ? Number((castLibProxy as { num: number }).num)
              : 1;
          const id = this.nextDynamicMemberId++;
          this.dynamicMembers.set(id, {
            id,
            castLib: castLibNum,
            type: lowerType,
            name: "",
            text: "",
          });
          return new LingoMemberProxy({ id, castLib: castLibNum }, this);
        }
        // Director `new script(member(...))` is emitted as `newObj("script", [member])`.
        // Resolve the member to its script name and create the instance via the script creator.
        if (lowerType === "script") {
          let scriptName: string | undefined;
          const firstArg = ctorArgs[0];
          if (firstArg instanceof LingoMemberProxy) {
            scriptName = firstArg.name;
          } else if (firstArg instanceof LingoList && firstArg.count > 0) {
            const item = firstArg.get(1);
            if (item instanceof LingoMemberProxy) {
              scriptName = item.name;
            }
          }
          if (scriptName && this.scriptInstanceCreator) {
            return this.scriptInstanceCreator(`script("${scriptName}")`, []);
          }
          return undefined;
        }
        if (this.scriptInstanceCreator) {
          return this.scriptInstanceCreator(type, ctorArgs);
        }
        return undefined;
      }
      case "new": {
        // Director's bare `new(type, castLib)` constructor uses the same
        // semantics as the emitter's newObj path. In particular, symbol types
        // such as #bitmap/#field create cast members rather than script
        // instances.
        if (isSymbol(args[0]) || args.length > 1) {
          return this.callBuiltin("newObj", args);
        }
        // V4-style `script("Class").new()` supplies a script token string.
        const type = typeof args[0] === "string" ? args[0] : "";
        if (this.scriptInstanceCreator) {
          return this.scriptInstanceCreator(type, []);
        }
        return undefined;
      }
      case "callmethod": {
        const methodName = typeof args[0] === "string" ? args[0] : "";
        const me = args[1];
        const methodArgs = args.slice(2);
        const doCall = (): LingoValue => {
          if (me instanceof LingoMemberProxy && methodName.toLowerCase() === "charpostoloc") {
            const position = Math.max(0, Number(methodArgs[0]) || 0);
            const fontSize = Number(this.getMemberProp(me.token, "fontSize")) || 12;
            return new LingoList([Math.round(position * fontSize * 0.6), 0]);
          }
          if (methodName.toLowerCase() === "handler" && me && typeof me === "object") {
            const requested = methodArgs[0];
            const handlerName = isSymbol(requested) ? requested.name : String(requested ?? "");
            return this.instanceHandlerChecker?.(me as LingoMe, handlerName) ? 1 : 0;
          }
          // `script("Class").new()` path: no instance yet, just a script token string.
          if (methodName === "new" && typeof me === "string" && me.startsWith('script("')) {
            if (this.scriptInstanceCreator) {
              return this.scriptInstanceCreator(me, []);
            }
            return undefined;
          }
          // Script instances in Lingo accept the same PropList mutators as a property
          // list. The transpiler emits `me.setaProp(key, value)` for every script
          // instance property write, but LingoMe doesn't carry the LingoPropList
          // methods, so the call would otherwise be dropped. Route the common
          // PropList builtins through `me.props` so the thread manager's
          // `tThreadObj.setaProp("component", ...)` and friends actually persist.
          if (me && typeof me === "object" && "props" in me) {
            const meAsMe = me as { props: Map<string, LingoValue> };
            const lower = methodName.toLowerCase();
            if (lower === "setaprop" || lower === "setprop") {
              if (methodArgs.length >= 2) {
                setMeProp(me as LingoMe, methodArgs[0], methodArgs[1]);
              }
              return undefined;
            }
            if (lower === "getaprop" || lower === "getprop") {
              if (methodArgs.length >= 1) {
                return meProp(me as LingoMe, methodArgs[0]);
              }
              return undefined;
            }
            if (lower === "deleteprop") {
              if (methodArgs.length >= 1) {
                const key = lingoKeyToString(methodArgs[0]) ?? String(methodArgs[0]);
                meAsMe.props.delete(key);
                const symKey = key.startsWith("#") ? key.slice(1) : `#${key}`;
                meAsMe.props.delete(symKey);
              }
              return undefined;
            }
            if (lower === "addprop") {
              if (methodArgs.length >= 2 && !meAsMe.props.has(lingoKeyToString(methodArgs[0]) ?? String(methodArgs[0]))) {
                meAsMe.props.set(lingoKeyToString(methodArgs[0]) ?? String(methodArgs[0]), methodArgs[1]);
              }
              return undefined;
            }
          }
          if (this.instanceDispatcher && me && typeof me === "object") {
            const scriptName = (me as { props?: Map<string, LingoValue> }).props?.get("__scriptName");
            if (typeof scriptName === "string") {
              const result = this.instanceDispatcher(scriptName, methodName, me as LingoMe, methodArgs);
              // Resource Manager can be queried re-entrantly while its scripted
              // name index is still being constructed. Director's member table is
              // already authoritative at that point, so preserve getmemnum's
              // normal lookup behavior instead of making nested object creation
              // fail transiently.
              if (methodName.toLowerCase() === "getmemnum" && (!result || Number(result) < 1)) {
                const token = this.getMember(methodArgs[0]);
                const number = this.getMemberProp(token, "number");
                if (typeof number === "number" && number > 0) return number;
              }
              if (methodName.toLowerCase() === "getmemnum" && typeof methodArgs[0] === "string") {
                const resolved = this.resolveMember(methodArgs[0], undefined);
                if (resolved) this.pendingExplicitCastLib = resolved.castLib;
              }
              return result;
            }
          }
          if (me && typeof me === "object") {
            const nativeMethod = (me as unknown as Record<string, unknown>)[methodName];
            if (typeof nativeMethod === "function") {
              return (nativeMethod as (...values: LingoValue[]) => LingoValue)
                .apply(me, methodArgs);
            }
          }
          return undefined;
        };
        return doCall();
      }
      case "externalparamvalue":
        return this.getExternalParam(String(args[0] ?? ""));
      case "netdone":
        return netDone(args[0]);
      case "preloadnetthing":
        return preloadNetThing(args[0]);
      case "downloadnetthing":
        // Director's blocking download: start the request and return the net ID. The
        // caller polls netDone(id) until completion, then reads netTextResult(id).
        return getNetText(args[0]);
      case "getnettext":
        return getNetText(args[0]);
      case "postnettext":
        // POST is not implemented; fall back to GET so the network round-trip happens
        // and downstream netTextResult still receives the response body.
        return getNetText(args[0]);
      case "nettexterror":
        return netError(args[0]);
      case "nettextresult":
        return netTextResult(args[0]);
      case "neterror":
        return netError(args[0]);
      case "netabort":
        // No-op: synchronous XHR cannot be aborted in this runtime.
        return undefined;
      case "getstreamstatus":
        return getStreamStatus(args[0]);
      case "gotonetpage":
      case "stopclient":
      case "puppettempo":
      case "movefront":
      case "movetofront":
        return undefined;
      case "castlib": {
        let libNum = Number(args[0] ?? 0);
        if (Number.isNaN(libNum) && typeof args[0] === "string" && this.cast?.castLibraries) {
          const lib = this.cast.castLibraries.find((l) => l.name === args[0]);
          if (lib) {
            libNum = lib.number;
          }
        }
        return new LingoCastLibProxy(libNum);
      }
      case "field":
        return new LingoMemberProxy(this.getMember(args[0] ?? "", args[1]), this);
      case "timeout": {
        const timeoutName = args[0];
        const name = String(timeoutName ?? "");
        const forget = (): void => {
          const existing = this.namedTimeouts.get(name);
          if (existing !== undefined) {
            globalThis.clearTimeout(existing);
            this.namedTimeouts.delete(name);
          }
        };
        return {
          new: (period: LingoValue, handler: LingoValue, target: LingoValue) => {
            const handlerName = isSymbol(handler) ? handler.name : String(handler ?? "");
            forget();
            const timeoutObject = {
              name,
              __timeoutName: timeoutName,
              __lingoObject: true,
              forget,
            } as unknown as LingoValue;
            const timer = globalThis.setTimeout(() => {
              this.namedTimeouts.delete(name);
              this.callBuiltin("callMethod", [handlerName, target, timeoutObject]);
            }, Math.max(0, Number(period) || 0));
            this.namedTimeouts.set(name, timer);
            return timeoutObject;
          },
          forget,
        } as unknown as LingoValue;
      }
      case "timeoutlist":
        return undefined;
      default:
        {
          const dispatched = dispatchValueBuiltin(name, args);
          if (dispatched.handled) return dispatched.value;
        }
        // Browser-incompatible native operations use compatibility no-op semantics.
        if (SUPPORTED_LINGO_BUILTINS.has(lower)) return undefined;
        return undefined;
    }
  }

  /**
   * Apply any pending frame override and return the next frame index (0-based),
   * or `null` when no override was requested. The caller must distinguish these
   * cases because `go(the frame)` sets an override equal to the current frame.
   */
  applyFrameOverride(frameIndex: number): number | null {
    if (this.state.frameIndexOverride !== null) {
      const next = this.state.frameIndexOverride;
      this.state.frameIndexOverride = null;
      return next;
    }
    return null;
  }

  /** Create a `me` object for a behavior instance on the given channel. */
  createMe(channel: number): LingoMe {
    const props = new Map<string, LingoValue>();
    const canonicalKey = (raw: string): string =>
      raw.length > 0 && raw[0] === "#" ? raw.slice(1) : raw;
    const keyFromProp = (prop: string | symbol): string | undefined => {
      if (typeof prop === "string") return canonicalKey(prop);
      if (typeof prop === "symbol") return canonicalKey(prop.description ?? prop.toString());
      if (isSymbol(prop as unknown as LingoValue)) return (prop as unknown as LingoSymbol).name;
      return undefined;
    };
    const ancestorChain = (start: LingoMe): LingoMe[] => {
      const chain: LingoMe[] = [];
      let cur: LingoValue = start;
      const visited = new Set<LingoMe>();
      while (cur && typeof cur === "object" && "props" in cur) {
        const me = cur as LingoMe;
        if (visited.has(me)) break;
        visited.add(me);
        chain.push(me);
        cur = me.props.get("ancestor");
      }
      return chain;
    };
    return new Proxy(
      { spriteNum: channel, props },
      {
        get(target, prop) {
          if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
            return () => `[LingoMe ${target.spriteNum}]`;
          }
          if (prop === "spriteNum") return target.spriteNum;
          if (prop === "props") return target.props;
          const key = keyFromProp(prop);
          if (key === undefined) return undefined;
          for (const me of ancestorChain(target as unknown as LingoMe)) {
            // A declared VOID property still shadows the same property on an
            // ancestor. Map.has distinguishes that from a property which was
            // never declared on this layer.
            if (me.props.has(key)) {
              const value = me.props.get(key);
              return value === undefined || (value as unknown) === LINGO_VOID_SENTINEL
                ? LINGO_VOID
                : value;
            }
          }
          return LINGO_VOID;
        },
        set(target, prop, value) {
          if (prop === "spriteNum") {
            target.spriteNum = value;
            return true;
          }
          const key = keyFromProp(prop);
          if (key === undefined) return false;
          if (value === undefined || value === LINGO_VOID) {
            // Setting a property to VOID deletes it, so ancestor fallback resumes.
            // The sole exception is the special `ancestor` property: Lingo behavior
            // composition uses it to wire instances together, and assigning VOID
            // must not tear down an already-wired ancestor chain (the Thread
            // Manager builds a base object, explicitly sets its ancestor to the
            // thread instance, then later loops over the class list and assigns
            // the previous object -- VOID for the first entry -- which would
            // otherwise destroy the chain).
            if (key === "ancestor") {
              return true;
            }
            // Delete from the nearest ancestor that owns the key; otherwise there
            // is nothing to remove on the leaf.
            for (const me of ancestorChain(target as unknown as LingoMe)) {
              if (me.props.has(key)) {
                me.props.delete(key);
                return true;
              }
            }
            target.props.delete(key);
            return true;
          }
          // Director parent-script semantics: write to the nearest ancestor that
          // already owns the property (e.g. base-class `delays`), otherwise create
          // it on the leaf instance.
          for (const me of ancestorChain(target as unknown as LingoMe)) {
            if (me.props.has(key)) {
              me.props.set(key, value as LingoValue);
              return true;
            }
          }
          target.props.set(key, value as LingoValue);
          return true;
        },
      },
    ) as unknown as LingoMe;
  }
}
