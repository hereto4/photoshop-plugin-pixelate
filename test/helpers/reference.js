"use strict";

const { downsampleSize } = require("../../nn.js");

/**
 * The oracle: literally downsize a buffer to the target's long edge with
 * nearest-neighbour sampling into a second buffer, then blow that buffer back
 * up to the original size. Production code fuses the two passes; every test
 * compares against this.
 */
function referencePixelate(src, width, height, components, target) {
  const { width: dw, height: dh } = downsampleSize(width, height, target);

  const small = new src.constructor(dw * dh * components);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / dw));
      const to = (y * dw + x) * components;
      const from = (sy * width + sx) * components;
      for (let c = 0; c < components; c++) small[to + c] = src[from + c];
    }
  }

  const out = new src.constructor(width * height * components);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(dh - 1, Math.floor(((y + 0.5) * dh) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(dw - 1, Math.floor(((x + 0.5) * dw) / width));
      const to = (y * width + x) * components;
      const from = (sy * dw + sx) * components;
      for (let c = 0; c < components; c++) out[to + c] = small[from + c];
    }
  }
  return out;
}

/** Deterministic pseudo-random pixels; no Math.random so runs are repeatable. */
function makeImage(width, height, components, seed = 1) {
  const data = new Uint8Array(width * height * components);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (s >>> 16) & 0xff;
  }
  return data;
}

module.exports = { referencePixelate, makeImage };
