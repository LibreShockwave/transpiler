import { describe, it, expect } from "vitest";
import { buildFrameSnapshot, type ScoreJson } from "../src/ScoreData.js";
import type { Bitmap } from "../src/Bitmap.js";
import { cloneFrameSnapshot, mergeScoreSnapshot } from "../src/FrameSnapshot.js";

// buildSprite is not exported, but buildFrameSnapshot runs every sprite through
// coerceSpriteType, so we observe the normalized type via the snapshot's sprites.
function snapshotOf(types: string[]): { sprites: { type: string }[] } {
  const score: ScoreJson = {
    stageWidth: 1,
    stageHeight: 1,
    backgroundColor: 0,
    frameCount: 1,
    frames: [
      {
        frame: 1,
        sprites: types.map((t, i) => ({
          channel: i + 1,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          locZ: 0,
          visible: true,
          type: t,
          ink: 0,
          blend: 100,
          flipH: false,
          flipV: false,
          rotation: 0,
          skew: 0,
          bakedBitmapAsset: null,
        })),
      },
    ],
  };
  const noBitmap = (_p: string): Bitmap | null => null;
  return buildFrameSnapshot(score, undefined, 0, noBitmap) as unknown as { sprites: { type: string }[] };
}

describe("coerceSpriteType", () => {
  it("maps the C++ exporter's UPPER_SNAKE_CASE type names to runtime SpriteType values", () => {
    const got = snapshotOf([
      "BITMAP",
      "SHAPE",
      "TEXT",
      "BUTTON",
      "FILM_LOOP",
      "SHOCKWAVE_3D",
      "UNKNOWN",
    ]).sprites.map((s) => s.type);
    expect(got).toEqual(["bitmap", "shape", "text", "button", "filmloop", "w3d", "unknown"]);
  });

  it("falls back to unknown for unrecognized types", () => {
    expect(snapshotOf(["nonsense"]).sprites[0].type).toBe("unknown");
  });
});

describe("mergeScoreSnapshot", () => {
  it("preserves live mutations unless the score changes that property", () => {
    const score: ScoreJson = {
      stageWidth: 1,
      stageHeight: 1,
      backgroundColor: 0,
      frameCount: 1,
      frames: [{
        frame: 1,
        sprites: [{
          channel: 1, x: 1, y: 2, width: 1, height: 1, locZ: 0,
          visible: true, type: "BITMAP", ink: 0, blend: 100,
          flipH: false, flipV: false, rotation: 0, skew: 0,
          bakedBitmapAsset: null,
        }],
      }],
    };
    const noBitmap = (_path: string): Bitmap | null => null;
    const previous = buildFrameSnapshot(score, undefined, 0, noBitmap);
    const live = cloneFrameSnapshot(previous);
    live.sprites[0]!.x = 99;
    live.sprites[0]!.y = 88;
    const next = cloneFrameSnapshot(previous);
    next.frameNumber = 2;
    next.sprites[0]!.y = 42;

    const merged = mergeScoreSnapshot(previous, live, next);
    expect(merged.frameNumber).toBe(2);
    expect(merged.sprites[0]!.x).toBe(99);
    expect(merged.sprites[0]!.y).toBe(42);
  });

  it("adds and removes channels according to the score", () => {
    const previous = snapshotOf(["BITMAP"]) as unknown as import("../src/FrameSnapshot.js").FrameSnapshot;
    const live = cloneFrameSnapshot(previous);
    const added = { ...previous.sprites[0]!, channel: 99 };
    const next = { ...cloneFrameSnapshot(previous), sprites: [added] };

    const merged = mergeScoreSnapshot(previous, live, next);
    expect(merged.sprites.map((sprite) => sprite.channel)).toEqual([99]);
  });

  it("preserves channels created dynamically outside the score", () => {
    const previous = {
      ...(snapshotOf([]) as unknown as import("../src/FrameSnapshot.js").FrameSnapshot),
      sprites: [],
    };
    const live = cloneFrameSnapshot(previous);
    live.sprites.push({
      ...(snapshotOf(["BITMAP"]) as unknown as import("../src/FrameSnapshot.js").FrameSnapshot)
        .sprites[0]!,
      channel: 42,
      x: 17,
    });
    const next = cloneFrameSnapshot(previous);
    next.frameNumber = 2;

    const merged = mergeScoreSnapshot(previous, live, next);
    expect(merged.sprites.map((sprite) => sprite.channel)).toEqual([42]);
    expect(merged.sprites[0]!.x).toBe(17);
  });
});
