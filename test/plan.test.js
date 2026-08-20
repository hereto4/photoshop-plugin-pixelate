"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { planPixelation } = require("../plan.js");

const CANVAS = { width: 2000, height: 1000 };

test("layer basis measures the downsize against the layer's own bounds", () => {
  const plan = planPixelation({
    layerBounds: { left: 100, top: 100, right: 1100, bottom: 600 },
    canvas: CANVAS,
    basis: "layer",
    size: 32,
  });
  assert.equal(plan.noop, false);
  assert.equal(plan.cells.width, 32);
  assert.equal(plan.cells.height, 16);
  // Layer basis: the grid is the layer, so the write never grows past it.
  assert.deepEqual(plan.writeRect, { left: 100, top: 100, right: 1100, bottom: 600 });
  assert.deepEqual(plan.readRect, plan.writeRect);
});

test("canvas basis measures the downsize against the document", () => {
  const plan = planPixelation({
    layerBounds: { left: 100, top: 100, right: 1100, bottom: 600 },
    canvas: CANVAS,
    basis: "canvas",
    size: 32,
  });
  assert.deepEqual(plan.gridRect, { left: 0, top: 0, right: 2000, bottom: 1000 });
  assert.equal(plan.cells.width, 32);
  assert.equal(plan.cells.height, 16);
  assert.equal(plan.blockWidth, 2000 / 32);
  assert.equal(plan.blockHeight, 1000 / 16);
});

test("canvas basis grows the write rect out to whole blocks", () => {
  const plan = planPixelation({
    layerBounds: { left: 101, top: 51, right: 1099, bottom: 599 },
    canvas: CANVAS,
    basis: "canvas",
    size: 32,
  });
  // Blocks are 62.5 x 62.5 px; the layer edges land mid-block, so the write
  // rect must reach the surrounding block boundaries.
  assert.ok(plan.writeRect.left <= 101);
  assert.ok(plan.writeRect.top <= 51);
  assert.ok(plan.writeRect.right >= 1099);
  assert.ok(plan.writeRect.bottom >= 599);
  assert.equal(plan.writeRect.left % 62.5 === 0 || plan.writeRect.left < 101, true);
  // Read rect always stays the layer's real bounds.
  assert.deepEqual(plan.readRect, { left: 101, top: 51, right: 1099, bottom: 599 });
});

test("blocks tile the grid exactly in layer basis", () => {
  const plan = planPixelation({
    layerBounds: { left: 0, top: 0, right: 640, bottom: 480 },
    canvas: { width: 640, height: 480 },
    basis: "layer",
    size: 64,
  });
  assert.equal(plan.cells.width, 64);
  assert.equal(plan.cells.height, 48);
  assert.equal(plan.blockWidth, 10);
  assert.equal(plan.blockHeight, 10);
});

test("reports a no-op when the layer is already at or below the target", () => {
  const plan = planPixelation({
    layerBounds: { left: 0, top: 0, right: 24, bottom: 12 },
    canvas: CANVAS,
    basis: "layer",
    size: 32,
  });
  assert.equal(plan.noop, true);
  assert.equal(plan.reason, "already-smaller");
  assert.equal(plan.longEdge, 24);
});

test("a small layer is still pixelated in canvas basis", () => {
  // The layer is 24px wide but the canvas is 2000px, so at 32px blocks are
  // 62.5px -- the whole layer collapses to roughly one block.
  const plan = planPixelation({
    layerBounds: { left: 0, top: 0, right: 24, bottom: 12 },
    canvas: CANVAS,
    basis: "canvas",
    size: 32,
  });
  assert.equal(plan.noop, false);
  assert.equal(plan.blockWidth, 62.5);
});

test("reports a no-op for an empty layer", () => {
  const plan = planPixelation({
    layerBounds: { left: 10, top: 10, right: 10, bottom: 400 },
    canvas: CANVAS,
    basis: "layer",
    size: 32,
  });
  assert.equal(plan.noop, true);
  assert.equal(plan.reason, "empty-layer");
});

test("an active selection clips the write rect", () => {
  const plan = planPixelation({
    layerBounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
    canvas: { width: 1000, height: 1000 },
    basis: "layer",
    size: 32,
    selectionBounds: { left: 200, top: 300, right: 400, bottom: 500 },
  });
  assert.equal(plan.limitedToSelection, true);
  assert.deepEqual(plan.writeRect, { left: 200, top: 300, right: 400, bottom: 500 });
  // Reading still covers the whole layer: blocks inside the selection may
  // sample pixels from outside it.
  assert.deepEqual(plan.readRect, { left: 0, top: 0, right: 1000, bottom: 1000 });
  // The grid is unchanged, so blocks stay aligned with an unclipped run.
  assert.deepEqual(plan.gridRect, { left: 0, top: 0, right: 1000, bottom: 1000 });
});

test("a selection that misses the layer is reported, not silently ignored", () => {
  const plan = planPixelation({
    layerBounds: { left: 0, top: 0, right: 100, bottom: 100 },
    canvas: CANVAS,
    basis: "layer",
    size: 16,
    selectionBounds: { left: 900, top: 900, right: 1000, bottom: 1000 },
  });
  assert.equal(plan.noop, true);
  assert.equal(plan.reason, "selection-misses-layer");
});

test("a layer hanging off the canvas still covers all its own pixels", () => {
  const plan = planPixelation({
    layerBounds: { left: -500, top: -200, right: 2500, bottom: 1200 },
    canvas: CANVAS,
    basis: "canvas",
    size: 16,
  });
  assert.ok(plan.writeRect.left <= -500, "write must not clip the layer's left edge");
  assert.ok(plan.writeRect.top <= -200);
  assert.ok(plan.writeRect.right >= 2500);
  assert.ok(plan.writeRect.bottom >= 1200);
});

test("every preset yields the expected cell count for a square canvas", () => {
  for (const size of [16, 32, 64, 128]) {
    const plan = planPixelation({
      layerBounds: { left: 0, top: 0, right: 4096, bottom: 4096 },
      canvas: { width: 4096, height: 4096 },
      basis: "layer",
      size,
    });
    assert.equal(plan.cells.width, size);
    assert.equal(plan.cells.height, size);
    assert.equal(plan.blockWidth, 4096 / size);
  }
});
