/*
 * Pure nearest-neighbour resampling maths for True Pixelate.
 *
 * Nothing in here touches Photoshop, the DOM or UXP, so it runs under plain
 * Node and is covered by test/nn.test.js.
 *
 * The model: pretend the "grid rect" (either the layer's bounds or the whole
 * canvas) was downsized to `target` px on its long edge with nearest-neighbour
 * sampling, then blown straight back up to its original size, again nearest
 * neighbour. Every output pixel therefore takes its value verbatim from one
 * source pixel -- the same pixel a real downsize would have kept.
 */

"use strict";

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Size of the imaginary downsized image.
 *
 * `target` applies to the long edge; the short edge follows the aspect ratio,
 * exactly as Image Size does with Constrain Proportions on. When the grid is
 * already at or below the target there is nothing to simulate, so the size is
 * returned unchanged with `noop: true`.
 */
function downsampleSize(gridWidth, gridHeight, target) {
  const longest = Math.max(gridWidth, gridHeight);
  if (longest <= 0) {
    return { width: 0, height: 0, scale: 1, noop: true };
  }
  if (longest <= target) {
    return { width: gridWidth, height: gridHeight, scale: 1, noop: true };
  }
  const scale = target / longest;
  return {
    width: Math.max(1, Math.round(gridWidth * scale)),
    height: Math.max(1, Math.round(gridHeight * scale)),
    scale,
    noop: false,
  };
}

/**
 * Which downsized cell a grid-local coordinate falls into.
 *
 * Centre sampling -- (coord + 0.5) scaled into cell space -- which is what
 * Photoshop, ImageMagick and every other nearest-neighbour resizer uses.
 * Coordinates outside the grid clamp to the edge cell.
 */
function cellIndex(localCoord, gridSize, cellCount) {
  return clamp(
    Math.floor(((localCoord + 0.5) * cellCount) / gridSize),
    0,
    cellCount - 1
  );
}

/**
 * The single grid-local coordinate a cell samples when downsizing: the source
 * pixel under the cell's centre. That value becomes the whole cell's colour.
 */
function cellSample(cell, gridSize, cellCount) {
  return clamp(
    Math.floor(((cell + 0.5) * gridSize) / cellCount),
    0,
    gridSize - 1
  );
}

/**
 * First grid-local coordinate belonging to `cell` -- the inverse of cellIndex,
 * used to snap a region outwards so it covers whole blocks.
 */
function cellStart(cell, gridSize, cellCount) {
  return clamp(Math.ceil((cell * gridSize) / cellCount - 0.5), 0, gridSize);
}

/**
 * For every coordinate in [regionStart, regionStart + regionLength), the
 * absolute coordinate it should copy its value from.
 *
 * Both input and output are absolute (canvas-space) coordinates; `gridStart`
 * says where the grid rect begins so this works for a grid that is offset from
 * the region being written.
 */
function buildSampleMap(regionStart, regionLength, gridStart, gridSize, cellCount) {
  const map = new Int32Array(regionLength);
  for (let i = 0; i < regionLength; i++) {
    const local = regionStart + i - gridStart;
    const cell = cellIndex(local, gridSize, cellCount);
    map[i] = gridStart + cellSample(cell, gridSize, cellCount);
  }
  return map;
}

/**
 * Grow [start, end) outwards until it covers every block it touches, so a
 * partially covered block never gets half-pixelated. Never shrinks the input:
 * blocks clipped by the grid edge keep the caller's original extent.
 */
function expandRegionToCells(start, end, gridStart, gridSize, cellCount) {
  if (end <= start || cellCount <= 0 || gridSize <= 0) {
    return { start, end };
  }
  const firstCell = cellIndex(start - gridStart, gridSize, cellCount);
  const lastCell = cellIndex(end - 1 - gridStart, gridSize, cellCount);
  const expandedStart = gridStart + cellStart(firstCell, gridSize, cellCount);
  const expandedEnd =
    gridStart +
    (lastCell + 1 >= cellCount
      ? gridSize
      : cellStart(lastCell + 1, gridSize, cellCount));
  return {
    start: Math.min(start, expandedStart),
    end: Math.max(end, expandedEnd),
  };
}

/**
 * Copy source pixels into the destination buffer through the sample maps.
 *
 * Both buffers are chunky/interleaved with `components` values per pixel and
 * may be Uint8Array, Uint16Array or Float32Array -- whole pixel tuples are
 * copied verbatim, so bit depth and colour mode never matter here.
 *
 * `fillOutOfRange` decides what happens where a sample lands outside the
 * source rect: true writes zeroes (transparent, correct for layers with an
 * alpha channel), false clamps to the nearest edge pixel (correct for
 * Background layers and other alpha-less sources, where zeroes would show up
 * as unexpected black).
 *
 * Rows that sample the same source row are memcpy'd from the row already
 * built, so the per-pixel path only runs once per distinct block row.
 */
function remapPixels(options) {
  const {
    src,
    srcRect,
    dst,
    dstRect,
    components,
    colMap,
    rowMap,
    fillOutOfRange = true,
  } = options;

  const srcLeft = srcRect.left;
  const srcTop = srcRect.top;
  const srcWidth = srcRect.width;
  const srcHeight = srcRect.height;
  const dstWidth = dstRect.width;
  const dstHeight = dstRect.height;
  const rowValues = dstWidth * components;

  // Pre-resolve columns to source offsets once; every row reuses them.
  const colOffsets = new Int32Array(dstWidth);
  const colValid = new Uint8Array(dstWidth);
  for (let x = 0; x < dstWidth; x++) {
    let sx = colMap[x] - srcLeft;
    if (sx < 0 || sx >= srcWidth) {
      if (fillOutOfRange) {
        colValid[x] = 0;
        colOffsets[x] = 0;
        continue;
      }
      sx = clamp(sx, 0, srcWidth - 1);
    }
    colValid[x] = 1;
    colOffsets[x] = sx * components;
  }

  let previousSy = -1;
  let previousRow = -1;

  for (let y = 0; y < dstHeight; y++) {
    const dstRow = y * rowValues;
    let sy = rowMap[y] - srcTop;

    if (sy === previousSy && previousRow >= 0) {
      dst.copyWithin(dstRow, previousRow, previousRow + rowValues);
      continue;
    }
    const outsideRow = sy < 0 || sy >= srcHeight;
    if (outsideRow && fillOutOfRange) {
      dst.fill(0, dstRow, dstRow + rowValues);
      previousSy = sy;
      previousRow = dstRow;
      continue;
    }
    if (outsideRow) {
      sy = clamp(sy, 0, srcHeight - 1);
    }

    const srcRow = sy * srcWidth * components;
    for (let x = 0; x < dstWidth; x++) {
      const to = dstRow + x * components;
      if (!colValid[x]) {
        for (let c = 0; c < components; c++) dst[to + c] = 0;
        continue;
      }
      const from = srcRow + colOffsets[x];
      for (let c = 0; c < components; c++) dst[to + c] = src[from + c];
    }

    previousSy = rowMap[y] - srcTop;
    previousRow = dstRow;
  }

  return dst;
}

/**
 * Feather the pixelated result back into the original pixels through an 8-bit
 * selection mask, in place on `pixelated`.
 *
 * Colour is mixed in premultiplied space so a soft edge between an opaque
 * pixelated block and a transparent original does not fringe towards black.
 */
function blendWithMask(options) {
  const {
    base,
    pixelated,
    mask,
    pixelCount,
    components,
    hasAlpha,
    maxValue,
    maskMaxValue = 255,
    integer = true,
  } = options;

  const alphaIndex = components - 1;
  const colorComponents = hasAlpha ? alphaIndex : components;
  const round = integer ? Math.round : (v) => v;

  for (let i = 0; i < pixelCount; i++) {
    const m = mask[i] / maskMaxValue;
    if (m >= 1) continue; // fully selected: keep the pixelated value
    const offset = i * components;

    if (m <= 0) {
      for (let c = 0; c < components; c++) {
        pixelated[offset + c] = base[offset + c];
      }
      continue;
    }

    if (!hasAlpha) {
      for (let c = 0; c < components; c++) {
        const from = base[offset + c];
        pixelated[offset + c] = round(from + (pixelated[offset + c] - from) * m);
      }
      continue;
    }

    const a0 = base[offset + alphaIndex] / maxValue;
    const a1 = pixelated[offset + alphaIndex] / maxValue;
    const aOut = a0 + (a1 - a0) * m;
    if (aOut <= 0) {
      for (let c = 0; c < components; c++) pixelated[offset + c] = 0;
      continue;
    }
    for (let c = 0; c < colorComponents; c++) {
      const mixed =
        (base[offset + c] * a0 * (1 - m) + pixelated[offset + c] * a1 * m) / aOut;
      pixelated[offset + c] = round(mixed);
    }
    pixelated[offset + alphaIndex] = round(aOut * maxValue);
  }

  return pixelated;
}

module.exports = {
  clamp,
  downsampleSize,
  cellIndex,
  cellSample,
  cellStart,
  buildSampleMap,
  expandRegionToCells,
  remapPixels,
  blendWithMask,
};
