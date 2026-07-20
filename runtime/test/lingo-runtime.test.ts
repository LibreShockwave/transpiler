import { describe, it, expect, beforeEach } from "vitest";
import {
  integer,
  float,
  lingoString,
  LingoList,
  LingoPropList,
  LingoNotImplemented,
  sprite,
  member,
  theProperty,
  setLingoHost,
  createMe,
  meProp,
  setMeProp,
  symbol,
  value,
  chunkOf,
  dispatchValueBuiltin,
  lingoBinary,
  SUPPORTED_LINGO_BUILTINS,
  type LingoHost,
  type LingoValue,
} from "../src/lingo-runtime.js";

describe("line chunks", () => {
  it("recognizes Director RETURN, Unix LF, and Windows CRLF separators", () => {
    expect(chunkOf("one\rtwo", "line", 2)).toBe("two");
    expect(chunkOf("one\ntwo", "line", 2)).toBe("two");
    expect(chunkOf("one\r\ntwo", "line", 2)).toBe("two");
  });
});

describe("integer", () => {
  it("truncates toward zero like C++ static_cast<int>", () => {
    expect(integer(3.9)).toBe(3);
    expect(integer(-3.9)).toBe(-3);
    expect(integer(3)).toBe(3);
    expect(integer(-3)).toBe(-3);
  });
  it("maps booleans to 1/0", () => {
    expect(integer(true)).toBe(1);
    expect(integer(false)).toBe(0);
  });
  it("parses strings, tolerating surrounding whitespace", () => {
    expect(integer("  12 ")).toBe(12);
    expect(integer("-7.8")).toBe(-7);
    expect(integer("not-a-number")).toBe(0);
  });
  it("yields 0 for VOID/lists", () => {
    expect(integer(undefined)).toBe(0);
    expect(integer(new LingoList([5]))).toBe(0);
  });
});

describe("float", () => {
  it("promotes numbers and parses strings", () => {
    expect(float(3)).toBe(3);
    expect(float("  2.5 ")).toBe(2.5);
    expect(float(true)).toBe(1);
    expect(float("nope")).toBe(0);
  });
});

describe("LingoList (1-indexed)", () => {
  it("reads/writes at 1-based indices and rejects 0 / out-of-range", () => {
    const list = new LingoList(["a", "b", "c"]);
    expect(list.length).toBe(3);
    expect(list.get(1)).toBe("a");
    expect(list.get(3)).toBe("c");
    expect(() => list.get(0)).toThrow(RangeError);
    expect(() => list.get(4)).toThrow(RangeError);
    list.set(2, "B");
    expect(list.get(2)).toBe("B");
    expect(() => list.set(0, "x")).toThrow(RangeError);
  });
  it("add appends at the next index", () => {
    const list = new LingoList([1]);
    list.add(2);
    expect(list.length).toBe(2);
    expect(list.get(2)).toBe(2);
  });
});

describe("LingoPropList", () => {
  it("updates duplicate keys in place and preserves insertion order", () => {
    const p = new LingoPropList();
    p.add("a", 1);
    p.add("b", 2);
    p.add("a", 10);
    expect(p.length).toBe(2);
    expect(p.get("a")).toBe(10);
    expect(p.get("b")).toBe(2);
    expect(p.has("c")).toBe(false);
    expect(p.get("c")).toBeUndefined();
  });
  it("supports the Director addProp method spelling", () => {
    const p = new LingoPropList();
    p.addProp("drag", 42);
    expect(p.getaProp("drag")).toBe(42);
  });
  it("returns the final value from getLast", () => {
    const p = new LingoPropList(["first", 10, "second", 20]);
    expect(p.getLast()).toBe(20);
  });

  it("returns VOID from findPos when a property is absent", () => {
    const p = new LingoPropList(["first", 10]);
    expect(p.findPos("first")).toBe(1);
    expect(p.findPos("missing")).toBeUndefined();
  });

  it("iterates values in insertion order", () => {
    const p = new LingoPropList(["first", 1, "second", 2]);
    expect(p.toArray()).toEqual([1, 2]);
  });

  it("implements indexed mutation and value-to-key lookup", () => {
    const p = new LingoPropList(["first", 10, "second", 20]);
    p.setAt(2, 30);
    expect(p.getAt(2)).toBe(30);
    expect(p.getOne(30)).toBe("second");
    expect(p.getFirst()).toBe(10);
  });
});

describe("LibreShockwave builtin parity", () => {
  it("tracks every unique C++ BuiltinRegistry name", () => {
    expect(SUPPORTED_LINGO_BUILTINS.size).toBe(123);
  });

  it("dispatches representative math, list, string, type, and geometry builtins", () => {
    expect(dispatchValueBuiltin("bitAnd", [7, 3])).toEqual({ handled: true, value: 3 });
    expect(dispatchValueBuiltin("stringReplace", ["a-b-a", "a", "x"]).value).toBe("x-b-x");
    expect(dispatchValueBuiltin("join", [new LingoList(["a", "b"]), ":"]).value).toBe("a:b");
    expect(dispatchValueBuiltin("voidP", [undefined]).value).toBe(true);
    expect((dispatchValueBuiltin("point", [4, 5]).value as LingoList).toArray()).toEqual([4, 5]);
  });
});

describe("Lingo binary operators", () => {
  it("performs vector arithmetic without JavaScript string coercion", () => {
    expect((lingoBinary("add", new LingoList([1, 2]), new LingoList([3, 4])) as LingoList).toArray())
      .toEqual([4, 6]);
    expect((lingoBinary("sub", new LingoList([5, 7]), 2) as LingoList).toArray())
      .toEqual([3, 5]);
  });

  it("uses Director string and comparison behavior", () => {
    expect(lingoBinary("joinPad", "hello", "world")).toBe("hello world");
    expect(lingoBinary("contains", "Hello World", "world")).toBe(true);
    expect(lingoBinary("eq", symbol("x"), symbol("x"))).toBe(true);
  });
});

describe("value", () => {
  it("parses nested Director layout property lists", () => {
    const parsed = value(
      '[#member: "null", #media: #bitmap, #loc: [1, 2], #color: rgb(3, 4, 5)]',
    ) as LingoPropList;
    expect(parsed).toBeInstanceOf(LingoPropList);
    expect(parsed.get(symbol("member"))).toBe("null");
    expect(parsed.get(symbol("media"))).toBe(symbol("bitmap"));
    expect((parsed.get(symbol("loc")) as LingoList).toArray()).toEqual([1, 2]);
    expect((parsed.get(symbol("color")) as LingoList).toArray()).toEqual([3, 4, 5]);
  });
});

describe("lingoString", () => {
  it("renders VOID/booleans/lists Director-style", () => {
    expect(lingoString(undefined)).toBe("VOID");
    expect(lingoString(true)).toBe("TRUE");
    expect(lingoString(false)).toBe("FALSE");
    expect(lingoString(new LingoList([1, "x"]))).toBe("[1, x]");
    expect(lingoString(new LingoPropList())).toBe("[:]");
  });
});

describe("imperative accessors without a host", () => {
  beforeEach(() => setLingoHost(null));
  it("throw LingoNotImplemented when no host is set", () => {
    expect(() => sprite(1)).toThrow(LingoNotImplemented);
    expect(() => member(1)).toThrow(LingoNotImplemented);
    expect(() => theProperty("mouseLevel")).toThrow(LingoNotImplemented);
  });
});

describe("LingoHost wiring", () => {
  it("sprite proxy reads/writes sprite properties through the host", () => {
    const props: Record<string, LingoValue> = {};
    const host: LingoHost = {
      getSpriteProp: (_channel, prop) => props[prop] ?? 0,
      setSpriteProp: (_channel, prop, value) => { props[prop] = value; },
      getMember: () => undefined,
      getCastMembers: () => [],
      getScriptMemberInfo: () => undefined,
      getMemberProp: () => undefined,
      setMemberProp: () => undefined,
      getGlobal: () => undefined,
      setGlobal: () => undefined,
      getThe: () => undefined,
      setThe: () => undefined,
      pushParams: () => undefined,
      popParams: () => undefined,
      getParam: () => undefined,
      getExternalParam: () => undefined,
      callBuiltin: () => undefined,
      currentFrame: () => 1,
      go: () => undefined,
    };
    setLingoHost(host);
    sprite(5).locH = 100;
    sprite(5).locV = 200;
    expect(sprite(5).locH).toBe(100);
    expect(sprite(5).locV).toBe(200);
    setLingoHost(null);
  });

  it("me property ivars read/write via helpers", () => {
    const me = createMe(7);
    expect(meProp(me, "locH")).toBeUndefined();
    setMeProp(me, "locH", 42);
    expect(meProp(me, "locH")).toBe(42);
    expect(me.spriteNum).toBe(7);
  });

  it("LingoNotImplemented carries its name", () => {
    const e = new LingoNotImplemented("x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("LingoNotImplemented");
    expect(e.message).toBe("x");
  });
});
