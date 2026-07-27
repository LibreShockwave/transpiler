// Software frame compositor. Faithful port of cpp/src/player/render/output/SoftwareFrameRenderer.cpp.
//
// Stage 1 scope: renderFrame + the 1:1 blitBitmap path + alphaComposite/alphaCompositePercent +
// isSpecialCompositingInk are ported here, which together cover the COPY / TRANSPARENT / BLEND
// (blend<100) inks at 1:1 scale. blitBitmapScaled is ported in Stage 2 (scaling/rotation) and
// compositeSpecialInk is ported in Stage 3 (ADD/SUBTRACT/REVERSE/GHOST/NOT_*/...); both throw until
// then so any path that reaches them fails loudly rather than silently producing wrong pixels.

import type { FrameSnapshot, RenderSprite } from "./FrameSnapshot.js";
import { InkMode } from "./InkMode.js";
import { Bitmap } from "./Bitmap.js";
import { channel } from "./argb.js";

function opaqueRgb(r: number, g: number, b: number): number {
  return (0xff000000 | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
}

/** Returns the RGB color that should be keyed out for TRANSPARENT/BACKGROUND_TRANSPARENT inks. */
function backgroundTransparentKey(hasBackColor: boolean, backColor: number): number {
  if (hasBackColor) {
    return backColor & 0x00ffffff;
  }
  // Director's default background-transparent key for 32-bit source bitmaps with no
  // explicit backColor is white.
  return 0x00ffffff;
}

export function isSpecialCompositingInk(ink: InkMode): boolean {
  return (
    ink === InkMode.ADD_PIN ||
    ink === InkMode.ADD ||
    ink === InkMode.SUBTRACT_PIN ||
    ink === InkMode.SUBTRACT ||
    ink === InkMode.LIGHTEST ||
    ink === InkMode.DARKEST ||
    ink === InkMode.LIGHTEN ||
    ink === InkMode.REVERSE ||
    ink === InkMode.GHOST ||
    ink === InkMode.NOT_COPY ||
    ink === InkMode.NOT_TRANSPARENT ||
    ink === InkMode.NOT_REVERSE ||
    ink === InkMode.NOT_GHOST
  );
}

function normalizedShapePattern(sprite: RenderSprite): number {
  const pattern = sprite.shapePattern ?? 1;
  return pattern <= 1 ? 1 : ((pattern - 1) % 8) + 1;
}

function shapePatternOn(pattern: number, x: number, y: number): boolean {
  switch (pattern) {
    case 2: return ((x + y) & 1) === 0;
    case 3: return (y & 1) === 0;
    case 4: return (x & 1) === 0;
    case 5: return ((x + y) & 3) === 0;
    case 6: return ((x - y) & 3) === 0;
    case 7: return (x & 3) === 0 || (y & 3) === 0;
    case 8: return ((x + y) & 2) === 0;
    default: return true;
  }
}

/** Render a Director #shape sprite using LibreShockwave's authored ShapeInfo rules. */
function shapeBitmap(sprite: RenderSprite): Bitmap | null {
  const w = Math.max(0, Math.floor(sprite.width));
  const h = Math.max(0, Math.floor(sprite.height));
  if (w <= 0 || h <= 0) {
    return null;
  }
  const argb = new Uint32Array(w * h);
  const paint = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const pattern = normalizedShapePattern(sprite);
    if (pattern <= 1 || shapePatternOn(pattern, x, y)) {
      argb[y * w + x] = (0xff000000 | (sprite.foreColor & 0x00ffffff)) >>> 0;
    } else if (sprite.hasBackColor) {
      argb[y * w + x] = (0xff000000 | (sprite.backColor & 0x00ffffff)) >>> 0;
    }
  };
  const fill = (): void => {
    for (let y = 0; y < h; ++y) {
      for (let x = 0; x < w; ++x) paint(x, y);
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    while (true) {
      paint(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * error;
      if (e2 >= dy) { error += dy; x0 += sx; }
      if (e2 <= dx) { error += dx; y0 += sy; }
    }
  };
  const rect = (inset: number): void => {
    const rw = w - inset * 2;
    const rh = h - inset * 2;
    if (rw <= 0 || rh <= 0) return;
    for (let x = inset; x < inset + rw; ++x) {
      paint(x, inset);
      paint(x, inset + rh - 1);
    }
    for (let y = inset; y < inset + rh; ++y) {
      paint(inset, y);
      paint(inset + rw - 1, y);
    }
  };
  const oval = (inset: number, filled: boolean): void => {
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const rx = Math.max(0, Math.floor(w / 2) - inset);
    const ry = Math.max(0, Math.floor(h / 2) - inset);
    if (rx <= 0 || ry <= 0) return;
    for (let y = 0; y < h; ++y) {
      for (let x = 0; x < w; ++x) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        const value = nx * nx + ny * ny;
        if ((filled && value <= 1) || (!filled && value >= 0.75 && value <= 1.15)) paint(x, y);
      }
    }
  };

  const shapeType = sprite.shapeType ?? 0;
  const filled = sprite.shapeFilled ?? true;
  if (shapeType === 8) {
    const strokes = Math.max(1, sprite.shapeLineSize ?? 1);
    const bottomToTop = sprite.shapeLineDirection === 6;
    const startY = bottomToTop ? h - 1 : 0;
    const endY = bottomToTop ? 0 : h - 1;
    for (let i = 0; i < strokes; ++i) {
      line(0, Math.max(0, Math.min(h - 1, startY - i)),
        w - 1, Math.max(0, Math.min(h - 1, endY - i)));
    }
  } else if (shapeType === 3) {
    if (filled) oval(0, true);
    else {
      const strokes = Math.max(0, (sprite.shapeLineSize ?? 1) - 1);
      for (let i = 0; i < strokes; ++i) oval(i, false);
    }
  } else if (shapeType === 1 || shapeType === 2) {
    if (filled) fill();
    else {
      const strokes = Math.max(0, (sprite.shapeLineSize ?? 1) - 1);
      for (let i = 0; i < strokes; ++i) rect(i);
    }
  } else {
    fill();
  }
  return new Bitmap(w, h, 32, argb);
}

/** Edge-connected MATTE preprocessing used by LibreShockwave's InkProcessor. */
function matteBitmap(source: Bitmap, sprite: RenderSprite, useDirectorBackColor = true): Bitmap {
  const w = source.width();
  const h = source.height();
  if (w <= 0 || h <= 0) return source;
  const pixels = source.pixels();
  const paletteIndices = source.paletteIndices();
  let matteIndex: number | null = null;
  if (paletteIndices && paletteIndices.length === pixels.length) {
    const counts = new Map<number, number>();
    const count = (index: number): void => {
      const value = paletteIndices[index] & 0xff;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    };
    for (let x = 0; x < w; ++x) {
      count(x);
      if (h > 1) count((h - 1) * w + x);
    }
    for (let y = 1; y + 1 < h; ++y) {
      count(y * w);
      if (w > 1) count(y * w + w - 1);
    }
    let bestCount = -1;
    for (const [value, n] of counts) {
      if (n > bestCount) {
        matteIndex = value;
        bestCount = n;
      }
    }
  }
  let matteRgb: number;
  if (useDirectorBackColor) {
    // Explicit MATTE selection is based on the resolved backColor, not merely
    // the most frequent edge index.
    matteIndex = null;
    if (sprite.backColor > 255) {
      matteRgb = sprite.backColor & 0x00ffffff;
    } else {
      const palette = source.imagePalette();
      if (palette && sprite.backColor >= 0 && sprite.backColor < palette.size()) {
        matteRgb = palette.getColor(sprite.backColor) & 0x00ffffff;
      } else {
        const gray = 255 - sprite.backColor;
        matteRgb = ((gray & 0xff) << 16) | ((gray & 0xff) << 8) | (gray & 0xff);
      }
    }
  } else {
    const counts = new Map<number, number>();
    const count = (index: number): void => {
      if ((pixels[index] >>> 24) === 0) return;
      const rgb = pixels[index] & 0x00ffffff;
      counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
    };
    for (let x = 0; x < w; ++x) {
      count(x);
      if (h > 1) count((h - 1) * w + x);
    }
    for (let y = 1; y + 1 < h; ++y) {
      count(y * w);
      if (w > 1) count(y * w + w - 1);
    }
    let bestCount = -1;
    matteRgb = pixels[0] & 0x00ffffff;
    for (const [rgb, n] of counts) {
      if (n > bestCount) {
        matteRgb = rgb;
        bestCount = n;
      }
    }
  }

  const transparent = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let read = 0;
  let write = 0;
  const enqueue = (index: number): void => {
    if (transparent[index]) return;
    const pixel = pixels[index];
    const matchesMatte = matteIndex !== null && paletteIndices
      ? (paletteIndices[index] & 0xff) === matteIndex
      : (pixel & 0x00ffffff) === matteRgb;
    if ((pixel >>> 24) !== 0 && !matchesMatte) return;
    transparent[index] = 1;
    queue[write++] = index;
  };
  for (let x = 0; x < w; ++x) {
    enqueue(x);
    enqueue((h - 1) * w + x);
  }
  for (let y = 1; y + 1 < h; ++y) {
    enqueue(y * w);
    enqueue(y * w + w - 1);
  }
  while (read < write) {
    const index = queue[read++];
    const x = index % w;
    const y = Math.floor(index / w);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < w) enqueue(index + 1);
    if (y > 0) enqueue(index - w);
    if (y + 1 < h) enqueue(index + w);
  }
  const result = pixels.slice();
  for (let i = 0; i < result.length; ++i) {
    if (transparent[i]) result[i] = 0;
  }
  return new Bitmap(w, h, source.bitDepth(), result);
}

/** Composes a frame's sprites into a stage Bitmap. Mirrors SoftwareFrameRenderer::renderFrame. */
export function renderFrame(snapshot: FrameSnapshot, stageWidth: number, stageHeight: number): Bitmap {
  if (stageWidth < 0 || stageHeight < 0) {
    throw new Error("Stage dimensions must be non-negative");
  }
  const argb = new Uint32Array(stageWidth * stageHeight);

  if (snapshot.stageImage !== null) {
    const srcPixels = snapshot.stageImage.pixels();
    const srcW = snapshot.stageImage.width();
    const srcH = snapshot.stageImage.height();
    if (srcPixels.length > 0) {
      for (let y = 0; y < Math.min(srcH, stageHeight); ++y) {
        for (let x = 0; x < Math.min(srcW, stageWidth); ++x) {
          argb[y * stageWidth + x] = srcPixels[y * srcW + x];
        }
      }
    }
  } else {
    const bg = ((snapshot.backgroundColor & 0x00ffffff) | 0xff000000) >>> 0;
    argb.fill(bg);
  }

  // Director composites sprites by ascending locZ (ties broken by channel order).
  const sprites = [...snapshot.sprites].sort((a, b) => {
    const az = a.locZ ?? a.channel;
    const bz = b.locZ ?? b.channel;
    return az - bz || a.channel - b.channel;
  });

  for (const sprite of sprites) {
    if (!sprite.visible) {
      continue;
    }
    let baked = sprite.bakedBitmap;
    if ((baked === null || baked.width() <= 0 || baked.height() <= 0 || baked.pixels().length === 0) && sprite.type === "shape") {
      baked = shapeBitmap(sprite);
    }
    if (baked === null || baked.width() <= 0 || baked.height() <= 0 || baked.pixels().length === 0) {
      continue;
    }
    // Authored indexed MATTE media reaches this compositor as an opaque raster
    // and still needs edge-keying. Script canvases and already processed matte
    // bitmaps carry transparency and must not be keyed a second time.
    if (sprite.ink === InkMode.MATTE) {
      baked = matteBitmap(baked, sprite);
    }
    // LibreShockwave isolates indexed ADD/ADD_PIN media with
    // applyFloodFillTransparency before compositing. Exported `.rgba` assets no
    // longer carry their parallel palette-index plane, so recover the equivalent
    // edge-connected backing from the lossless decoded colors.
    if ((sprite.ink === InkMode.ADD_PIN || sprite.ink === InkMode.ADD)
        && !baked.isScriptModified()) {
      baked = matteBitmap(baked, sprite, false);
    }

    const sx = sprite.x;
    const sy = sprite.y;
    const sw = sprite.width > 0 ? sprite.width : baked.width();
    const sh = sprite.height > 0 ? sprite.height : baked.height();
    const blend = sprite.blend;
    const ink = sprite.ink;
    const flipH = sprite.flipH; // hasDirectorHorizontalMirror folded into bake/flip at export (Stage 5)
    const flipV = sprite.flipV;

    // Director only applies TRANSPARENT/BACKGROUND_TRANSPARENT color keying when the source
    // bitmap has no native alpha channel. If the bitmap already carries alpha (any non-opaque
    // pixel), the runtime must use that alpha directly — otherwise text and pre-keyed sprites
    // would have their foreground color keyed out.
    const hasNativeAlpha = baked.pixels().some((p) => channel(p, 24) < 255);
    const bgKey =
      !hasNativeAlpha && (ink === InkMode.TRANSPARENT || ink === InkMode.BACKGROUND_TRANSPARENT)
        ? backgroundTransparentKey(sprite.hasBackColor, sprite.backColor)
        : null;

    if (sw === baked.width() && sh === baked.height()) {
      blitBitmap(argb, stageWidth, stageHeight, baked.pixels(), baked.width(), baked.height(), sx, sy, blend, ink, bgKey, flipH, flipV);
    } else {
      blitBitmapScaled(argb, stageWidth, stageHeight, baked.pixels(), baked.width(), baked.height(), sx, sy, sw, sh, blend, ink, bgKey, flipH, flipV);
    }
  }

  return new Bitmap(stageWidth, stageHeight, 32, argb);
}

/** 1:1 clipped blit with alpha compositing and (Stage 3) special-ink compositing. */
function blitBitmap(
  argb: Uint32Array,
  stageWidth: number,
  stageHeight: number,
  srcPixels: Uint32Array,
  srcW: number,
  srcH: number,
  dstX: number,
  dstY: number,
  blend: number,
  ink: InkMode,
  bgKey: number | null,
  flipH: boolean,
  flipV: boolean,
): void {
  if (srcW <= 0 || srcH <= 0 || srcPixels.length < srcW * srcH) {
    return;
  }

  const sx0 = Math.max(0, -dstX);
  const sy0 = Math.max(0, -dstY);
  const sx1 = Math.min(srcW, stageWidth - dstX);
  const sy1 = Math.min(srcH, stageHeight - dstY);
  if (sx0 >= sx1 || sy0 >= sy1) {
    return;
  }

  const argbLen = argb.length;
  const useSpecialInk = isSpecialCompositingInk(ink);

  for (let sy = sy0; sy < sy1; ++sy) {
    const fetchY = flipV ? srcH - 1 - sy : sy;
    for (let sx = sx0; sx < sx1; ++sx) {
      const fetchX = flipH ? srcW - 1 - sx : sx;
      const src = srcPixels[fetchY * srcW + fetchX];
      let srcA = channel(src, 24);
      if (srcA === 0) {
        continue;
      }
      if (bgKey !== null && (src & 0x00ffffff) === bgKey) {
        continue;
      }

      const dstIdx = (dstY + sy) * stageWidth + (dstX + sx);
      if (dstIdx < 0 || dstIdx >= argbLen) {
        continue;
      }

      if (useSpecialInk) {
        if (blend < 100) {
          // C++ integer division: srcA = (srcA * blend) / 100 truncates. Replicate with
          // Math.trunc so srcA stays integral (a float here would also defeat the srcA===0
          // skip below and skew the blend-back in compositeSpecialInk by 1 LSB).
          srcA = Math.trunc((srcA * blend) / 100);
          if (srcA === 0) {
            continue;
          }
        }
        compositeSpecialInk(argb, dstIdx, src, srcA, ink);
      } else if (blend < 100) {
        alphaCompositePercent(argb, dstIdx, src, srcA, blend);
      } else if (srcA >= 255) {
        argb[dstIdx] = (src | 0xff000000) >>> 0;
      } else {
        alphaComposite(argb, dstIdx, src, srcA);
      }
    }
  }
}

function alphaComposite(argb: Uint32Array, dstIdx: number, src: number, srcA: number): void {
  if (dstIdx < 0 || dstIdx >= argb.length) {
    return;
  }
  const dst = argb[dstIdx];
  const dstA = channel(dst, 24);
  const invA = 255 - srcA;
  const outA = srcA + ((dstA * invA) / 255 | 0);
  if (outA === 0) {
    argb[dstIdx] = 0;
    return;
  }
  const srcR = channel(src, 16);
  const srcG = channel(src, 8);
  const srcB = channel(src, 0);
  const dstR = channel(dst, 16);
  const dstG = channel(dst, 8);
  const dstB = channel(dst, 0);
  // C++ integer division truncates at each step; replicate with Math.trunc so per-channel
  // rounding matches the reference renderer exactly (parity is the contract).
  const outR = Math.trunc((srcR * srcA + Math.trunc((dstR * dstA * invA) / 255)) / outA);
  const outG = Math.trunc((srcG * srcA + Math.trunc((dstG * dstA * invA) / 255)) / outA);
  const outB = Math.trunc((srcB * srcA + Math.trunc((dstB * dstA * invA) / 255)) / outA);
  argb[dstIdx] = (((outA & 0xff) << 24) | ((outR & 0xff) << 16) | ((outG & 0xff) << 8) | (outB & 0xff)) >>> 0;
}

function alphaCompositePercent(argb: Uint32Array, dstIdx: number, src: number, srcA: number, blendPercent: number): void {
  if (dstIdx < 0 || dstIdx >= argb.length || srcA <= 0 || blendPercent <= 0) {
    return;
  }
  if (blendPercent >= 100) {
    alphaComposite(argb, dstIdx, src, srcA);
    return;
  }
  const dst = argb[dstIdx];
  const dstA = channel(dst, 24);
  if (dstA !== 255) {
    const blendedAlpha = ((srcA * blendPercent) / 100) | 0;
    alphaComposite(argb, dstIdx, src, blendedAlpha);
    return;
  }
  const opacity = Math.min(Math.max(((srcA * blendPercent * 256) / (255 * 100)) | 0, 0), 256);
  const invOpacity = 256 - opacity;
  const srcR = channel(src, 16);
  const srcG = channel(src, 8);
  const srcB = channel(src, 0);
  const dstR = channel(dst, 16);
  const dstG = channel(dst, 8);
  const dstB = channel(dst, 0);
  const outR = (srcR * opacity + dstR * invOpacity) >> 8;
  const outG = (srcG * opacity + dstG * invOpacity) >> 8;
  const outB = (srcB * opacity + dstB * invOpacity) >> 8;
  argb[dstIdx] = opaqueRgb(outR, outG, outB);
}

// Nearest-neighbour scaled blit. Faithful port of SoftwareFrameRenderer::blitBitmapScaled:
// sample the source at ((dy-dstY)*srcH)/dstH, ((dx-dstX)*srcW)/dstW (C++ integer division ->
// Math.trunc here, same dispatch as the 1:1 path). Stage 2 covers scaling; rotation is
// applied earlier in the pipeline (SpriteBaker) so only axis-aligned scaling reaches here.
function blitBitmapScaled(
  argb: Uint32Array,
  stageWidth: number,
  stageHeight: number,
  srcPixels: Uint32Array,
  srcW: number,
  srcH: number,
  dstX: number,
  dstY: number,
  dstW: number,
  dstH: number,
  blend: number,
  ink: InkMode,
  bgKey: number | null,
  flipH: boolean,
  flipV: boolean,
): void {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0 || srcPixels.length < srcW * srcH) {
    return;
  }

  const dx0 = Math.max(0, dstX);
  const dy0 = Math.max(0, dstY);
  const dx1 = Math.min(stageWidth, dstX + dstW);
  const dy1 = Math.min(stageHeight, dstY + dstH);
  if (dx0 >= dx1 || dy0 >= dy1) {
    return;
  }

  const srcLen = srcPixels.length;
  const argbLen = argb.length;
  const useSpecialInk = isSpecialCompositingInk(ink);

  for (let dy = dy0; dy < dy1; ++dy) {
    let srcY = Math.trunc(((dy - dstY) * srcH) / dstH);
    if (flipV) {
      srcY = srcH - 1 - srcY;
    }
    if (srcY < 0 || srcY >= srcH) {
      continue;
    }

    for (let dx = dx0; dx < dx1; ++dx) {
      let srcX = Math.trunc(((dx - dstX) * srcW) / dstW);
      if (flipH) {
        srcX = srcW - 1 - srcX;
      }
      if (srcX < 0 || srcX >= srcW) {
        continue;
      }

      const srcIdx = srcY * srcW + srcX;
      if (srcIdx < 0 || srcIdx >= srcLen) {
        continue;
      }

      const src = srcPixels[srcIdx];
      let srcA = channel(src, 24);
      if (srcA === 0) {
        continue;
      }
      if (bgKey !== null && (src & 0x00ffffff) === bgKey) {
        continue;
      }

      const dstIdx = dy * stageWidth + dx;
      if (dstIdx < 0 || dstIdx >= argbLen) {
        continue;
      }

      if (useSpecialInk) {
        if (blend < 100) {
          srcA = Math.trunc((srcA * blend) / 100);
          if (srcA === 0) {
            continue;
          }
        }
        compositeSpecialInk(argb, dstIdx, src, srcA, ink);
      } else if (blend < 100) {
        alphaCompositePercent(argb, dstIdx, src, srcA, blend);
      } else if (srcA >= 255) {
        argb[dstIdx] = (src | 0xff000000) >>> 0;
      } else {
        alphaComposite(argb, dstIdx, src, srcA);
      }
    }
  }
}

// Special-ink compositing. Faithful port of SoftwareFrameRenderer::compositeSpecialInk.
// ADD/SUBTRACT/DARKEST/LIGHTEN/LIGHTEST/REVERSE/GHOST/NOT_* compute a per-channel result
// from src and dst; if the source alpha is < 255 the result is blended back toward dst by
// (out*c*srcA + dst*invA)/255 (C++ integer truncation -> Math.trunc here). The output is
// opaque (opaqueRgb) — special inks always produce a fully opaque pixel.
function compositeSpecialInk(argb: Uint32Array, dstIdx: number, src: number, srcA: number, ink: InkMode): void {
  if (dstIdx < 0 || dstIdx >= argb.length) {
    return;
  }
  const dst = argb[dstIdx];
  const srcR = channel(src, 16);
  const srcG = channel(src, 8);
  const srcB = channel(src, 0);
  const dstR = channel(dst, 16);
  const dstG = channel(dst, 8);
  const dstB = channel(dst, 0);

  let outR = 0;
  let outG = 0;
  let outB = 0;

  switch (ink) {
    case InkMode.ADD_PIN:
    case InkMode.ADD:
      outR = Math.min(255, dstR + srcR);
      outG = Math.min(255, dstG + srcG);
      outB = Math.min(255, dstB + srcB);
      break;
    case InkMode.SUBTRACT_PIN:
    case InkMode.SUBTRACT:
      outR = Math.max(0, dstR - srcR);
      outG = Math.max(0, dstG - srcG);
      outB = Math.max(0, dstB - srcB);
      break;
    case InkMode.DARKEST:
      outR = Math.min(dstR, srcR);
      outG = Math.min(dstG, srcG);
      outB = Math.min(dstB, srcB);
      break;
    case InkMode.LIGHTEN:
    case InkMode.LIGHTEST:
      outR = Math.max(dstR, srcR);
      outG = Math.max(dstG, srcG);
      outB = Math.max(dstB, srcB);
      break;
    case InkMode.REVERSE:
      outR = (srcR ^ dstR) & 0xff;
      outG = (srcG ^ dstG) & 0xff;
      outB = (srcB ^ dstB) & 0xff;
      break;
    case InkMode.GHOST:
      outR = (~srcR & 0xff) & dstR;
      outG = (~srcG & 0xff) & dstG;
      outB = (~srcB & 0xff) & dstB;
      break;
    case InkMode.NOT_COPY:
      outR = ~srcR & 0xff;
      outG = ~srcG & 0xff;
      outB = ~srcB & 0xff;
      break;
    case InkMode.NOT_TRANSPARENT:
      outR = srcR & dstR;
      outG = srcG & dstG;
      outB = srcB & dstB;
      break;
    case InkMode.NOT_REVERSE:
      outR = ((~srcR & 0xff) ^ dstR) & 0xff;
      outG = ((~srcG & 0xff) ^ dstG) & 0xff;
      outB = ((~srcB & 0xff) ^ dstB) & 0xff;
      break;
    case InkMode.NOT_GHOST:
      outR = (~srcR & 0xff) | dstR;
      outG = (~srcG & 0xff) | dstG;
      outB = (~srcB & 0xff) | dstB;
      break;
    default:
      alphaComposite(argb, dstIdx, src, srcA);
      return;
  }

  if (srcA < 255) {
    const invA = 255 - srcA;
    outR = Math.trunc((outR * srcA + dstR * invA) / 255);
    outG = Math.trunc((outG * srcA + dstG * invA) / 255);
    outB = Math.trunc((outB * srcA + dstB * invA) / 255);
  }

  argb[dstIdx] = opaqueRgb(outR, outG, outB);
}
