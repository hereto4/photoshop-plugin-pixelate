/*
 * Works out *which* rectangles to read and write, and how big the pixel blocks
 * come out. Pure geometry -- no Photoshop, no UXP -- so test/plan.test.js can
 * exercise the awkward cases (layer hanging off the canvas, selection that
 * misses the layer, layer already smaller than the target).
 */

"use strict";

const { downsampleSize, expandRegionToCells } = require("./nn.js");

const BASIS_LAYER = "layer";
const BASIS_CANVAS = "canvas";

function rectWidth(rect) {
  return rect.right - rect.left;
}

function rectHeight(rect) {
  return rect.bottom - rect.top;
}

function isEmptyRect(rect) {
  return rectWidth(rect) <= 0 || rectHeight(rect) <= 0;
}

function intersectRects(a, b) {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/**
 * @param {object} input
 * @param {{left,top,right,bottom}} input.layerBounds  layer pixel bounds, canvas space
 * @param {{width,height}}          input.canvas       document size in pixels
 * @param {"layer"|"canvas"}        input.basis        what the downsize is measured against
 * @param {number}                  input.size         16 | 32 | 64 | 128
 * @param {?{left,top,right,bottom}} [input.selectionBounds] active selection, if it should limit the result
 */
function planPixelation(input) {
  const { layerBounds, canvas, basis, size, selectionBounds = null } = input;

  if (isEmptyRect(layerBounds)) {
    return { noop: true, reason: "empty-layer" };
  }

  const gridRect =
    basis === BASIS_CANVAS
      ? { left: 0, top: 0, right: canvas.width, bottom: canvas.height }
      : {
          left: layerBounds.left,
          top: layerBounds.top,
          right: layerBounds.right,
          bottom: layerBounds.bottom,
        };

  if (isEmptyRect(gridRect)) {
    return { noop: true, reason: "empty-grid" };
  }

  const gridW = rectWidth(gridRect);
  const gridH = rectHeight(gridRect);
  const cells = downsampleSize(gridW, gridH, size);

  if (cells.noop) {
    return {
      noop: true,
      reason: "already-smaller",
      gridRect,
      longEdge: Math.max(gridW, gridH),
    };
  }

  // Grow to whole blocks so an edge block is never half-pixelated. In layer
  // basis the grid already starts on a block boundary, so this is a no-op
  // there; in canvas basis it can push the write past the layer's bounds.
  const horizontal = expandRegionToCells(
    layerBounds.left,
    layerBounds.right,
    gridRect.left,
    gridW,
    cells.width
  );
  const vertical = expandRegionToCells(
    layerBounds.top,
    layerBounds.bottom,
    gridRect.top,
    gridH,
    cells.height
  );

  let writeRect = {
    left: horizontal.start,
    top: vertical.start,
    right: horizontal.end,
    bottom: vertical.end,
  };

  let limitedToSelection = false;
  if (selectionBounds && !isEmptyRect(selectionBounds)) {
    const clipped = intersectRects(writeRect, selectionBounds);
    if (isEmptyRect(clipped)) {
      return { noop: true, reason: "selection-misses-layer", gridRect, cells };
    }
    writeRect = clipped;
    limitedToSelection = true;
  }

  return {
    noop: false,
    basis,
    size,
    gridRect,
    cells,
    // Average block size. Blocks vary by a pixel when the ratio isn't whole --
    // which is exactly what a real nearest-neighbour upscale does.
    blockWidth: gridW / cells.width,
    blockHeight: gridH / cells.height,
    readRect: {
      left: layerBounds.left,
      top: layerBounds.top,
      right: layerBounds.right,
      bottom: layerBounds.bottom,
    },
    writeRect,
    limitedToSelection,
  };
}

module.exports = {
  BASIS_LAYER,
  BASIS_CANVAS,
  planPixelation,
  intersectRects,
  isEmptyRect,
  rectWidth,
  rectHeight,
};
