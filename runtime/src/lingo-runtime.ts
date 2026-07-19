// Stage 7: Lingo runtime shim.
//
// This module is the API surface a future TS Lingo execution model (the remaining Stage 7 tail,
// see GOAL.md) will build on. Today it provides the pure value helpers Lingo handlers rely on —
// `integer`/`float` casts with Director's truncation semantics and 1-indexed list / propList
// containers — plus a `LingoNotImplemented` marker thrown by the emitted handler stubs
// (src/scripts/*.ts). The imperative accessors (`sprite`, `member`, `theProperty`, `sound`) are
// deliberately stubs: wiring them to the live ScorePlayer / AudioPlayer / FrameSnapshot is the
// execution work that has not landed, and per docs/rendering-rules.md the runtime must not fake
// C++ behavior, so they throw rather than silently no-op.
//
// No TS Lingo bytecode VM is built (out of scope, see GOAL.md): handlers are emitted as readable
// TS source backed by this shim, not interpreted.

/** Thrown by emitted handler stubs and by accessors whose execution wiring has not landed. */
export class LingoNotImplemented extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LingoNotImplemented";
  }
}

// Lingo values: a number (Director does not split integer/float at the value level — only the
// integer()/float() casts do), a string, a boolean, a list, a propList, or VOID (undefined).
export type LingoValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | number[]
  | LingoList
  | LingoPropList
  | LingoSymbol
  | LingoSpriteProxy
  | LingoMemberProxy
  | LingoImage
  | LingoCastLibProxy
  | LingoMe
  | { readonly id: number | string; readonly castLib?: number | string };

// Director lists are 1-indexed: index 1 is the first element, index 0 and out-of-range access
// are runtime errors (matching Lingo's "index out of range"). This is the container the emitted
// handlers and the future executor use for `[...]` literals and `list(...)` / `add` calls.
export function lingoKeyToString(key: LingoValue): string | undefined {
  let raw: string | undefined;
  if (typeof key === "string") {
    raw = key;
  } else if (typeof key === "number" && Number.isFinite(key)) {
    raw = String(key);
  } else if (typeof key === "symbol") {
    raw = (key as symbol).description ?? (key as symbol).toString();
  } else if (isSymbol(key)) {
    raw = key.name;
  }
  if (raw === undefined) {
    return undefined;
  }
  // Director symbols (e.g. #ancestor) and the string "ancestor" name the same property,
  // so canonicalise by stripping a leading '#'. This also fixes JS bracket-access coercion:
  // `me[symbol("foo")]` reaches the Proxy as the string "#foo" via LingoSymbol's
  // Symbol.toPrimitive, and we must store/lookup under the bare name "foo".
  return raw.length > 0 && raw[0] === "#" ? raw.slice(1) : raw;
}

function lingoValuesEqual(a: LingoValue, b: LingoValue): boolean {
  if (a === b) {
    return true;
  }
  if (isSymbol(a) && isSymbol(b)) {
    return a.name === b.name;
  }
  return a == b;
}

export class LingoList {
  private readonly items: LingoValue[] = [];

  constructor(items: readonly LingoValue[] = []) {
    this.items.push(...items);
    return new Proxy(this, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          return function* () {
            for (const item of target.items) {
              yield item;
            }
          };
        }
        if (typeof prop === "string") {
          if (prop === "length" || prop === "count") {
            return target.count;
          }
          // Lingo scripts use `x.ilk` to query the runtime type of `x` — the transpiler
          // emits `someValue.ilk` as a property access, so the LingoList/LingoPropList proxies
          // must expose `.ilk` as a property that returns the type symbol (e.g. `#list`).
          if (prop === "ilk") {
            return symbol("list");
          }
          const member = (target as unknown as Record<string, unknown>)[prop];
          if (typeof member === "function") {
            return (member as (...a: unknown[]) => unknown).bind(target);
          }
        }
        if (typeof prop === "symbol") {
          return undefined;
        }
        const num = Number(prop);
        if (Number.isInteger(num) && num >= 1 && num <= target.items.length) {
          return target.items[num - 1];
        }
        return undefined;
      },
      set(target, prop, value) {
        if (typeof prop === "symbol") {
          return false;
        }
        const num = Number(prop);
        if (Number.isInteger(num) && num >= 1) {
          target.set(num, value as LingoValue);
          return true;
        }
        return false;
      },
    }) as unknown as LingoList;
  }

  get length(): number {
    return this.items.length;
  }

  get count(): number {
    return this.items.length;
  }

  get(index: number): LingoValue {
    if (!Number.isInteger(index) || index < 1 || index > this.items.length) {
      throw new RangeError(`LingoList index out of range: ${index} (length ${this.items.length})`);
    }
    return this.items[index - 1] as LingoValue;
  }

  set(index: number, value: LingoValue): void {
    if (!Number.isInteger(index) || index < 1) {
      throw new RangeError(`LingoList index out of range: ${index}`);
    }
    while (this.items.length < index - 1) {
      this.items.push(undefined);
    }
    if (index - 1 === this.items.length) {
      this.items.push(value);
    } else {
      this.items[index - 1] = value;
    }
  }

  add(value: LingoValue): void {
    this.items.push(value);
  }

  append(value: LingoValue): void {
    this.items.push(value);
  }

  addAt(index: number, value: LingoValue): void {
    if (!Number.isInteger(index)) {
      return;
    }
    if (index <= 1) {
      this.items.unshift(value);
    } else if (index > this.items.length) {
      this.items.push(value);
    } else {
      this.items.splice(index - 1, 0, value);
    }
  }

  deleteOne(value: LingoValue): void {
    const i = this.items.findIndex((item) => lingoValuesEqual(item, value));
    if (i >= 0) {
      this.items.splice(i, 1);
    }
  }

  getOne(value: LingoValue): number {
    const i = this.items.findIndex((item) => lingoValuesEqual(item, value));
    return i >= 0 ? i + 1 : 0;
  }

  getPos(value: LingoValue): number {
    return this.getOne(value);
  }

  findPos(value: LingoValue): number {
    return this.getOne(value);
  }

  findOne(value: LingoValue): number {
    return this.getOne(value);
  }

  deleteAt(index: number): void {
    if (!Number.isInteger(index) || index < 1 || index > this.items.length) {
      return;
    }
    this.items.splice(index - 1, 1);
  }

  getLast(): LingoValue {
    return this.items.length > 0 ? this.items[this.items.length - 1] : undefined;
  }

  setAt(index: number, value: LingoValue): void {
    this.set(index, value);
  }

  getAt(index: number): LingoValue {
    return this.get(index);
  }

  sort(): this {
    this.items.sort((a, b) => {
      if (typeof a === "number" && typeof b === "number") {
        return a - b;
      }
      return String(a).localeCompare(String(b));
    });
    return this;
  }

  duplicate(): LingoList {
    return new LingoList(this.items.map(duplicate));
  }

  toArray(): LingoValue[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }
}

// A propList is an ordered list of [:symbol: value] pairs (Director's [:a:1, :b:2]). Duplicate
// keys update in place; missing keys read as VOID. Insertion order is preserved for `count` and
// iteration, matching Director's propList semantics.
export class LingoPropList {
  private readonly keys: string[] = [];
  private readonly vals: LingoValue[] = [];

  constructor(initialItems?: readonly LingoValue[] | null) {
    if (Array.isArray(initialItems)) {
      // The transpiler emits `new LingoPropList([[k1, v1], [k2, v2], ...])` — an array of
      // [key, value] pairs. Some call sites also pass a flat [k1, v1, k2, v2, ...] form;
      // accept both by peeking at the first element: if it is itself an array, treat each
      // entry as a pair; otherwise treat the whole array as a flat key/value list.
      const isPairs = initialItems.length > 0 && Array.isArray(initialItems[0]);
      if (isPairs) {
        for (const pair of initialItems) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const k = lingoKeyToString(pair[0] as LingoValue);
          if (k !== undefined) {
            this.keys.push(k);
            this.vals.push(pair[1] as LingoValue);
          }
        }
      } else {
        for (let i = 0; i + 1 < initialItems.length; i += 2) {
          const k = lingoKeyToString(initialItems[i] as LingoValue);
          if (k !== undefined) {
            this.keys.push(k);
            this.vals.push(initialItems[i + 1] as LingoValue);
          }
        }
      }
    }
    return new Proxy(this, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          return function* () {
            for (let i = 0; i < target.keys.length; i++) {
              yield target.vals[i];
            }
          };
        }
        // Numeric indexing — Lingo treats pList[i] as the i-th value (1-based, like
        // LingoList). Director's propList supports both key lookup and index lookup;
        // the transpiler emits `pActiveTasks[i]` for the "i-th entry" form.
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (idx >= 1 && idx <= target.keys.length) {
            return target.vals[idx - 1];
          }
        }
        if (prop === "ilk") {
          return symbol("propList");
        }
        const key = typeof prop === "string" ? prop : lingoKeyToString(prop as unknown as LingoValue);
        if (key !== undefined) {
          if (key === "length" || key === "count") {
            return target.keys.length;
          }
          const stored = target.get(key);
          if (stored !== undefined) {
            return stored;
          }
        }
        const member = (target as unknown as Record<string, unknown>)[prop as string];
        if (typeof member === "function") {
          return (member as (...a: unknown[]) => unknown).bind(target);
        }
        return member;
      },
      set(target, prop, value) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (idx >= 1 && idx <= target.keys.length) {
            target.vals[idx - 1] = value as LingoValue;
            return true;
          }
        }
        const key = typeof prop === "string" ? prop : lingoKeyToString(prop as unknown as LingoValue);
        if (key !== undefined) {
          target.add(key, value as LingoValue);
          return true;
        }
        return false;
      },
    }) as unknown as LingoPropList;
  }

  get length(): number {
    return this.keys.length;
  }

  get count(): number {
    return this.keys.length;
  }

  private normalizeKey(key: LingoValue): string | undefined {
    return lingoKeyToString(key);
  }

  private findKeyIndex(key: LingoValue): number {
    const k = this.normalizeKey(key);
    if (k === undefined) {
      return -1;
    }
    let i = this.keys.indexOf(k);
    if (i >= 0) {
      return i;
    }
    if (isSymbol(key) && k.startsWith("#")) {
      i = this.keys.indexOf(k.slice(1));
      if (i >= 0) {
        return i;
      }
    }
    return -1;
  }

  add(key: LingoValue, value: LingoValue): void {
    const k = this.normalizeKey(key);
    if (k === undefined) {
      return;
    }
    const i = this.keys.indexOf(k);
    if (i >= 0) {
      this.vals[i] = value;
      return;
    }
    this.keys.push(k);
    this.vals.push(value);
  }

  get(key: LingoValue): LingoValue {
    const i = this.findKeyIndex(key);
    if (i < 0) {
      return undefined;
    }
    return this.vals[i] as LingoValue;
  }

  getaProp(key: LingoValue): LingoValue {
    return this.get(key);
  }

  setaProp(key: LingoValue, value: LingoValue): void {
    this.add(key, value);
  }

  deleteProp(key: LingoValue): void {
    const i = this.findKeyIndex(key);
    if (i >= 0) {
      this.keys.splice(i, 1);
      this.vals.splice(i, 1);
    }
  }

  getPropAt(index: number): LingoValue {
    if (!Number.isInteger(index) || index < 1 || index > this.keys.length) {
      return undefined;
    }
    return this.keys[index - 1];
  }

  findPos(key: LingoValue): number {
    const i = this.findKeyIndex(key);
    return i >= 0 ? i + 1 : 0;
  }

  has(key: LingoValue): boolean {
    return this.findKeyIndex(key) >= 0;
  }

  keyAt(index: number): LingoValue {
    if (!Number.isInteger(index) || index < 1 || index > this.keys.length) {
      return undefined;
    }
    return this.keys[index - 1];
  }

  remove(key: LingoValue): void {
    this.deleteProp(key);
  }

  deleteAt(index: number): void {
    if (!Number.isInteger(index) || index < 1 || index > this.keys.length) {
      return;
    }
    this.keys.splice(index - 1, 1);
    this.vals.splice(index - 1, 1);
  }

  sort(): this {
    const pairs = this.keys.map((k, i) => [k, this.vals[i]] as [string, LingoValue]);
    pairs.sort((a, b) => a[0].localeCompare(b[0]));
    this.keys.length = 0;
    this.vals.length = 0;
    for (const [k, v] of pairs) {
      this.keys.push(k);
      this.vals.push(v);
    }
    return this;
  }

  duplicate(): LingoPropList {
    const copy = new LingoPropList();
    for (let i = 0; i < this.keys.length; ++i) {
      copy.add(this.keys[i], duplicate(this.vals[i]));
    }
    return copy;
  }
}

// integer(x): Director truncates toward zero, matching C++ `static_cast<int>` on a double.
// Strings are parsed (leading/trailing whitespace tolerated); unparseable strings yield 0.
export function integer(value: LingoValue): number {
  if (typeof value === "number") {
    return Math.trunc(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

// float(x): promote to a double. Strings are parsed; unparseable strings yield 0.
export function float(value: LingoValue): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// bitAnd(a, b): Director's bitwise AND. Operates on 32-bit signed integers and
// matches the C-style semantics of Lingo's runtime: each operand is coerced to an
// integer (truncating toward zero), the result is the low 32 bits re-interpreted
// as a signed value. VOID operands become 0.
export function bitAnd(a: LingoValue, b: LingoValue): number {
  const ai = integer(a);
  const bi = integer(b);
  return (ai & bi) | 0;
}

// bitOr(a, b): see bitAnd. Director's bitwise OR, 32-bit signed result.
export function bitOr(a: LingoValue, b: LingoValue): number {
  const ai = integer(a);
  const bi = integer(b);
  return (ai | bi) | 0;
}

// bitXor(a, b): see bitAnd. Director's bitwise XOR, 32-bit signed result.
export function bitXor(a: LingoValue, b: LingoValue): number {
  const ai = integer(a);
  const bi = integer(b);
  return (ai ^ bi) | 0;
}

// String(x) in Lingo: VOID -> "VOID", TRUE/FALSE capitalized, lists bracketed.
export function lingoString(value: LingoValue): string {
  if (value === undefined) {
    return "VOID";
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isSymbol(value)) {
    return "#" + value.name;
  }
  if (value instanceof LingoList) {
    return `[${value.toArray().map(lingoString).join(", ")}]`;
  }
  if (value instanceof LingoPropList) {
    if (value.length === 0) {
      return "[:]";
    }
    return "[:]";
  }
  return String(value);
}

// --- Imperative accessor stubs (execution tail) ----------------------------------
// These mark the API surface the emitted Lingo uses to reach into the live player. They throw
// LingoNotImplemented today because wiring them is the Stage 7 execution work; the runtime must
// not pretend to drive the player before that wiring is validated against C++.

// --- Lingo host: the bridge between transpiled TS handlers and the live player -----------

/** Host services the transpiled TS handlers use to mutate the live score/cast/state. */
export interface LingoHost {
  /** Read a sprite property (locH/locV/loc/member/locZ/visible/etc.). */
  getSpriteProp(channel: number, prop: string): LingoValue;
  /** Write a sprite property. */
  setSpriteProp(channel: number, prop: string, value: LingoValue): void;
  /** Look up a cast member by number or name, optionally scoped to a cast lib. Returns a member token. */
  getMember(numOrName: LingoValue, castLib?: LingoValue): LingoValue;
  /** Return the full list of exported cast members (used to resolve numeric script references). */
  getCastMembers(): { id: number; castLib: number; name?: string; type?: string }[];
  /** Read a property of a member token returned by getMember. */
  getMemberProp(member: LingoValue, prop: string): LingoValue;
  /** Write a property of a member token. */
  setMemberProp(member: LingoValue, prop: string, value: LingoValue): void;
  /** Read a global variable. */
  getGlobal(name: string): LingoValue;
  /** Write a global variable. */
  setGlobal(name: string, value: LingoValue): void;
  /** Read a `the <name>` property (the frame, the mouseH, etc.). */
  getThe(name: string): LingoValue;
  /** Write a `the <name>` property. */
  setThe(name: string, value: LingoValue): void;
  /** Push the parameter list for the current handler invocation. */
  pushParams(args: LingoValue[]): void;
  /** Pop the current handler parameter list. */
  popParams(): void;
  /** Read the nth parameter of the current handler (1-indexed). */
  getParam(index: number): LingoValue;
  /** Read an embed parameter supplied to the Shockwave plugin (`externalParamValue`). */
  getExternalParam(name: string): LingoValue;
  /** Call a builtin by name (random, go, marker, point, sendAllSprites, etc.). */
  callBuiltin(name: string, args: LingoValue[]): LingoValue;
  /** Current 1-based frame number. */
  currentFrame(): number;
  /** Navigate to a frame or label. */
  go(target: LingoValue): void;
}

let activeHost: LingoHost | null = null;

/** Set the host that transpiled handlers talk to. The host is set per execution context. */
export function setLingoHost(host: LingoHost | null): void {
  activeHost = host;
}

/** @internal testing hook. */
export function getLingoHost(): LingoHost | null {
  return activeHost;
}

function requireHost(): LingoHost {
  if (!activeHost) {
    throw new LingoNotImplemented(
      "No LingoHost is set — transpiled handlers cannot run without a live player host.",
    );
  }
  return activeHost;
}

/** Returned by `sprite(n)`. Supports both `set the locH of sprite 5 to 100` (transpiled to
 * `sprite(5).locH = 100`) and `the locH of sprite 5` (transpiled to `sprite(5).locH`). */
export class LingoSpriteProxy {
  constructor(
    public readonly num: number,
    public readonly host: LingoHost,
  ) {}

  private getNum(name: string): number {
    return float(this.host.getSpriteProp(this.num, name));
  }

  private setNum(name: string, value: LingoValue): void {
    this.host.setSpriteProp(this.num, name, value);
  }

  get locH(): number { return this.getNum("locH"); }
  set locH(v: LingoValue) { this.setNum("locH", v); }

  get locV(): number { return this.getNum("locV"); }
  set locV(v: LingoValue) { this.setNum("locV", v); }

  get locZ(): number { return this.getNum("locZ"); }
  set locZ(v: LingoValue) { this.setNum("locZ", v); }

  get width(): number { return this.getNum("width"); }
  set width(v: LingoValue) { this.setNum("width", v); }

  get height(): number { return this.getNum("height"); }
  set height(v: LingoValue) { this.setNum("height", v); }

  get visible(): boolean { return !!this.host.getSpriteProp(this.num, "visible"); }
  set visible(v: LingoValue) { this.host.setSpriteProp(this.num, "visible", v); }

  get ink(): number { return this.getNum("ink"); }
  set ink(v: LingoValue) { this.setNum("ink", v); }

  get blend(): number { return this.getNum("blend"); }
  set blend(v: LingoValue) { this.setNum("blend", v); }

  get flipH(): boolean { return !!this.host.getSpriteProp(this.num, "flipH"); }
  set flipH(v: LingoValue) { this.host.setSpriteProp(this.num, "flipH", v); }

  get flipV(): boolean { return !!this.host.getSpriteProp(this.num, "flipV"); }
  set flipV(v: LingoValue) { this.host.setSpriteProp(this.num, "flipV", v); }

  get rotation(): number { return this.getNum("rotation"); }
  set rotation(v: LingoValue) { this.setNum("rotation", v); }

  get skew(): number { return this.getNum("skew"); }
  set skew(v: LingoValue) { this.setNum("skew", v); }

  get member(): LingoValue { return this.host.getSpriteProp(this.num, "member"); }
  set member(v: LingoValue) { this.host.setSpriteProp(this.num, "member", v); }

  get palette(): LingoValue { return this.host.getSpriteProp(this.num, "palette"); }
  set palette(v: LingoValue) { this.host.setSpriteProp(this.num, "palette", v); }

  get cursor(): LingoValue { return this.host.getSpriteProp(this.num, "cursor"); }
  set cursor(v: LingoValue) { this.host.setSpriteProp(this.num, "cursor", v); }

  /** `the loc of sprite n` / `set the loc of sprite n to point(x,y)` */
  get loc(): LingoPointProxy {
    return new LingoPointProxy(
      () => this.locH,
      () => this.locV,
      (v) => { this.locH = v; },
      (v) => { this.locV = v; },
    );
  }
  set loc(v: LingoValue) {
    const p = lingoPointToXY(v);
    this.locH = p.x;
    this.locV = p.y;
  }
}

/** Returned by `member(...)` and by `sprite(...).member`. */
export class LingoMemberProxy {
  constructor(
    public readonly token: LingoValue,
    public readonly host: LingoHost,
  ) {}

  get name(): string {
    const v = this.host.getMemberProp(this.token, "name");
    return typeof v === "string" ? v : lingoString(v);
  }
  set name(v: LingoValue) { this.host.setMemberProp(this.token, "name", v); }

  get number(): number { return Number(this.host.getMemberProp(this.token, "number")) || 0; }

  get text(): LingoValue { return this.host.getMemberProp(this.token, "text"); }
  set text(v: LingoValue) { this.host.setMemberProp(this.token, "text", v); }

  get width(): number { return Number(this.host.getMemberProp(this.token, "width")) || 0; }
  get height(): number { return Number(this.host.getMemberProp(this.token, "height")) || 0; }

  /** Director member types: #bitmap, #field, #text, #script, #sound, etc. */
  get type(): LingoSymbol {
    const v = this.host.getMemberProp(this.token, "type");
    return typeof v === "string" ? symbol(v) : (v as LingoSymbol);
  }

  // The transpiler emits Lingo member properties that collide with JavaScript
  // builtins as `_<name>` (e.g. `member(...)._number`, `member(...)._type`).
  // Wire those aliases to the canonical getters above so script instantiation
  // and type checks resolve correctly.
  get _name(): string { return this.name; }
  set _name(v: LingoValue) { this.name = v; }
  get _number(): number { return this.number; }
  get _text(): LingoValue { return this.text; }
  set _text(v: LingoValue) { this.text = v; }
  get _width(): number { return this.width; }
  get _height(): number { return this.height; }
  get _type(): LingoSymbol { return this.type; }

  /** Director-style string chunk accessors on a text/field member (`tStr.item[1]`). */
  get char(): StringChunkAccessor { return makeStringChunkList(String(this.text ?? ""), "char"); }
  get word(): StringChunkAccessor { return makeStringChunkList(String(this.text ?? ""), "word"); }
  get item(): StringChunkAccessor { return makeStringChunkList(String(this.text ?? ""), "item"); }
  get line(): StringChunkAccessor { return makeStringChunkList(String(this.text ?? ""), "line"); }
}

/** `point(x,y)` proxy used by `sprite(...).loc`. */
class LingoPointProxy {
  constructor(
    private getX: () => number,
    private getY: () => number,
    private setX: (v: LingoValue) => void,
    private setY: (v: LingoValue) => void,
  ) {}
  get x(): number { return this.getX(); }
  set x(v: LingoValue) { this.setX(v); }
  get y(): number { return this.getY(); }
  set y(v: LingoValue) { this.setY(v); }
}

function lingoPointToXY(v: LingoValue): { x: number; y: number } {
  if (v instanceof LingoPointProxy) {
    return { x: v.x, y: v.y };
  }
  if (v instanceof LingoList && v.length >= 2) {
    return { x: float(v.get(1)), y: float(v.get(2)) };
  }
  if (Array.isArray(v) && v.length >= 2) {
    return { x: float(v[0]), y: float(v[1]) };
  }
  return { x: 0, y: 0 };
}

/** `sprite(n)` — returns a live proxy wired to the current host. */
export function sprite(num: number): LingoSpriteProxy {
  return new LingoSpriteProxy(num, requireHost());
}

/** `member(numOrName, castLib?)` — returns a live member proxy. */
export function member(numOrName: LingoValue, castLib?: LingoValue): LingoMemberProxy {
  const host = requireHost();
  return new LingoMemberProxy(host.getMember(numOrName, castLib), host);
}

/** `the <name>` / `the <name> of <obj>` entry point for simple global properties. */
export function theProperty(name: string): LingoValue {
  return requireHost().getThe(name);
}

/** `param(n)` — read the nth parameter passed to the current Lingo handler (1-indexed). */
export function param(index: number): LingoValue {
  return requireHost().getParam(index);
}

/** `set the <name> to <value>` entry point. */
export function setTheProperty(name: string, value: LingoValue): void {
  requireHost().setThe(name, value);
}

/** Call a Lingo builtin through the host. */
export function callBuiltin(name: string, ...args: LingoValue[]): LingoValue {
  return requireHost().callBuiltin(name, args);
}

/** `me` context: property ivars and the spriteNum for behavior instances. */
export interface LingoMe {
  spriteNum: number;
  props: Map<string, LingoValue>;
}

/** Create a `me` object for a behavior instance on a given channel. */
export function createMe(spriteNum: number): LingoMe {
  const props = new Map<string, LingoValue>();
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
    { spriteNum, props },
    {
      get(target, prop) {
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
          return () => `[LingoMe ${target.spriteNum}]`;
        }
        if (prop === "spriteNum") {
          return target.spriteNum;
        }
        if (prop === "props") {
          return target.props;
        }
        const key = typeof prop === "string" ? prop : lingoKeyToString(prop as unknown as LingoValue);
        if (key === undefined) return undefined;
        for (const me of ancestorChain(target as unknown as LingoMe)) {
          if (me.props.has(key)) {
            return me.props.get(key);
          }
        }
        return undefined;
      },
      set(target, prop, value) {
        if (prop === "spriteNum") {
          target.spriteNum = value;
          return true;
        }
        const key = typeof prop === "string" ? prop : lingoKeyToString(prop as unknown as LingoValue);
        if (key === undefined) return false;
        for (const me of ancestorChain(target as unknown as LingoMe)) {
          if (me.props.has(key)) {
            me.props.set(key, value);
            return true;
          }
        }
        target.props.set(key, value);
        return true;
      },
    },
  ) as unknown as LingoMe;
}

/** Property-ivar helper: `property foo` handlers read/write `me.foo`. */
export function meProp(me: LingoMe, name: LingoValue): LingoValue {
  const key = lingoKeyToString(name);
  if (key === undefined) {
    return undefined;
  }
  let cur: LingoValue = me;
  while (cur && typeof cur === "object" && "props" in cur) {
    const props: Map<string, LingoValue> = (cur as { props: Map<string, LingoValue> }).props;
    if (props.has(key)) {
      return props.get(key);
    }
    cur = props.get("ancestor");
  }
  me.props.set(key, undefined);
  return undefined;
}

export function setMeProp(me: LingoMe, name: LingoValue, value: LingoValue): void {
  const key = lingoKeyToString(name);
  if (key !== undefined) {
    me.props.set(key, value);
  }
}

/**
 * Pre-seed a script instance with the declared `property` ivars from its decompiled
 * Lingo source. In Director, declared properties exist on the instance from birth with
 * an initial VOID value, so reads like `me.id` must resolve locally rather than falling
 * back to an ancestor's value. Without this, handlers such as `setID` see an inherited
 * value and refuse to write the instance's own property.
 */
export function seedScriptProps(me: LingoMe, lingoSource: string): void {
  if (!lingoSource) return;
  for (const rawLine of lingoSource.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("property ")) continue;
    let decl = line.slice(9);
    const commentIdx = decl.indexOf("--");
    if (commentIdx >= 0) decl = decl.slice(0, commentIdx);
    const slashIdx = decl.indexOf("//");
    if (slashIdx >= 0) decl = decl.slice(0, slashIdx);
    decl = decl.trim();
    if (!decl) continue;
    for (const rawName of decl.split(",")) {
      const name = rawName.trim();
      if (!name) continue;
      const key = lingoKeyToString(name);
      if (key !== undefined && !me.props.has(key)) {
        me.props.set(key, undefined);
      }
    }
  }
}

const symbolCache = new Map<string, LingoSymbol>();

function canonicalSymbolName(name: string): string {
  return name.length > 0 && name[0] === "#" ? name.slice(1) : name;
}

/** Symbol marker for Lingo `#foo` literals used by `sendAllSprites(#foo, ...)` etc. */
export function symbol(name: string): LingoSymbol {
  // Allow passing an already-symbol value through the canonical cache.
  if (isSymbol(name as unknown as LingoValue)) {
    return symbol((name as unknown as LingoSymbol).name);
  }
  const n = canonicalSymbolName(String(name));
  let s = symbolCache.get(n);
  if (!s) {
    s = {
      __lingoSymbol: true,
      name: n,
      [Symbol.toPrimitive]: (hint: string) => hint === "string" ? "#" + n : n,
    } as LingoSymbol;
    symbolCache.set(n, s);
  }
  return s;
}

export interface LingoSymbol {
  readonly __lingoSymbol: true;
  readonly name: string;
  readonly [Symbol.toPrimitive]: (hint: string) => string;
}

export function isSymbol(value: LingoValue): value is LingoSymbol {
  return typeof value === "object" && value !== null && "__lingoSymbol" in value;
}

/** `the <prop> of <obj>` where the property name is dynamic (e.g. `the text of ...`). */
export function thePropOf(obj: LingoValue, prop: string): LingoValue {
  if (obj instanceof LingoSpriteProxy) {
    return obj.host.getSpriteProp(obj.num, prop);
  }
  if (obj instanceof LingoMemberProxy) {
    return obj.host.getMemberProp(obj.token, prop);
  }
  return undefined;
}

/** `set the <prop> of <obj> to <value>` dynamic setter. */
export function setThePropOf(obj: LingoValue, prop: string, value: LingoValue): void {
  if (obj instanceof LingoSpriteProxy) {
    obj.host.setSpriteProp(obj.num, prop, value);
    return;
  }
  if (obj instanceof LingoMemberProxy) {
    obj.host.setMemberProp(obj.token, prop, value);
    return;
  }
  if (obj instanceof LingoCastLibProxy) {
    if (prop === "name") {
      obj.name = String(value);
    } else if (prop === "fileName" || prop === "filename") {
      obj.fileName = String(value);
    }
    return;
  }
  if (obj !== null && typeof obj === "object" && "props" in obj) {
    setMeProp(obj as LingoMe, prop, value);
    return;
  }
  // Director `the stage` is returned as a plain stage-object proxy; allow Lingo like
  // `(the stage).title = ...` to set properties on it directly.
  if (
    obj !== null &&
    typeof obj === "object" &&
    (obj as { name?: string }).name === "stage" &&
    "rect" in obj &&
    "image" in obj
  ) {
    (obj as Record<string, LingoValue>)[prop] = value;
    return;
  }
}

/** Variable reference placeholder (rare in source emission). */
export function varRef(_name: string): LingoValue {
  return undefined;
}

/** True when `me` is the Object Manager Class instance used by get*Manager helpers. */
function isObjectManagerMe(me: LingoValue): boolean {
  return (
    me !== null &&
    typeof me === "object" &&
    !Array.isArray(me) &&
    !isSymbol(me) &&
    "props" in me &&
    (me as LingoMe).props?.get("__scriptName") === "Object Manager Class"
  );
}

function isManagerId(id: LingoValue): boolean {
  const n = isSymbol(id) ? id.name : typeof id === "string" ? id : "";
  return n.endsWith("_manager");
}

/**
 * Bootstrap fallback for `managerExists` on the Object Manager Class.
 * Director's synchronous object creation means a manager instance can already be
 * stored in pObjectList before createManager() has moved it to pManagerList.
 * If getVariableManager()/getBrokerManager()/etc. are called during that window,
 * the native managerExists-only check sees the manager as missing and tries to
 * construct it again, causing infinite recursion. Treat pObjectList membership
 * as sufficient for manager IDs to break the cycle.
 */
function propListHasKey(pl: LingoPropList | undefined, key: LingoValue): boolean {
  if (!pl) {
    return false;
  }
  return pl.getaProp(key) !== undefined;
}

/**
 * Returns true if the entry registered in pObjectList under `tID` is an
 * already-constructed manager (not the bare `pBaseClsMem` placeholder that
 * Object Manager::create() stores while the inheritance chain is still being
 * built). Placeholders carry `__scriptName === "Object Base Class"`; a
 * real manager has the class name from the tClassList tail.
 */
function isRealManagerEntry(pObjectList: LingoPropList | undefined, tID: LingoValue): boolean {
  if (!pObjectList) {
    return false;
  }
  const entry = pObjectList.getaProp(tID);
  if (!entry || typeof entry !== "object" || !("props" in entry)) {
    return false;
  }
  const name = (entry as LingoMe).props?.get("__scriptName");
  return typeof name === "string" && name !== "Object Base Class";
}

function bootstrapManagerExists(me: LingoMe, tID: LingoValue): LingoValue {
  const pManagerList = me.props.get("pManagerList") as LingoList | undefined;
  const pObjectList = me.props.get("pObjectList") as LingoPropList | undefined;
  if (pManagerList && pManagerList.getOne(tID) !== 0) {
    return 1;
  }
  if (isRealManagerEntry(pObjectList, tID)) {
    return 1;
  }
  return 0;
}

/** Bootstrap fallback for `getManager` — return the mid-construction instance from pObjectList. */
function bootstrapGetManager(me: LingoMe, tID: LingoValue): LingoValue {
  const pManagerList = me.props.get("pManagerList") as LingoList | undefined;
  const pObjectList = me.props.get("pObjectList") as LingoPropList | undefined;
  const inMgr = pManagerList ? pManagerList.getOne(tID) !== 0 : false;
  if (inMgr || isRealManagerEntry(pObjectList, tID)) {
    return pObjectList ? pObjectList.getaProp(tID) : undefined;
  }
  return undefined;
}

/** Object method call used by the transpiler for V4-style `obj.handler(args)`. */
const diagCallMethodNames = new Set(["preIndexMembers", "dump", "updateState", "create"]);

export function callMethod(name: string, ...args: LingoValue[]): LingoValue {
  if (args.length > 0) {
    const me = args[0];
    if (me !== null && typeof me === "object") {
      const fn = (me as Record<string, unknown>)[name];
      if (typeof fn === "function") {
        const diag = diagCallMethodNames.has(name);
        if (diag) {
          // eslint-disable-next-line no-console
          console.warn(`[diag-callMethod] ENTER ${name} me=${diagObjectDescriptor(me)}`);
        }
        try {
          const result = (fn as (...a: unknown[]) => unknown).apply(me, args.slice(1)) as LingoValue;
          if (diag) {
            // eslint-disable-next-line no-console
            console.warn(`[diag-callMethod] EXIT ${name} result=${result}`);
          }
          return result;
        } catch (e) {
          if (diag) {
            // eslint-disable-next-line no-console
            console.warn(`[diag-callMethod] THROW ${name} error=${e}`);
          }
          throw e;
        }
      }
      if (name === "removeActiveTask" || name === "importFileToCast" || name === "setaProp" || name === "updateState" || name === "Activate" || name === "addCallBack" || name === "deconstruct" || name === "update" || name === "deleteAt" || name === "add" || name === "getProperty" || name === "startCastLoad") {
        // eslint-disable-next-line no-console
        console.warn(`[diag-callMethod] name=${name} meType=${typeof me} hasProps=${"props" in (me as object)} scriptName=${(me as { props?: { get?: (k: string) => unknown } }).props?.get?.("__scriptName") ?? "?"} fnType=${typeof fn}`);
      }
      if (name === "removeActiveTask" && (me as { props?: { get?: (k: string) => unknown } }).props?.get?.("__scriptName") === "Download Manager Class") {
        // eslint-disable-next-line no-console
        console.warn(`[diag-callMethod-DM] ENTER removeActiveTask via callMethod fallback`);
      }
      // Bootstrap fix: managers may be re-entered while their instance is already
      // in pObjectList but not yet moved to pManagerList. Treat pObjectList
      // membership as sufficient for managerExists / getManager so helpers such as
      // getVariableManager() do not attempt to construct a manager twice.
      if ((name === "managerExists" || name === "getManager") && isObjectManagerMe(me) && isManagerId(args[1])) {
        const result = name === "managerExists"
          ? bootstrapManagerExists(me as LingoMe, args[1])
          : bootstrapGetManager(me as LingoMe, args[1]);
        if (result !== undefined) {
          return result;
        }
      }
    }
  }
  const host = getLingoHost();
  if (host) {
    return host.callBuiltin("callMethod", [name, ...args]);
  }
  return undefined;
}

/** `new(<type>, args)` constructor helper. */
export function newObj(type: string, args: LingoValue): LingoValue {
  const host = getLingoHost();
  if (host) {
    return host.callBuiltin("newObj", [type, args]);
  }
  return undefined;
}

/** `script("ClassName")` or `script(memberNum)` — returns the instance-creation token used by `new(...)`. */
export function script(nameOrNum: LingoValue): string {
  let resolved: string;
  if (typeof nameOrNum === "number") {
    try {
      const host = getLingoHost();
      const members = host?.getCastMembers?.() ?? [];
      let scriptName = "";
      for (const m of members) {
        if (m.id === nameOrNum && m.type === "script" && m.name) {
          scriptName = m.name;
          break;
        }
      }
      resolved = scriptName || member(nameOrNum).name;
    } catch {
      resolved = String(nameOrNum);
    }
  } else if (isSymbol(nameOrNum)) {
    resolved = nameOrNum.name;
  } else if (typeof nameOrNum === "string") {
    resolved = nameOrNum;
  } else {
    resolved = lingoValueToString(nameOrNum);
  }
  return `script("${resolved}")`;
}

/** `sprite a intersects sprite b` */
export function spriteIntersects(_a: LingoValue, _b: LingoValue): boolean {
  return false;
}

/** `sprite a within sprite b` */
export function spriteWithin(_a: LingoValue, _b: LingoValue): boolean {
  return false;
}

/** Global variable read. */
export function globalVar(name: string): LingoValue {
  return requireHost().getGlobal(name);
}

/** Global variable write. */
export function setGlobal(name: string, value: LingoValue): void {
  requireHost().setGlobal(name, value);
}

// --- Lingo string chunk helpers ------------------------------------------------

let itemDelimiter = ",";

/** Set the `the itemDelimiter` value used by item chunk operations. */
export function setItemDelimiter(delimiter: string): void {
  itemDelimiter = (typeof delimiter === "string" && delimiter.length > 0) ? delimiter : ",";
}

/** Read the current `the itemDelimiter`. */
export function getItemDelimiter(): string {
  return itemDelimiter;
}

function lingoValueToString(value: LingoValue): string {
  if (value instanceof LingoMemberProxy) {
    const v = value.text;
    return v === undefined || v === null ? "" : lingoString(v);
  }
  return lingoString(value);
}

/** Alias used by the host when a Lingo value needs to be forced to a string. */
export function _string(value: LingoValue): string {
  return lingoValueToString(value);
}

function chunkTypeName(type: string): string {
  return type.toLowerCase();
}

class StringChunkAccessor {
  private readonly parts: string[];
  private readonly type: string;

  constructor(value: string, type: string) {
    this.parts = splitChunks(value, type);
    this.type = type;
    return new Proxy(this, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          return function* () {
            for (const part of target.parts) {
              yield part;
            }
          };
        }
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
          return () => joinChunks(target.parts, target.type);
        }
        if (prop === "count" || prop === "length") {
          return target.parts.length;
        }
        if (prop === "range") {
          return target.range.bind(target);
        }
        const num = Number(prop);
        if (Number.isInteger(num)) {
          return num >= 1 && num <= target.parts.length ? target.parts[num - 1] : "";
        }
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    }) as unknown as StringChunkAccessor;
  }

  range(first: LingoValue, last: LingoValue): string {
    const a = integer(first);
    let b = integer(last);
    if (a < 1 || b < a) {
      return "";
    }
    if (b > this.parts.length) {
      b = this.parts.length;
    }
    return joinChunks(this.parts.slice(a - 1, b), this.type);
  }

  toString(): string {
    return joinChunks(this.parts, this.type);
  }
}

function makeStringChunkList(value: string, type: string): StringChunkAccessor {
  return new StringChunkAccessor(value, type);
}

function splitChunks(value: string, type: string): string[] {
  switch (chunkTypeName(type)) {
    case "char":
      return value === "" ? [] : Array.from(value);
    case "word":
      return value.trim() === "" ? [] : value.trim().split(/\s+/);
    case "item":
      return value === "" ? [] : value.split(itemDelimiter);
    case "line":
      return value === "" ? [] : value.split(/\r?\n/);
    default:
      return [value];
  }
}

function joinChunks(parts: string[], type: string): string {
  switch (chunkTypeName(type)) {
    case "char":
      return parts.join("");
    case "word":
      return parts.join(" ");
    case "item":
      return parts.join(itemDelimiter);
    case "line":
      return parts.join("\n");
    default:
      return parts.join("");
  }
}

/** `char 1 of s`, `item 2 to 4 of s`, `line figure of field f`, etc. */
export function chunkOf(
  value: LingoValue,
  type?: string,
  first?: LingoValue,
  last?: LingoValue,
): LingoValue {
  const s = lingoValueToString(value);
  if (!type) {
    return s;
  }
  const a = first === undefined ? 1 : integer(first);
  const b = last === undefined ? a : integer(last);
  if (a < 1 || b < a) {
    return "";
  }
  const parts = splitChunks(s, type);
  if (a > parts.length) {
    return "";
  }
  return joinChunks(parts.slice(a - 1, b), type);
}

/** `the number of chars/words/items/lines in s`. */
export function chunkCount(value: LingoValue, type: string): number {
  return splitChunks(lingoValueToString(value), type).length;
}

/** `the last char/word/item/line of s`. */
export function lastChunk(value: LingoValue, type: string): LingoValue {
  const parts = splitChunks(lingoValueToString(value), type);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/** `chars(value, first, last)` — Director-style character range. */
export function chars(value: LingoValue, first: LingoValue, last: LingoValue): string {
  return String(chunkOf(value, "char", first, last));
}

/** `delete chunk of string` — no-op stub for the old transpiler emit. */
export function deleteChunk(_value: LingoValue): void {
  // Chunk deletion (e.g. `delete char 1 of data`) is not yet ported.
}

/** `deleteStringChunk(source, type, first, last?)` — Director-style chunk deletion.
 *  Returns a new string with the chunk `first..last` (1-based, inclusive) removed.
 *  Used by the transpiled `delete <chunk> of <var>` statement.
 */
export function deleteStringChunk(
  source: LingoValue,
  type: LingoValue,
  first: LingoValue,
  last?: LingoValue,
): string {
  const s = lingoValueToString(source);
  const t = lingoValueToString(type);
  const a = integer(first);
  const b = last === undefined ? a : integer(last);
  if (a < 1 || b < a) {
    return s;
  }
  const parts = splitChunks(s, t);
  if (a > parts.length) {
    return s;
  }
  const before = parts.slice(0, a - 1);
  const after = parts.slice(b);
  return joinChunks(before.concat(after), t);
}

// Install Director-style chunk accessors on JavaScript strings so emitted Lingo like
// `tMsg.line[1]` and `tObject.word.count` work without re-wiring every string literal.
// This is global because the transpiler emits bare string literals and string() results.
try {
  const defineChunk = (name: string, type: string) => {
    Object.defineProperty(String.prototype, name, {
      configurable: true,
      get(this: string) {
        return makeStringChunkList(String(this), type);
      },
    });
  };
  defineChunk("char", "char");
  defineChunk("word", "word");
  defineChunk("item", "item");
  defineChunk("line", "line");
} catch {
  // Ignore environments where String.prototype is sealed.
}

/** `length(value)` — number of characters in a string, or count of a list. */
export function length(value: LingoValue): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value instanceof LingoList || value instanceof LingoPropList || Array.isArray(value)) {
    return value.length;
  }
  return 0;
}

/** `charToNum(s)` — ASCII code of the first character (0 for empty). */
export function charToNum(value: LingoValue): number {
  const s = lingoValueToString(value);
  return s.length > 0 ? s.charCodeAt(0) : 0;
}

/** `numToChar(n)` — character from a Unicode code point. */
export function numToChar(value: LingoValue): string {
  const n = integer(value);
  if (n < 0 || n > 0x10FFFF) {
    return "";
  }
  return String.fromCodePoint(n);
}

/** `add value to list` — append to a LingoList or array. */
export function add(list: LingoValue, value: LingoValue): void {
  if (list instanceof LingoList) {
    list.add(value);
  } else if (Array.isArray(list)) {
    (list as LingoValue[]).push(value);
  }
}

/** `getPropAt(list, index)` — return the key at position `index` in a propList. */
export function getPropAt(list: LingoValue, index: LingoValue): LingoValue {
  const i = integer(index);
  if (list instanceof LingoPropList) {
    return list.keyAt(i);
  }
  if (Array.isArray(list)) {
    return (list as LingoValue[])[i - 1];
  }
  return undefined;
}

function normalizeString(value: LingoValue): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).toLowerCase();
}

/** Lingo `haystack contains needle` — case-insensitive substring test. */
export function contains(haystack: LingoValue, needle: LingoValue): boolean {
  return normalizeString(haystack).includes(normalizeString(needle));
}

/** Lingo `haystack starts needle` — case-insensitive prefix test. */
export function starts(haystack: LingoValue, needle: LingoValue): boolean {
  return normalizeString(haystack).startsWith(normalizeString(needle));
}

/** Menu / sound property helpers — stubs. */
export function menuProp(_menu: LingoValue, _prop: number): LingoValue { return undefined; }
export function menuItemProp(_menu: LingoValue, _item: LingoValue, _prop: number): LingoValue { return undefined; }
export function soundProp(_sound: LingoValue, _prop: number): LingoValue { return undefined; }

// --- Transpiler-emitted helpers -------------------------------------------------

/** Alias for the transpiler's `new(...)` calls. */
export const _new = newObj;

/** Alias for the transpiler's internal symbol constructor. */
export const _symbol = symbol;

// --- Common Lingo utility builtins (stubs that keep handlers running) ----------

export function voidp(value: LingoValue): boolean {
  return value === undefined || value === null;
}

export function listp(value: LingoValue): boolean {
  return value instanceof LingoList || value instanceof LingoPropList || Array.isArray(value);
}

export function stringp(value: LingoValue): boolean {
  return typeof value === "string";
}

export function integerp(value: LingoValue): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

export function floatp(value: LingoValue): boolean {
  return typeof value === "number" && !Number.isInteger(value);
}

export function symbolp(value: LingoValue): boolean {
  return isSymbol(value);
}

export function count(value: LingoValue): number {
  if (value instanceof LingoList || value instanceof LingoPropList) {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  return 0;
}

export function getAt(value: LingoValue, index: LingoValue): LingoValue {
  const i = integer(index);
  if (typeof value === "string") {
    return i >= 1 && i <= value.length ? value[i - 1] : "";
  }
  if (value instanceof LingoList) {
    return value.get(i);
  }
  if (Array.isArray(value)) {
    return value[i - 1];
  }
  return undefined;
}

export function setAt(value: LingoValue, index: LingoValue, item: LingoValue): void {
  const i = integer(index);
  if (value instanceof LingoList) {
    value.set(i, item);
  } else if (Array.isArray(value)) {
    (value as LingoValue[])[i - 1] = item;
  }
}

export function keyName(key: LingoValue): string | null {
  if (typeof key === "string") {
    return key;
  }
  if (isSymbol(key)) {
    return key.name;
  }
  return null;
}

export function getProp(value: LingoValue, key: LingoValue): LingoValue {
  const name = keyName(key);
  if (name === null) {
    return undefined;
  }
  if (value instanceof LingoPropList) {
    return value.get(name);
  }
  if (typeof value === "object" && value !== null && name in value) {
    return (value as Record<string, LingoValue>)[name];
  }
  return undefined;
}

export function getaProp(value: LingoValue, key: LingoValue): LingoValue {
  return getProp(value, key);
}

export function addProp(list: LingoValue, key: LingoValue, value?: LingoValue): void {
  if (list instanceof LingoList) {
    list.add(value ?? key);
    return;
  }
  const name = keyName(key);
  if (name !== null && list instanceof LingoPropList) {
    list.add(name, value ?? undefined);
  }
}

export function deleteProp(list: LingoValue, key: LingoValue): void {
  const name = keyName(key);
  if (name !== null && list instanceof LingoPropList) {
    list.remove(name);
  }
}

export function setProp(list: LingoValue, key: LingoValue, value?: LingoValue): void {
  const name = keyName(key);
  if (name === null) {
    return;
  }
  if (list instanceof LingoPropList) {
    list.add(name, value ?? undefined);
    return;
  }
  if (typeof list === "object" && list !== null) {
    (list as Record<string, LingoValue>)[name] = value ?? undefined;
  }
}

/** Alias for `setProp` used by the transpiler for `setaProp(list, key, value)`. */
export function setaProp(list: LingoValue, key: LingoValue, value?: LingoValue): void {
  setProp(list, key, value);
}

/** `addAt(list, index, value)` — insert into a LingoList. */
export function addAt(list: LingoValue, index: LingoValue, value: LingoValue): void {
  if (list instanceof LingoList) {
    list.addAt(integer(index), value);
  }
}

/** `append(list, value)` — append to a LingoList. */
export function append(list: LingoValue, value: LingoValue): void {
  if (list instanceof LingoList) {
    list.append(value);
  }
}

/** `deleteAt(list, index)` — remove a LingoList element by 1-based index. */
export function deleteAt(list: LingoValue, index: LingoValue): void {
  if (list instanceof LingoList) {
    list.deleteAt(integer(index));
  }
}

/** `getLast(list)` — return the last element of a LingoList. */
export function getLast(list: LingoValue): LingoValue {
  if (list instanceof LingoList) {
    return list.getLast();
  }
  return undefined;
}

/** `getOne(list, value)` / `getPos(list, value)` / `findPos(list, value)`. */
export function getOne(list: LingoValue, value: LingoValue): number {
  if (list instanceof LingoList) {
    return list.getOne(value);
  }
  return 0;
}
export function getPos(list: LingoValue, value: LingoValue): number {
  return getOne(list, value);
}
export function findPos(list: LingoValue, value: LingoValue): number {
  return getOne(list, value);
}

/** `sendSprite(channel, #symbol, ...)` — dispatch a symbol handler on a sprite channel. */
export function sendSprite(channel: LingoValue, sym: LingoValue, ...args: LingoValue[]): LingoValue {
  const host = getLingoHost();
  if (host) {
    return host.callBuiltin("sendSprite", [channel, sym, ...args]);
  }
  return undefined;
}

/** `put <expr>` statement helper — no-op in the browser runtime. */
export function put(..._values: LingoValue[]): void {
  // No-op; mirrors Director's debug-output `put`.
}

// --- Common Lingo value builtins -----------------------------------------------

/** `duplicate(value)` — deep copy for LingoList / LingoPropList, identity otherwise. */
export function duplicate(value: LingoValue): LingoValue {
  if (value instanceof LingoList) {
    return new LingoList(value.toArray().map(duplicate));
  }
  if (value instanceof LingoPropList) {
    const copy = new LingoPropList();
    for (let i = 1; i <= value.length; i++) {
      const key = value.keyAt(i);
      if (typeof key === "string") {
        copy.add(key, duplicate(value.get(key)));
      }
    }
    return copy;
  }
  return value;
}

/** `sort(list)` — sort a list or propList in place. */
export function sort(list: LingoValue): void {
  if (list instanceof LingoList) {
    const arr = list.toArray();
    arr.sort((a, b) => {
      if (typeof a === "number" && typeof b === "number") return a - b;
      return String(a).localeCompare(String(b));
    });
    list.clear();
    for (const item of arr) list.add(item);
  } else if (list instanceof LingoPropList) {
    const entries: [string, LingoValue][] = [];
    for (let i = 1; i <= list.length; i++) {
      const key = list.keyAt(i);
      if (typeof key === "string") {
        entries.push([key, list.get(key)]);
      }
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k, v] of entries) list.add(k, v);
  }
}

/** `paletteIndex(n)` — stub; returns the index unchanged. */
export function paletteIndex(value: LingoValue): LingoValue {
  return value;
}

/** `rect(left, top, right, bottom)` — Director's 1-based rectangle value. */
export function rect(
  left: LingoValue,
  top: LingoValue,
  right: LingoValue,
  bottom: LingoValue,
): LingoList {
  return new LingoList([float(left), float(top), float(right), float(bottom)]);
}

/** Minimal mutable Director image value used by dynamically-built UI buffers. */
export class LingoImage {
  public paletteRef: LingoValue;

  constructor(
    public width: number,
    public height: number,
    public depth: number,
    paletteRef?: LingoValue,
  ) {
    this.paletteRef = paletteRef;
  }

  get rect(): LingoList {
    return rect(0, 0, this.width, this.height);
  }

  duplicate(): LingoImage {
    return new LingoImage(this.width, this.height, this.depth, this.paletteRef);
  }

  setPixel(_x: LingoValue, _y: LingoValue, _color: LingoValue): void {}
  copyPixels(..._args: LingoValue[]): void {}
  draw(..._args: LingoValue[]): void {}
  trimWhiteSpace(): LingoImage { return this; }
}

/** `image(width, height, depth[, palette])`. */
export function image(
  width: LingoValue,
  height: LingoValue,
  depth: LingoValue,
  paletteRef?: LingoValue,
): LingoImage {
  return new LingoImage(integer(width), integer(height), integer(depth), paletteRef);
}

/** `ilk(value)` — return a symbol describing the Lingo type of a value. */
export function ilk(value: LingoValue, expectedType?: LingoValue): LingoSymbol | boolean {
  let typeName: string;
  if (value === undefined || value === null) {
    typeName = "void";
  } else if (isSymbol(value)) {
    typeName = "symbol";
  } else if (typeof value === "string") {
    typeName = "string";
  } else if (typeof value === "number") {
    typeName = Number.isInteger(value) ? "integer" : "float";
  } else if (typeof value === "boolean") {
    typeName = "integer";
  } else if (value instanceof LingoList || Array.isArray(value)) {
    typeName = "list";
  } else if (value instanceof LingoPropList) {
    typeName = "propList";
  } else if (value instanceof LingoSpriteProxy) {
    typeName = "sprite";
  } else if (value instanceof LingoMemberProxy) {
    typeName = "member";
  } else if (typeof value === "object") {
    typeName = "instance";
  } else {
    typeName = "void";
  }
  if (expectedType !== undefined) {
    const expected = isSymbol(expectedType) ? expectedType.name : String(expectedType);
    return typeName === expected;
  }
  return symbol(typeName);
}

function diagObjectDescriptor(value: LingoValue): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return typeof value;
  const rec = value as Record<string, unknown>;
  if ("__scriptName" in rec) return String(rec.__scriptName);
  const props = (value as { props?: Map<string, unknown> }).props;
  if (props?.has("__scriptName")) return String(props.get("__scriptName"));
  if ("id" in rec) return String(rec.id);
  return (value as object).constructor?.name ?? "object";
}

/** `call(#handler, targetOrList, ...args)` — dispatch a handler to one or more objects. */
export function call(handler: LingoValue, target: LingoValue, ...args: LingoValue[]): LingoValue {
  const name = isSymbol(handler) ? handler.name : typeof handler === "string" ? handler : "";
  if (name === "assetDownloadCallbacks") {
    // eslint-disable-next-line no-console
    console.warn(`[diag-call] name=${name} targetType=${target === null ? "null" : typeof target} targetIsObject=${target && typeof target === "object"} targetHasProps=${target && typeof target === "object" && "props" in target} argCount=${args.length}`);
  }
  if (target instanceof LingoList) {
    const results: LingoValue[] = [];
    for (let i = 1; i <= target.count; i++) {
      const item = target.get(i);
      if (name === "prepare" || name === "update") {
        // eslint-disable-next-line no-console
        console.warn(`[diag-call] ${name} #${i}/${target.count} obj=${diagObjectDescriptor(item)}`);
      }
      results.push(callMethod(name, item, ...args));
    }
    return new LingoList(results);
  }
  if (target instanceof LingoPropList) {
    // Director treats a propList the same as a list for `call` — iterate the values
    // and dispatch the handler to each. This is how the Download Manager calls
    // `call(#update, pActiveTasks)` where pActiveTasks is a propList of task names.
    const results: LingoValue[] = [];
    for (let i = 1; i <= target.count; i++) {
      const value = target.get(target.getPropAt(i));
      if (value === undefined) continue;
      if (name === "prepare" || name === "update") {
        // eslint-disable-next-line no-console
        console.warn(`[diag-call] ${name} propList #${i}/${target.count} obj=${diagObjectDescriptor(value)}`);
      }
      results.push(callMethod(name, value, ...args));
    }
    return new LingoList(results);
  }
  if (Array.isArray(target)) {
    const results: LingoValue[] = [];
    for (const item of target) {
      results.push(callMethod(name, item, ...args));
    }
    return new LingoList(results);
  }
  return callMethod(name, target, ...args);
}

/** `space()` — return a single space character. */
export function space(): string {
  return " ";
}

/** `offset(needle, haystack)` — 1-based index of the first occurrence, or 0. */
export function offset(needle: LingoValue, haystack: LingoValue): number {
  const n = typeof needle === "string" ? needle : String(needle ?? "");
  const h = typeof haystack === "string" ? haystack : String(haystack ?? "");
  const idx = h.indexOf(n);
  return idx >= 0 ? idx + 1 : 0;
}

/** `_try()` / `_catch()` — no-op markers emitted for Lingo `try ... catch` blocks. */
export function _try(): number {
  return 1;
}

export function _catch(): number {
  return 1;
}

/** `stopMovie()` — halt frame advancement. */
export function stopMovie(): void {
  const host = getLingoHost();
  if (host) {
    host.go("stop");
  }
}

/** `timeout(name)` — no-op stub; returns a token with a `new` method. */
export function timeout(name: LingoValue): { new: (_period: LingoValue, _handler: LingoValue, _target: LingoValue) => LingoValue } {
  return {
    new: (_period, _handler, _target) => {
      return { __timeoutName: name, __lingoObject: true } as unknown as LingoValue;
    },
  };
}

/** `rgb(r, g, b)` — create a simple colour token with a hexString method. */
export function rgb(r: LingoValue, g: LingoValue, b: LingoValue): LingoValue {
  const red = Math.max(0, Math.min(255, integer(r)));
  const green = Math.max(0, Math.min(255, integer(g)));
  const blue = Math.max(0, Math.min(255, integer(b)));
  const hex = ((red << 16) | (green << 8) | blue).toString(16).padStart(6, "0").toUpperCase();
  return {
    red,
    green,
    blue,
    hexString: () => hex,
  } as unknown as LingoValue;
}

/** `date()` — return the current local date as a Lingo-style string. */
export function date(): string {
  const now = new Date();
  return `${now.getDate()}.${now.getMonth() + 1}.${now.getFullYear()}`;
}

/** `time()` — return the current local time as a Lingo-style string. */
export function time(): string {
  const now = new Date();
  return `${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}`;
}

/** `abs(n)` — absolute value. */
export function abs(value: LingoValue): number {
  return Math.abs(float(value));
}

/** `sqrt(n)` — square root. */
export function sqrt(value: LingoValue): number {
  return Math.sqrt(float(value));
}

/** `atan(n)` — arctangent in radians. */
export function atan(value: LingoValue): number {
  return Math.atan(float(value));
}

/** `power(a, b)` — `a` raised to the `b`-th power, Lingo's `power()`. */
export function power(a: LingoValue, b: LingoValue): number {
  return Math.pow(float(a), float(b));
}

/** `pi` — π. Lingo exposes this as a parameterless function. */
export function pi(): number {
  return Math.PI;
}

/** `min(...args)` — smallest of the given numbers. */
export function min(...args: LingoValue[]): number {
  if (args.length === 0) return 0;
  return Math.min(...args.map((a) => float(a)));
}

/** `max(...args)` — largest of the given numbers. */
export function max(...args: LingoValue[]): number {
  if (args.length === 0) return 0;
  return Math.max(...args.map((a) => float(a)));
}

/** `sin(n)` — sine in radians. */
export function sin(value: LingoValue): number {
  return Math.sin(float(value));
}

/** `cos(n)` — cosine in radians. */
export function cos(value: LingoValue): number {
  return Math.cos(float(value));
}

/** `tan(n)` — tangent in radians. */
export function tan(value: LingoValue): number {
  return Math.tan(float(value));
}

/** `randomFloat()` — random float in [0, 1). */
export function randomFloat(): number {
  return Math.random();
}

// --- Director builtins exposed as direct global calls ----------------------------

/** `castLib(n)` proxy returned by `castLib(n)`. Reads and writes the host's
 * `castlibs` registry so the castload manager's `castLib(n).name = ...` calls
 * land in the same place as the eager loader's `registerCastlib`. The host
 * owns the authoritative state; this proxy is a thin view. */
export class LingoCastLibProxy {
  constructor(public readonly num: number) {}

  get fileName(): string {
    const host = getLingoHost();
    if (!host) return "";
    // The host's `castLibFileName` reads the registry; fall back to "" if the
    // castlib has not been registered yet.
    return (host as { castLibFileName?: (n: number) => string }).castLibFileName?.(this.num) ?? "";
  }

  set fileName(value: string) {
    const host = getLingoHost();
    if (!host) return;
    (host as { setCastlibFileName?: (n: number, v: string) => void }).setCastlibFileName?.(this.num, String(value));
  }

  get name(): string {
    const host = getLingoHost();
    if (!host) return "";
    return (host as { castLibName?: (n: number) => string }).castLibName?.(this.num) ?? "";
  }

  set name(value: string) {
    const host = getLingoHost();
    if (!host) return;
    (host as { setCastlibName?: (n: number, v: string) => void }).setCastlibName?.(this.num, String(value));
  }
}

/** `castLib(n)` — returns a cast-library token. */
export function castLib(num: number): LingoCastLibProxy {
  return new LingoCastLibProxy(num);
}

/** `field(nameOrNum, castLib?)` — look up a field/text cast member. */
export function field(numOrName?: LingoValue, castLib?: LingoValue): LingoMemberProxy {
  const host = requireHost();
  return new LingoMemberProxy(host.getMember(numOrName ?? "", castLib), host);
}

/** `go(target)` — frame/label navigation. */
export function go(target: LingoValue): void {
  const host = getLingoHost();
  if (host) {
    host.go(target);
  }
}

/** `netAbort(id)` — no-op in the static runtime. */
export function netAbort(_id: LingoValue): void {
  // No-op.
}

/** `gotoNetPage(url)` — no-op in the static runtime. */
export function gotoNetPage(_url: LingoValue): void {
  // No-op.
}

/** `stopClient()` — no-op in the static runtime. */
export function stopClient(): void {
  // No-op.
}

/** `puppetTempo(tempo)` — no-op in the static runtime. */
export function puppetTempo(_tempo: LingoValue): void {
  // No-op.
}

/** `cursor(cursorNum)` / `cursor(memberRef)` — no-op in the static runtime. */
export function cursor(_cursor: LingoValue): number {
  return 1;
}

/** `puppetSprite(channel, bool)` — no-op in the static runtime. */
export function puppetSprite(_channel: LingoValue, _bool?: LingoValue): void {
  // No-op.
}

/** `setPref(group, key, value)` — no-op in the static runtime. */
export function setPref(_group: LingoValue, _key: LingoValue, _value: LingoValue): void {
  // No-op.
}

/** `moveToFront(obj)` / `moveFront(obj)` — no-op sprite-order helpers. */
export function moveToFront(_obj: LingoValue): void {
  // No-op.
}
export function moveFront(_obj: LingoValue): void {
  // No-op.
}

/** `moveToBack(obj)` / `moveBack(obj)` — no-op sprite-order helpers. */
export function moveToBack(_obj: LingoValue): void {
  // No-op.
}
export function moveBack(_obj: LingoValue): void {
  // No-op.
}

/** `receiveUpdate(id)` / `removeUpdate(id)` — delegate to the Object Manager's update list. */
export function receiveUpdate(id: LingoValue): number {
  const mgr = (globalThis as unknown as Record<string, unknown>).getObjectManager;
  if (typeof mgr === "function") {
    return callMethod("receiveUpdate", mgr() as LingoMe, id) as number;
  }
  return 0;
}
export function removeUpdate(id: LingoValue): number {
  const mgr = (globalThis as unknown as Record<string, unknown>).getObjectManager;
  if (typeof mgr === "function") {
    return callMethod("removeUpdate", mgr() as LingoMe, id) as number;
  }
  return 0;
}

/** `externalParamValue(name)` — reads the named embed parameter from `_player.externalParams`. */
export function externalParamValue(name: LingoValue): LingoValue {
  const key = lingoKeyToString(name);
  if (key === undefined) {
    return undefined;
  }
  return requireHost().getExternalParam(key);
}

/** `postNetText(url, data)` — no-op in the static runtime. */
export function postNetText(_url: LingoValue, _data: LingoValue): LingoValue {
  return undefined;
}

/** `objectp(value)` — true for script instances / objects. */
export function objectp(value: LingoValue): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (value instanceof LingoList || value instanceof LingoPropList || Array.isArray(value)) {
    return false;
  }
  if (isSymbol(value)) {
    return false;
  }
  return true;
}

/** `string(value)` coercion (Lingo uses this for stringifying). */
export function string(value: LingoValue): string {
  return lingoString(value);
}

/** `value(expr)` — parse a Lingo literal from a string. */
export function value(expr: LingoValue): LingoValue {
  if (typeof expr !== "string") {
    return expr;
  }
  const s = expr.trim();
  if (s === "") {
    return "";
  }
  // Number literal.
  const num = Number(s);
  if (Number.isFinite(num) && !/^0x/i.test(s)) {
    return num;
  }
  // Symbol literal #foo.
  if (s.startsWith("#")) {
    return symbol(s.slice(1));
  }
  // List literal [a, b, c] — best-effort comma split, with quoted string items.
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") {
      return new LingoList();
    }
    const items: LingoValue[] = [];
    for (const part of inner.split(",")) {
      const trimmed = part.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        // Lingo quoted string: strip outer quotes and unescape doubled quotes.
        items.push(trimmed.slice(1, -1).replace(/""/g, '"'));
      } else {
        items.push(value(trimmed));
      }
    }
    return new LingoList(items);
  }
  // PropList literal [:a:1, ...] — delegate to the property parser.
  if (s.startsWith("[:") || s.includes(":")) {
    try {
      return convertToPropList(s, "\r");
    } catch {
      // fall through to raw string
    }
  }
  return s;
}

/** `list(...)` — construct a 1-indexed Lingo list. */
export function list(...args: LingoValue[]): LingoList {
  return new LingoList(args);
}

/** `proplist()` — construct an empty Lingo propList. */
export function proplist(): LingoPropList {
  return new LingoPropList();
}

function parseColorTriple(text: string): LingoValue {
  const m = /rgb\s*\(\s*([^)]+)\s*\)/i.exec(text);
  if (!m) {
    return undefined;
  }
  const parts = m[1].split(",").map((p) => integer(p.trim()));
  while (parts.length < 3) parts.push(0);
  return new LingoList(parts.slice(0, 3));
}

/**
 * `convertToPropList(text, delimiter)` — parse `key=value` lines (or items split by
 * `delimiter`) into a propList. This is the Habbo external-variables/props loader path,
 * so it also recognises `rgb(r,g,b)` values and list literals `[...]`.
 */
export function convertToPropList(text: LingoValue, delimiter: LingoValue): LingoPropList {
  const result = new LingoPropList();
  const textStr = lingoValueToString(text);
  const delim = (typeof delimiter === "string" && delimiter.length > 0) ? delimiter : "\r";
  for (const line of textStr.split(delim)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let raw = trimmed.slice(eq + 1).trim();
    // Strip trailing comments.
    const comment = raw.indexOf("#");
    if (comment >= 0) {
      raw = raw.slice(0, comment).trim();
    }
    let parsed: LingoValue = raw;
    if (raw.startsWith("#")) {
      parsed = symbol(raw.slice(1));
    } else if (/^rgb\s*\(/i.test(raw)) {
      parsed = parseColorTriple(raw);
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      parsed = value(raw);
    } else {
      const num = Number(raw);
      if (Number.isFinite(num) && raw !== "") {
        parsed = num;
      }
    }
    result.add(key, parsed);
  }
  return result;
}
