#!/usr/bin/env node
/*
 * Renders docs/preview.png so the output can be eyeballed without launching
 * Photoshop -- and so the difference from a Mosaic-style filter is visible.
 *
 * Three panels, left to right:
 *   1. the source image
 *   2. nn.js run at 16 px on the long edge (what the plugin does)
 *   3. the same block grid filled with each block's *average* colour, which is
 *      what Mosaic and friends do
 *
 * The fine diagonal stripes are the tell: nearest-neighbour keeps or drops
 * each one whole, averaging smears them into flat grey.
 *
 *     node tools/preview.js
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { downsampleSize, buildSampleMap, remapPixels } = require("../nn.js");

const SIZE = 256;
const TARGET = 16;
const GUTTER = 6;
const COMPONENTS = 4;

function writePng(filePath, width, height, rgba) {
  const stride = width * COMPONENTS;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  const chunk = (tag, payload) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(tag, "ascii"), payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  fs.writeFileSync(
    filePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Gradient + disc + one-pixel diagonal stripes: detail at every scale. */
function makeSource() {
  const pixels = new Uint8Array(SIZE * SIZE * COMPONENTS);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const offset = (y * SIZE + x) * COMPONENTS;
      let r = Math.round((x / (SIZE - 1)) * 255);
      let g = Math.round((y / (SIZE - 1)) * 255);
      let b = 140;

      const dx = x - SIZE * 0.62;
      const dy = y - SIZE * 0.4;
      if (dx * dx + dy * dy < 46 * 46) {
        r = 250;
        g = 210;
        b = 60;
      }
      if ((x + y) % 6 === 0) {
        r = 20;
        g = 20;
        b = 30;
      }

      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function truePixelate(src) {
  const cells = downsampleSize(SIZE, SIZE, TARGET);
  return {
    cells,
    pixels: remapPixels({
      src,
      srcRect: { left: 0, top: 0, width: SIZE, height: SIZE },
      dst: new Uint8Array(src.length),
      dstRect: { left: 0, top: 0, width: SIZE, height: SIZE },
      components: COMPONENTS,
      colMap: buildSampleMap(0, SIZE, 0, SIZE, cells.width),
      rowMap: buildSampleMap(0, SIZE, 0, SIZE, cells.height),
    }),
  };
}

/** What Mosaic does: every block becomes the mean of the pixels under it. */
function averagePixelate(src, cells) {
  const out = new Uint8Array(src.length);
  const blockW = SIZE / cells.width;
  const blockH = SIZE / cells.height;
  for (let cy = 0; cy < cells.height; cy++) {
    const y0 = Math.round(cy * blockH);
    const y1 = Math.round((cy + 1) * blockH);
    for (let cx = 0; cx < cells.width; cx++) {
      const x0 = Math.round(cx * blockW);
      const x1 = Math.round((cx + 1) * blockW);
      const totals = [0, 0, 0, 0];
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const offset = (y * SIZE + x) * COMPONENTS;
          for (let c = 0; c < COMPONENTS; c++) totals[c] += src[offset + c];
          count++;
        }
      }
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const offset = (y * SIZE + x) * COMPONENTS;
          for (let c = 0; c < COMPONENTS; c++) {
            out[offset + c] = Math.round(totals[c] / count);
          }
        }
      }
    }
  }
  return out;
}

function compose(panels) {
  const width = panels.length * SIZE + (panels.length - 1) * GUTTER;
  const canvas = new Uint8Array(width * SIZE * COMPONENTS);
  for (let i = 3; i < canvas.length; i += COMPONENTS) canvas[i] = 255;
  panels.forEach((panel, index) => {
    const originX = index * (SIZE + GUTTER);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const to = (y * width + originX + x) * COMPONENTS;
        const from = (y * SIZE + x) * COMPONENTS;
        for (let c = 0; c < COMPONENTS; c++) canvas[to + c] = panel[from + c];
      }
    }
  });
  return { canvas, width };
}

function main() {
  const source = makeSource();
  const { cells, pixels } = truePixelate(source);
  const averaged = averagePixelate(source, cells);
  const { canvas, width } = compose([source, pixels, averaged]);

  const outDir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "preview.png");
  writePng(outPath, width, SIZE, canvas);

  const distinct = new Set();
  for (let i = 0; i < pixels.length; i += COMPONENTS) {
    distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
  }

  console.log(`source        ${SIZE} x ${SIZE}`);
  console.log(`downsampled   ${cells.width} x ${cells.height} (target ${TARGET} px)`);
  console.log(`block size    ${SIZE / cells.width} px`);
  console.log(`distinct colours after pixelation: ${distinct.size} (max ${cells.width * cells.height})`);
  console.log(`wrote ${path.relative(path.join(__dirname, ".."), outPath)} (${width} x ${SIZE})`);
}

main();
