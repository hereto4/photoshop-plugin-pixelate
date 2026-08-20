"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const SHIPPED_SIZES = [16, 32, 64, 128, 256, 512, 1024];

const {
  downsampleSize,
  cellIndex,
  cellSample,
  cellStart,
  buildSampleMap,
  expandRegionToCells,
  remapPixels,
  blendWithMask,
} = require("../nn.js");

const { referencePixelate, makeImage } = require("./helpers/reference.js");

function pixelateViaProduction(src, width, height, components, target) {
  const cells = downsampleSize(width, height, target);
  const colMap = buildSampleMap(0, width, 0, width, cells.width);
  const rowMap = buildSampleMap(0, height, 0, height, cells.height);
  return remapPixels({
    src,
    srcRect: { left: 0, top: 0, width, height },
    dst: new src.constructor(width * height * components),
    dstRect: { left: 0, top: 0, width, height },
    components,
    colMap,
    rowMap,
  });
}

test("downsampleSize scales the long edge to the target", () => {
  assert.deepEqual(downsampleSize(1000, 500, 32), {
    width: 32,
    height: 16,
    scale: 0.032,
    noop: false,
  });
  const portrait = downsampleSize(500, 1000, 32);
  assert.equal(portrait.width, 16);
  assert.equal(portrait.height, 32);

  const square = downsampleSize(4096, 4096, 128);
  assert.equal(square.width, 128);
  assert.equal(square.height, 128);
});

test("downsampleSize keeps a short edge of at least one pixel", () => {
  const sliver = downsampleSize(1000, 3, 32);
  assert.equal(sliver.width, 32);
  assert.equal(sliver.height, 1);
});

test("downsampleSize reports a no-op when already at or below target", () => {
  assert.equal(downsampleSize(20, 10, 32).noop, true);
  assert.equal(downsampleSize(32, 32, 32).noop, true);
  assert.equal(downsampleSize(33, 10, 32).noop, false);
  const small = downsampleSize(20, 10, 32);
  assert.equal(small.width, 20, "no-op leaves dimensions untouched");
  assert.equal(small.height, 10);
});

test("all shipped presets round-trip through downsampleSize", () => {
  for (const target of SHIPPED_SIZES) {
    const { width, height, noop } = downsampleSize(1920, 1080, target);
    assert.equal(noop, false);
    assert.equal(width, target);
    assert.equal(height, Math.round((1080 * target) / 1920));
  }
});

test("cellIndex partitions the grid into contiguous runs", () => {
  const seen = [];
  for (let gx = 0; gx < 10; gx++) seen.push(cellIndex(gx, 10, 3));
  assert.deepEqual(seen, [0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
});

test("cellIndex clamps coordinates outside the grid to the edge cells", () => {
  assert.equal(cellIndex(-50, 10, 3), 0);
  assert.equal(cellIndex(999, 10, 3), 2);
});

test("a cell always samples a coordinate inside itself (pixelation is idempotent)", () => {
  for (let gridSize = 1; gridSize <= 300; gridSize++) {
    for (const target of SHIPPED_SIZES) {
      const cellCount = downsampleSize(gridSize, 1, target).width;
      for (let c = 0; c < cellCount; c++) {
        const sample = cellSample(c, gridSize, cellCount);
        assert.equal(
          cellIndex(sample, gridSize, cellCount),
          c,
          `cell ${c} of ${cellCount} over grid ${gridSize} sampled outside itself`
        );
      }
    }
  }
});

test("cellStart is the inverse of cellIndex", () => {
  for (let gridSize = 1; gridSize <= 200; gridSize++) {
    const cellCount = downsampleSize(gridSize, 1, 32).width;
    for (let c = 0; c < cellCount; c++) {
      const start = cellStart(c, gridSize, cellCount);
      assert.equal(cellIndex(start, gridSize, cellCount), c);
      if (start > 0) {
        assert.equal(cellIndex(start - 1, gridSize, cellCount), c - 1);
      }
    }
  }
});

test("buildSampleMap reproduces the hand-computed 10 -> 3 mapping", () => {
  const map = buildSampleMap(0, 10, 0, 10, 3);
  assert.deepEqual(Array.from(map), [1, 1, 1, 5, 5, 5, 5, 8, 8, 8]);
});

test("buildSampleMap honours an offset grid", () => {
  const map = buildSampleMap(100, 10, 100, 10, 3);
  assert.deepEqual(Array.from(map), [101, 101, 101, 105, 105, 105, 105, 108, 108, 108]);
});

test("buildSampleMap yields exactly cellCount distinct sources", () => {
  const map = buildSampleMap(0, 1000, 0, 1000, 32);
  assert.equal(new Set(Array.from(map)).size, 32);
});

test("expandRegionToCells grows a partial region out to whole blocks", () => {
  // Grid 0..10 in 3 cells: block boundaries at 0, 3, 7.
  const grown = expandRegionToCells(4, 6, 0, 10, 3);
  assert.deepEqual(grown, { start: 3, end: 7 });
});

test("expandRegionToCells never shrinks the caller's region", () => {
  const grown = expandRegionToCells(-20, 40, 0, 10, 3);
  assert.equal(grown.start, -20);
  assert.equal(grown.end, 40);
});

test("expandRegionToCells covers the whole grid when the region does", () => {
  const grown = expandRegionToCells(0, 10, 0, 10, 3);
  assert.deepEqual(grown, { start: 0, end: 10 });
});

test("remapPixels matches a true downsize-then-upsize for every preset", () => {
  const cases = [
    [64, 64, 4],
    [200, 137, 4],
    [137, 200, 4],
    [301, 17, 4],
    [512, 512, 3],
    [99, 100, 1],
  ];
  for (const [width, height, components] of cases) {
    const src = makeImage(width, height, components, width * height + components);
    for (const target of SHIPPED_SIZES) {
      const expected = referencePixelate(src, width, height, components, target);
      const actual = pixelateViaProduction(src, width, height, components, target);
      assert.deepEqual(
        Array.from(actual),
        Array.from(expected),
        `mismatch for ${width}x${height}x${components} @ ${target}px`
      );
    }
  }
});

test("remapPixels is idempotent: pixelating twice changes nothing", () => {
  const src = makeImage(157, 231, 4, 7);
  for (const target of SHIPPED_SIZES) {
    const once = pixelateViaProduction(src, 157, 231, 4, target);
    const twice = pixelateViaProduction(once, 157, 231, 4, target);
    assert.deepEqual(Array.from(twice), Array.from(once), `not idempotent @ ${target}px`);
  }
});

test("remapPixels produces flat blocks, not interpolated gradients", () => {
  const width = 128;
  const height = 128;
  const src = makeImage(width, height, 4, 42);
  const out = pixelateViaProduction(src, width, height, 4, 16);

  // Exactly 16 distinct colours per row, and every value present in the source.
  const sourceValues = new Set();
  for (let i = 0; i < src.length; i += 4) sourceValues.add(src[i]);
  const rowColors = new Set();
  for (let x = 0; x < width; x++) rowColors.add(out[x * 4]);
  assert.ok(rowColors.size <= 16, `expected <= 16 block colours, saw ${rowColors.size}`);
  for (const value of rowColors) {
    assert.ok(sourceValues.has(value), "block colour was not copied from a source pixel");
  }

  // Neighbouring pixels inside a block are byte-identical (no anti-aliasing).
  const blockWidth = width / 16;
  for (let block = 0; block < 16; block++) {
    const first = block * blockWidth;
    for (let x = first + 1; x < first + blockWidth; x++) {
      assert.equal(out[x * 4], out[first * 4], "block interior is not flat");
    }
  }
});

test("remapPixels writes transparent where a sample lands outside the source", () => {
  const components = 4;
  const src = new Uint8Array(4 * 4 * components).fill(200);
  const dst = new Uint8Array(4 * 4 * components).fill(9);
  // Every sample points far outside the 4x4 source rect.
  remapPixels({
    src,
    srcRect: { left: 0, top: 0, width: 4, height: 4 },
    dst,
    dstRect: { left: 0, top: 0, width: 4, height: 4 },
    components,
    colMap: new Int32Array([99, 99, 99, 99]),
    rowMap: new Int32Array([99, 99, 99, 99]),
    fillOutOfRange: true,
  });
  assert.ok(dst.every((v) => v === 0), "expected fully transparent output");
});

test("remapPixels clamps to the edge when the source has no alpha", () => {
  const components = 3;
  const src = new Uint8Array([
    1, 1, 1, 2, 2, 2,
    3, 3, 3, 4, 4, 4,
  ]);
  const dst = new Uint8Array(2 * 2 * components);
  remapPixels({
    src,
    srcRect: { left: 0, top: 0, width: 2, height: 2 },
    dst,
    dstRect: { left: 0, top: 0, width: 2, height: 2 },
    components,
    colMap: new Int32Array([-5, 90]),
    rowMap: new Int32Array([-5, 90]),
    fillOutOfRange: false,
  });
  assert.deepEqual(Array.from(dst), [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
});

test("remapPixels row reuse produces the same bytes as recomputing every row", () => {
  const width = 61;
  const height = 61;
  const components = 4;
  const src = makeImage(width, height, components, 99);
  const cells = downsampleSize(width, height, 16);
  const colMap = buildSampleMap(0, width, 0, width, cells.width);
  const rowMap = buildSampleMap(0, height, 0, height, cells.height);

  const fast = remapPixels({
    src,
    srcRect: { left: 0, top: 0, width, height },
    dst: new Uint8Array(width * height * components),
    dstRect: { left: 0, top: 0, width, height },
    components,
    colMap,
    rowMap,
  });

  // Naive per-pixel gather with no row caching.
  const slow = new Uint8Array(width * height * components);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * components;
      const from = (rowMap[y] * width + colMap[x]) * components;
      for (let c = 0; c < components; c++) slow[to + c] = src[from + c];
    }
  }
  assert.deepEqual(Array.from(fast), Array.from(slow));
});

test("remapPixels handles a destination offset from the source rect", () => {
  const components = 4;
  const src = makeImage(20, 20, components, 5);
  // Source rect sits at canvas (100, 50); write a 10x10 window at (105, 55).
  const colMap = buildSampleMap(105, 10, 100, 20, 5);
  const rowMap = buildSampleMap(55, 10, 50, 20, 5);
  const dst = new Uint8Array(10 * 10 * components);
  remapPixels({
    src,
    srcRect: { left: 100, top: 50, width: 20, height: 20 },
    dst,
    dstRect: { left: 105, top: 55, width: 10, height: 10 },
    components,
    colMap,
    rowMap,
  });
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const to = (y * 10 + x) * components;
      const from = ((rowMap[y] - 50) * 20 + (colMap[x] - 100)) * components;
      for (let c = 0; c < components; c++) {
        assert.equal(dst[to + c], src[from + c]);
      }
    }
  }
});

test("remapPixels preserves 16-bit values without truncation", () => {
  const components = 4;
  const src = new Uint16Array(4 * 4 * components);
  for (let i = 0; i < src.length; i++) src[i] = 60000 + (i % 500);
  const out = pixelateViaProduction(src, 4, 4, components, 2);
  assert.ok(out instanceof Uint16Array);
  assert.ok(Array.from(out).every((v) => v >= 60000), "16-bit values were truncated");
});

test("blendWithMask keeps pixelated pixels where the mask is opaque", () => {
  const base = new Uint8Array([10, 10, 10, 255]);
  const pixelated = new Uint8Array([200, 200, 200, 255]);
  blendWithMask({
    base,
    pixelated,
    mask: new Uint8Array([255]),
    pixelCount: 1,
    components: 4,
    hasAlpha: true,
    maxValue: 255,
  });
  assert.deepEqual(Array.from(pixelated), [200, 200, 200, 255]);
});

test("blendWithMask restores original pixels where the mask is empty", () => {
  const base = new Uint8Array([10, 20, 30, 255]);
  const pixelated = new Uint8Array([200, 200, 200, 255]);
  blendWithMask({
    base,
    pixelated,
    mask: new Uint8Array([0]),
    pixelCount: 1,
    components: 4,
    hasAlpha: true,
    maxValue: 255,
  });
  assert.deepEqual(Array.from(pixelated), [10, 20, 30, 255]);
});

test("blendWithMask mixes halfway on a feathered mask edge", () => {
  const base = new Uint8Array([0, 0, 0, 255]);
  const pixelated = new Uint8Array([255, 100, 50, 255]);
  blendWithMask({
    base,
    pixelated,
    mask: new Uint8Array([128]),
    pixelCount: 1,
    components: 4,
    hasAlpha: true,
    maxValue: 255,
  });
  const m = 128 / 255;
  assert.deepEqual(Array.from(pixelated), [
    Math.round(255 * m),
    Math.round(100 * m),
    Math.round(50 * m),
    255,
  ]);
});

test("blendWithMask does not fringe when blending against transparency", () => {
  // Original is fully transparent; pixelated is opaque red. A half mask must
  // give half-opaque *red*, not a half-opaque muddy dark red.
  const base = new Uint8Array([0, 0, 0, 0]);
  const pixelated = new Uint8Array([255, 0, 0, 255]);
  blendWithMask({
    base,
    pixelated,
    mask: new Uint8Array([128]),
    pixelCount: 1,
    components: 4,
    hasAlpha: true,
    maxValue: 255,
  });
  assert.equal(pixelated[0], 255, "red channel should stay saturated");
  assert.equal(pixelated[3], Math.round(255 * (128 / 255)));
});

test("blendWithMask zeroes pixels that end up fully transparent", () => {
  const base = new Uint8Array([1, 2, 3, 0]);
  const pixelated = new Uint8Array([4, 5, 6, 0]);
  blendWithMask({
    base,
    pixelated,
    mask: new Uint8Array([128]),
    pixelCount: 1,
    components: 4,
    hasAlpha: true,
    maxValue: 255,
  });
  assert.deepEqual(Array.from(pixelated), [0, 0, 0, 0]);
});

test("blendWithMask handles alpha-less (Background layer) pixels", () => {
  const base = new Uint8Array([0, 0, 0]);
  const pixelated = new Uint8Array([100, 200, 40]);
  blendWithMask({
    base,
    pixelated,
    mask: new Uint8Array([255 / 2 | 0]),
    pixelCount: 1,
    components: 3,
    hasAlpha: false,
    maxValue: 255,
  });
  const m = 127 / 255;
  assert.deepEqual(Array.from(pixelated), [
    Math.round(100 * m),
    Math.round(200 * m),
    Math.round(40 * m),
  ]);
});

test("blendWithMask leaves float data unrounded", () => {
  const base = new Float32Array([0, 0, 0, 1]);
  const pixelated = new Float32Array([1, 1, 1, 1]);
  blendWithMask({
    base,
    pixelated,
    mask: new Uint8Array([128]),
    pixelCount: 1,
    components: 4,
    hasAlpha: true,
    maxValue: 1,
    integer: false,
  });
  assert.ok(pixelated[0] > 0.5 && pixelated[0] < 0.51);
});
