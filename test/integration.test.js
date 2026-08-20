"use strict";

/*
 * End-to-end coverage of pixelate.js against the fake Photoshop in
 * test/fakes/. This drives the real orchestration -- validation, duplication,
 * getPixels, the sample maps, selection blending, putPixels -- and then checks
 * the pixels that landed in the layer.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// Route the plugin's `photoshop` / `uxp` imports at our fakes.
const FAKES = {
  photoshop: path.join(__dirname, "fakes", "photoshop.js"),
  uxp: path.join(__dirname, "fakes", "uxp.js"),
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (FAKES[request]) return FAKES[request];
  return originalResolve.call(this, request, ...rest);
};

const dom = require("./fakes/dom.js").install();

const photoshop = require("./fakes/photoshop.js");
const { installScenario, world, readRect } = photoshop.__test;
const { LayerKind } = photoshop.constants;

const { pixelateActiveLayer, SIZES: SHIPPED_SIZES } = require("../pixelate.js");
const { referencePixelate, makeImage } = require("./helpers/reference.js");

function activeLayerNamed(name) {
  return world.document.layers.find((layer) => layer.name === name);
}

test("pixelates a full-canvas layer to exactly the reference result", async () => {
  const width = 320;
  const height = 200;
  const pixels = makeImage(width, height, 4, 11);
  installScenario({
    width,
    height,
    layers: [
      { name: "Art", bounds: { left: 0, top: 0, right: width, bottom: height }, pixels },
    ],
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: false });

  assert.equal(result.noop, false);
  assert.equal(result.cells.width, 32);
  assert.equal(result.cells.height, 20);
  assert.equal(world.putCalls.length, 1);
  assert.equal(world.putCalls[0].replace, true);

  const expected = referencePixelate(pixels, width, height, 4, 32);
  const layer = world.document.layers[0];
  assert.deepEqual(Array.from(layer.pixels), Array.from(expected));
});

test("every preset lands on the reference result", async () => {
  // Wider than the largest preset, so no preset degenerates into a no-op.
  const width = 1500;
  const height = 1100;
  for (const size of SHIPPED_SIZES) {
    const pixels = makeImage(width, height, 4, size + 3);
    installScenario({
      width,
      height,
      layers: [
        { name: "Art", bounds: { left: 0, top: 0, right: width, bottom: height }, pixels: pixels.slice() },
      ],
    });
    await pixelateActiveLayer({ size, duplicate: false });
    const expected = referencePixelate(pixels, width, height, 4, size);
    assert.deepEqual(
      Array.from(world.document.layers[0].pixels),
      Array.from(expected),
      `preset ${size} px diverged from the reference`
    );
  }
});

test("an offset layer is pixelated against its own bounds", async () => {
  const width = 120;
  const height = 90;
  const pixels = makeImage(width, height, 4, 21);
  installScenario({
    width: 1000,
    height: 800,
    layers: [
      {
        name: "Art",
        bounds: { left: 317, top: 211, right: 317 + width, bottom: 211 + height },
        pixels,
      },
    ],
  });

  const result = await pixelateActiveLayer({ size: 16, duplicate: false, basis: "layer" });

  assert.equal(result.cells.width, 16);
  assert.deepEqual(world.putCalls[0].targetBounds, {
    left: 317,
    top: 211,
    right: 317 + width,
    bottom: 211 + height,
  });
  const expected = referencePixelate(pixels, width, height, 4, 16);
  assert.deepEqual(Array.from(world.document.layers[0].pixels), Array.from(expected));
});

test("canvas basis uses the document's long edge for block size", async () => {
  installScenario({
    width: 1000,
    height: 500,
    layers: [
      {
        name: "Art",
        bounds: { left: 200, top: 100, right: 400, bottom: 300 },
        pixels: makeImage(200, 200, 4, 33),
      },
    ],
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: false, basis: "canvas" });

  // Canvas is 1000 px on its long edge -> 32 cells -> 31.25 px blocks, whereas
  // layer basis on a 200 px layer would have given 6.25 px blocks.
  assert.equal(result.blockWidth, 1000 / 32);
  assert.equal(result.cells.width, 32);
  assert.equal(result.cells.height, 16);
});

test("canvas basis writes whole blocks past the layer's edges", async () => {
  installScenario({
    width: 1000,
    height: 1000,
    layers: [
      {
        name: "Art",
        bounds: { left: 201, top: 101, right: 399, bottom: 299 },
        pixels: makeImage(198, 198, 4, 44),
      },
    ],
  });

  await pixelateActiveLayer({ size: 16, duplicate: false, basis: "canvas" });

  // 1000/16 = 62.5 px blocks; the layer's edges sit mid-block, so the write
  // must reach past them rather than half-fill the boundary blocks.
  const written = world.putCalls[0].targetBounds;
  assert.ok(written.left <= 201, `left ${written.left} did not expand`);
  assert.ok(written.top <= 101, `top ${written.top} did not expand`);
  assert.ok(written.right >= 399, `right ${written.right} did not expand`);
  assert.ok(written.bottom >= 299, `bottom ${written.bottom} did not expand`);
});

test("blocks are flat and aligned to the canvas grid in canvas basis", async () => {
  const size = 256;
  installScenario({
    width: size,
    height: size,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: size, bottom: size },
        pixels: makeImage(size, size, 4, 55),
      },
    ],
  });

  await pixelateActiveLayer({ size: 16, duplicate: false, basis: "canvas" });

  const layer = world.document.layers[0];
  const block = size / 16; // 16 px blocks, exactly aligned
  for (let by = 0; by < 16; by++) {
    for (let bx = 0; bx < 16; bx++) {
      const originOffset = ((by * block) * size + bx * block) * 4;
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) {
          const offset = ((by * block + y) * size + bx * block + x) * 4;
          for (let c = 0; c < 4; c++) {
            assert.equal(
              layer.pixels[offset + c],
              layer.pixels[originOffset + c],
              `block (${bx},${by}) is not flat`
            );
          }
        }
      }
    }
  }
});

test("duplicate mode leaves the original untouched and names the copy", async () => {
  const width = 200;
  const height = 100;
  const pixels = makeImage(width, height, 4, 66);
  installScenario({
    width,
    height,
    layers: [
      { name: "Portrait", bounds: { left: 0, top: 0, right: width, bottom: height }, pixels: pixels.slice() },
    ],
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: true });

  assert.equal(result.duplicated, true);
  assert.equal(result.layerName, "Portrait [32px]");
  assert.equal(world.document.layers.length, 2);

  const original = activeLayerNamed("Portrait");
  assert.deepEqual(Array.from(original.pixels), Array.from(pixels), "original was modified");

  const copy = activeLayerNamed("Portrait [32px]");
  const expected = referencePixelate(pixels, width, height, 4, 32);
  assert.deepEqual(Array.from(copy.pixels), Array.from(expected));
});

test("a Smart Object is rasterized on the duplicate", async () => {
  installScenario({
    width: 128,
    height: 128,
    layers: [
      {
        name: "Placed",
        kind: LayerKind.SMARTOBJECT,
        bounds: { left: 0, top: 0, right: 128, bottom: 128 },
        pixels: makeImage(128, 128, 4, 77),
      },
    ],
  });

  const result = await pixelateActiveLayer({ size: 16, duplicate: true });

  assert.equal(result.noop, false);
  assert.equal(world.rasterized.length, 1);
  assert.equal(world.rasterized[0].target, "entireLayer");
  assert.equal(activeLayerNamed("Placed").kind, LayerKind.SMARTOBJECT, "source must stay a Smart Object");
});

test("a Smart Object without duplication is refused with guidance", async () => {
  installScenario({
    width: 128,
    height: 128,
    layers: [
      {
        name: "Placed",
        kind: LayerKind.SMARTOBJECT,
        bounds: { left: 0, top: 0, right: 128, bottom: 128 },
        pixels: makeImage(128, 128, 4, 88),
      },
    ],
  });

  await assert.rejects(
    () => pixelateActiveLayer({ size: 16, duplicate: false }),
    (error) => {
      assert.equal(error.expected, true);
      assert.match(error.message, /rasterized/i);
      return true;
    }
  );
  assert.equal(world.putCalls.length, 0);
});

test("groups, adjustment layers and multi-selections are refused", async () => {
  const bounds = { left: 0, top: 0, right: 64, bottom: 64 };

  installScenario({
    width: 64,
    height: 64,
    layers: [{ name: "Set", kind: LayerKind.GROUP, bounds }],
  });
  await assert.rejects(() => pixelateActiveLayer({ size: 16 }), /Merge the group/i);

  installScenario({
    width: 64,
    height: 64,
    layers: [{ name: "Curves", kind: LayerKind.CURVES, bounds }],
  });
  await assert.rejects(() => pixelateActiveLayer({ size: 16 }), /no pixels/i);

  installScenario({
    width: 64,
    height: 64,
    layers: [
      { name: "A", bounds },
      { name: "B", bounds },
    ],
    activeLayerIndexes: [0, 1],
  });
  await assert.rejects(() => pixelateActiveLayer({ size: 16 }), /single layer/i);

  installScenario(null);
  await assert.rejects(() => pixelateActiveLayer({ size: 16 }), /Open a document/i);

  assert.equal(world.putCalls.length, 0, "nothing should have been written");
});

test("an unsupported size is refused", async () => {
  installScenario({
    width: 64,
    height: 64,
    layers: [{ name: "Art", bounds: { left: 0, top: 0, right: 64, bottom: 64 } }],
  });
  await assert.rejects(
    () => pixelateActiveLayer({ size: 48 }),
    /Choose one of 16, 32, 64, 128, 256, 512, 1024/
  );
});

test("a layer already smaller than the target is left alone", async () => {
  installScenario({
    width: 500,
    height: 500,
    layers: [
      {
        name: "Tiny",
        bounds: { left: 0, top: 0, right: 20, bottom: 12 },
        pixels: makeImage(20, 12, 4, 99),
      },
    ],
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: true });

  assert.equal(result.noop, true);
  assert.equal(result.reason, "already-smaller");
  assert.equal(result.longEdge, 20);
  assert.equal(world.putCalls.length, 0);
  assert.equal(world.document.layers.length, 1, "a no-op must not leave a stray duplicate");
  assert.equal(world.historyStates[0].committed, false, "no-op must not commit a history step");
});

test("a successful run commits exactly one history step", async () => {
  installScenario({
    width: 200,
    height: 200,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: 200, bottom: 200 },
        pixels: makeImage(200, 200, 4, 123),
      },
    ],
  });

  await pixelateActiveLayer({ size: 64, duplicate: false });

  assert.equal(world.historyStates.length, 1);
  assert.equal(world.historyStates[0].name, "Pixelate 64 px");
  assert.equal(world.historyStates[0].committed, true);
});

test("a hard selection confines the change to the selected rect", async () => {
  const size = 200;
  const pixels = makeImage(size, size, 4, 202);
  installScenario({
    width: size,
    height: size,
    layers: [
      { name: "Art", bounds: { left: 0, top: 0, right: size, bottom: size }, pixels: pixels.slice() },
    ],
    selection: { left: 40, top: 60, right: 120, bottom: 140 },
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: false, limitToSelection: true });

  assert.equal(result.limitedToSelection, true);
  assert.deepEqual(world.putCalls[0].targetBounds, {
    left: 40,
    top: 60,
    right: 120,
    bottom: 140,
  });

  const layer = world.document.layers[0];
  const expected = referencePixelate(pixels, size, size, 4, 32);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const inside = x >= 40 && x < 120 && y >= 60 && y < 140;
      const want = inside ? expected[offset] : pixels[offset];
      assert.equal(
        layer.pixels[offset],
        want,
        `pixel (${x},${y}) ${inside ? "inside" : "outside"} the selection is wrong`
      );
    }
  }
});

test("blocks inside a selection stay aligned with an unselected run", async () => {
  const size = 200;
  const pixels = makeImage(size, size, 4, 303);
  const bounds = { left: 0, top: 0, right: size, bottom: size };

  installScenario({ width: size, height: size, layers: [{ name: "A", bounds, pixels: pixels.slice() }] });
  await pixelateActiveLayer({ size: 32, duplicate: false });
  const unrestricted = world.document.layers[0].pixels.slice();

  installScenario({
    width: size,
    height: size,
    layers: [{ name: "A", bounds, pixels: pixels.slice() }],
    selection: { left: 37, top: 91, right: 158, bottom: 173 },
  });
  await pixelateActiveLayer({ size: 32, duplicate: false, limitToSelection: true });
  const restricted = world.document.layers[0].pixels;

  for (let y = 91; y < 173; y++) {
    for (let x = 37; x < 158; x++) {
      const offset = (y * size + x) * 4;
      assert.equal(
        restricted[offset],
        unrestricted[offset],
        `pixel (${x},${y}) shifted when the run was limited to a selection`
      );
    }
  }
});

test("limitToSelection false ignores an active selection", async () => {
  const size = 128;
  const pixels = makeImage(size, size, 4, 404);
  installScenario({
    width: size,
    height: size,
    layers: [
      { name: "Art", bounds: { left: 0, top: 0, right: size, bottom: size }, pixels: pixels.slice() },
    ],
    selection: { left: 10, top: 10, right: 20, bottom: 20 },
  });

  const result = await pixelateActiveLayer({ size: 16, duplicate: false, limitToSelection: false });

  assert.equal(result.limitedToSelection, false);
  assert.deepEqual(
    Array.from(world.document.layers[0].pixels),
    Array.from(referencePixelate(pixels, size, size, 4, 16))
  );
});

test("a selection that misses the layer changes nothing", async () => {
  installScenario({
    width: 1000,
    height: 1000,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        pixels: makeImage(100, 100, 4, 505),
      },
    ],
    selection: { left: 800, top: 800, right: 900, bottom: 900 },
  });

  const result = await pixelateActiveLayer({ size: 16, duplicate: true });

  assert.equal(result.noop, true);
  assert.equal(result.reason, "selection-misses-layer");
  assert.equal(world.putCalls.length, 0);
  assert.equal(world.document.layers.length, 1);
});

test("a feathered selection edge blends instead of stepping", async () => {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4).fill(0);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // opaque
  for (let i = 0; i < pixels.length; i += 4) pixels[i] = (i / 4) % 256; // varying red

  installScenario({
    width: size,
    height: size,
    layers: [
      { name: "Art", bounds: { left: 0, top: 0, right: size, bottom: size }, pixels: pixels.slice() },
    ],
    // Left half fully selected, right half a linear ramp down to nothing.
    selection: {
      left: 0,
      top: 0,
      right: size,
      bottom: size,
      maskAt: (x) => (x < 32 ? 255 : Math.max(0, 255 - (x - 32) * 8)),
    },
  });

  await pixelateActiveLayer({ size: 16, duplicate: false, limitToSelection: true });

  const layer = world.document.layers[0];
  const expected = referencePixelate(pixels, size, size, 4, 16);
  // Fully selected column: pure pixelated value.
  assert.equal(layer.pixels[(10 * size + 5) * 4], expected[(10 * size + 5) * 4]);
  // Fully deselected column (mask hit 0 at x = 64): original value preserved.
  assert.equal(layer.pixels[(10 * size + 63) * 4], pixels[(10 * size + 63) * 4]);
  // Alpha must survive the premultiplied blend untouched (both sides opaque).
  assert.equal(layer.pixels[(10 * size + 40) * 4 + 3], 255);
});

test("a Background layer (no alpha) round-trips through three components", async () => {
  const width = 160;
  const height = 120;
  const pixels = makeImage(width, height, 3, 606);
  installScenario({
    width,
    height,
    layers: [
      {
        name: "Background",
        bounds: { left: 0, top: 0, right: width, bottom: height },
        components: 3,
        hasAlpha: false,
        pixels,
      },
    ],
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: false });

  assert.equal(world.putCalls[0].components, 3);
  assert.equal(result.noop, false);
  assert.deepEqual(
    Array.from(world.document.layers[0].pixels),
    Array.from(referencePixelate(pixels, width, height, 3, 32))
  );
});

test("16-bit pixels survive without truncation", async () => {
  const width = 96;
  const height = 96;
  const pixels = new Uint16Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 40000 + (i % 20000);
  installScenario({
    width,
    height,
    layers: [
      {
        name: "Deep",
        bounds: { left: 0, top: 0, right: width, bottom: height },
        componentSize: 16,
        arrayType: Uint16Array,
        pixels,
      },
    ],
  });

  const result = await pixelateActiveLayer({ size: 16, duplicate: false });

  assert.equal(result.componentSize, 16);
  const layer = world.document.layers[0];
  assert.ok(layer.pixels instanceof Uint16Array);
  assert.deepEqual(
    Array.from(layer.pixels),
    Array.from(referencePixelate(pixels, width, height, 4, 16))
  );
});

test("transparency is preserved rather than turning into black", async () => {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  // Opaque red disc on a transparent field.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const dx = x - size / 2;
      const dy = y - size / 2;
      if (dx * dx + dy * dy < 20 * 20) {
        pixels[offset] = 255;
        pixels[offset + 3] = 255;
      }
    }
  }
  installScenario({
    width: size,
    height: size,
    layers: [
      { name: "Disc", bounds: { left: 0, top: 0, right: size, bottom: size }, pixels: pixels.slice() },
    ],
  });

  await pixelateActiveLayer({ size: 16, duplicate: false });

  const layer = world.document.layers[0];
  // A corner block sampled from empty space must still be fully transparent.
  assert.equal(layer.pixels[3], 0, "corner should stay transparent");
  // Alpha only ever holds a value copied from the source: 0 or 255, never a mix.
  for (let i = 3; i < layer.pixels.length; i += 4) {
    const alpha = layer.pixels[i];
    assert.ok(alpha === 0 || alpha === 255, `alpha ${alpha} was interpolated`);
  }
});

test("pixelating twice at the same size is a no-op the second time", async () => {
  const size = 150;
  installScenario({
    width: size,
    height: size,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: size, bottom: size },
        pixels: makeImage(size, size, 4, 707),
      },
    ],
  });

  await pixelateActiveLayer({ size: 32, duplicate: false });
  const once = world.document.layers[0].pixels.slice();
  await pixelateActiveLayer({ size: 32, duplicate: false });
  assert.deepEqual(Array.from(world.document.layers[0].pixels), Array.from(once));
});

test("a locked layer is unlocked before writing", async () => {
  installScenario({
    width: 128,
    height: 128,
    layers: [
      {
        name: "Locked",
        bounds: { left: 0, top: 0, right: 128, bottom: 128 },
        pixels: makeImage(128, 128, 4, 808),
        allLocked: true,
        pixelsLocked: true,
      },
    ],
  });

  await pixelateActiveLayer({ size: 16, duplicate: false });

  const layer = world.document.layers[0];
  assert.equal(layer.allLocked, false);
  assert.equal(layer.pixelsLocked, false);
  assert.equal(world.putCalls.length, 1);
});

test("all image data handles are disposed", async () => {
  installScenario({
    width: 128,
    height: 128,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: 128, bottom: 128 },
        pixels: makeImage(128, 128, 4, 909),
      },
    ],
    selection: { left: 10, top: 10, right: 100, bottom: 100 },
  });

  const created = [];
  const realCreate = photoshop.imaging.createImageDataFromBuffer;
  const realGet = photoshop.imaging.getPixels;
  const realSelection = photoshop.imaging.getSelection;
  photoshop.imaging.createImageDataFromBuffer = async (...args) => {
    const image = await realCreate(...args);
    created.push(image);
    return image;
  };
  photoshop.imaging.getPixels = async (...args) => {
    const result = await realGet(...args);
    created.push(result.imageData);
    return result;
  };
  photoshop.imaging.getSelection = async (...args) => {
    const result = await realSelection(...args);
    created.push(result.imageData);
    return result;
  };

  try {
    await pixelateActiveLayer({ size: 16, duplicate: false, limitToSelection: true });
  } finally {
    photoshop.imaging.createImageDataFromBuffer = realCreate;
    photoshop.imaging.getPixels = realGet;
    photoshop.imaging.getSelection = realSelection;
  }

  assert.ok(created.length >= 3, `expected at least 3 handles, saw ${created.length}`);
  for (const image of created) {
    assert.equal(image.disposed, true, "an ImageData handle leaked");
  }
});

test("image data is still disposed when putPixels fails", async () => {
  installScenario({
    width: 128,
    height: 128,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: 128, bottom: 128 },
        pixels: makeImage(128, 128, 4, 1010),
      },
    ],
  });

  const created = [];
  const realGet = photoshop.imaging.getPixels;
  const realPut = photoshop.imaging.putPixels;
  photoshop.imaging.getPixels = async (...args) => {
    const result = await realGet(...args);
    created.push(result.imageData);
    return result;
  };
  photoshop.imaging.putPixels = async () => {
    throw new Error("simulated putPixels failure");
  };

  try {
    await assert.rejects(
      () => pixelateActiveLayer({ size: 16, duplicate: false }),
      /simulated putPixels failure/
    );
  } finally {
    photoshop.imaging.getPixels = realGet;
    photoshop.imaging.putPixels = realPut;
  }

  assert.ok(created.length > 0);
  for (const image of created) {
    assert.equal(image.disposed, true, "handles leaked on the failure path");
  }
  assert.equal(world.historyStates[0].committed, false, "a failed run must not commit history");
});

test("the panel registers its panel and all four commands", () => {
  const uxp = require("./fakes/uxp.js");
  require("../main.js");
  const config = uxp.__test.registrations[uxp.__test.registrations.length - 1];
  assert.ok(config.panels.truePixelate, "panel entrypoint missing");
  for (const size of [16, 32, 64, 128]) {
    assert.equal(
      typeof config.commands[`pixelate${size}`].run,
      "function",
      `command pixelate${size} missing`
    );
  }
});

test("all seven presets are wired end to end", async () => {
  for (const size of SHIPPED_SIZES) {
    const width = 1400;
    const height = 1400;
    const pixels = makeImage(width, height, 4, size);
    installScenario({
      width,
      height,
      layers: [
        {
          name: "Art",
          bounds: { left: 0, top: 0, right: width, bottom: height },
          pixels: pixels.slice(),
        },
      ],
    });
    const result = await pixelateActiveLayer({ size, duplicate: false });
    assert.equal(result.noop, false, `${size} px should not be a no-op here`);
    assert.equal(result.cells.width, size);
    assert.equal(result.cells.height, size);
    assert.equal(result.blockWidth, width / size);
  }
});

test("a large preset is a no-op on an image smaller than it", async () => {
  installScenario({
    width: 800,
    height: 600,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: 800, bottom: 600 },
        pixels: makeImage(800, 600, 4, 5),
      },
    ],
  });

  const result = await pixelateActiveLayer({ size: 1024, duplicate: true });

  assert.equal(result.noop, true);
  assert.equal(result.reason, "already-smaller");
  assert.equal(result.longEdge, 800);
  assert.equal(world.putCalls.length, 0);
  assert.equal(world.document.layers.length, 1, "a no-op must not leave a duplicate");
});

test("the panel starts on 32 px / layer bounds with both options on", () => {
  require("../main.js");

  assert.deepEqual(dom.selectedValues(dom.sizeGroup, "data-size"), ["32"]);
  assert.deepEqual(dom.selectedValues(dom.basisGroup, "data-basis"), ["layer"]);
  assert.match(dom.byId.hint.textContent, /long edge is sampled down to 32 px/);
  assert.equal(dom.byId.duplicateBox.textContent, "\u2713");
  assert.equal(dom.byId.limitToSelectionBox.textContent, "\u2713");
  assert.equal(dom.byId.run.textContent, "");
});

test("selection is shown inline as well as by class, so it survives missing CSS", () => {
  require("../main.js");
  const segments = dom.segmentsOf(dom.sizeGroup);
  const selected = segments.find((child) => child.getAttribute("data-size") === "32");
  const unselected = segments.find((child) => child.getAttribute("data-size") === "16");
  assert.match(selected.style.backgroundColor, /38, 128, 235/);
  assert.match(unselected.style.backgroundColor, /127, 127, 127/);
});

test("clicking a size segment moves the selection and the hint", () => {
  require("../main.js");
  dom.clickSegment(dom.sizeGroup, "data-size", 128);

  assert.deepEqual(dom.selectedValues(dom.sizeGroup, "data-size"), ["128"]);
  assert.match(dom.byId.hint.textContent, /down to 128 px/);
});

test("clicking a basis segment moves the selection and the hint", () => {
  require("../main.js");
  dom.clickSegment(dom.basisGroup, "data-basis", "canvas");

  assert.deepEqual(dom.selectedValues(dom.basisGroup, "data-basis"), ["canvas"]);
  assert.match(dom.byId.hint.textContent, /canvas's long edge/);

  dom.clickSegment(dom.basisGroup, "data-basis", "layer");
  assert.deepEqual(dom.selectedValues(dom.basisGroup, "data-basis"), ["layer"]);
});

test("clicking a checkbox row toggles it", () => {
  require("../main.js");
  dom.byId.duplicate.emit("click", { target: dom.byId.duplicate });
  assert.equal(dom.byId.duplicateBox.textContent, "");
  assert.equal(dom.byId.duplicateBox.classes.has("check-box-on"), false);

  dom.byId.duplicate.emit("click", { target: dom.byId.duplicate });
  assert.equal(dom.byId.duplicateBox.textContent, "\u2713");
  assert.equal(dom.byId.duplicateBox.classes.has("check-box-on"), true);
});

test("clicking through the panel pixelates at the chosen size", async () => {
  require("../main.js");
  const size = 200;
  const pixels = makeImage(size, size, 4, 1234);
  installScenario({
    width: size,
    height: size,
    layers: [
      { name: "Art", bounds: { left: 0, top: 0, right: size, bottom: size }, pixels: pixels.slice() },
    ],
  });

  // Pick 64 px and canvas basis through the UI, then hit the button.
  dom.clickSegment(dom.sizeGroup, "data-size", 64);
  dom.clickSegment(dom.basisGroup, "data-basis", "canvas");
  await Promise.all(dom.byId.run.emit("click", { target: dom.byId.run }));

  // Duplicate is on by default, so the copy carries the result.
  const copy = world.document.layers.find((layer) => layer.name === "Art [64px]");
  assert.ok(copy, "expected a duplicated layer named Art [64px]");
  assert.deepEqual(
    Array.from(copy.pixels),
    Array.from(referencePixelate(pixels, size, size, 4, 64))
  );
  assert.match(dom.byId.status.textContent, /64 x 64 blocks/);
  assert.equal(dom.byId.status.classes.has("status-error"), false);
  assert.equal(dom.byId.run.textContent, "Pixelate", "the button must be reset");

  dom.clickSegment(dom.basisGroup, "data-basis", "layer");
});

test("unticking the duplicate row pixelates in place", async () => {
  require("../main.js");
  const size = 128;
  const pixels = makeImage(size, size, 4, 2345);
  installScenario({
    width: size,
    height: size,
    layers: [
      { name: "Art", bounds: { left: 0, top: 0, right: size, bottom: size }, pixels: pixels.slice() },
    ],
  });

  dom.byId.duplicate.emit("click", { target: dom.byId.duplicate });
  dom.clickSegment(dom.sizeGroup, "data-size", 32);
  await Promise.all(dom.byId.run.emit("click", { target: dom.byId.run }));

  assert.equal(world.document.layers.length, 1, "no duplicate should have been made");
  assert.deepEqual(
    Array.from(world.document.layers[0].pixels),
    Array.from(referencePixelate(pixels, size, size, 4, 32))
  );

  dom.byId.duplicate.emit("click", { target: dom.byId.duplicate });
});

test("the panel reports errors in the status line instead of throwing", async () => {
  require("../main.js");
  installScenario({
    width: 64,
    height: 64,
    layers: [{ name: "Set", kind: LayerKind.GROUP, bounds: { left: 0, top: 0, right: 64, bottom: 64 } }],
  });

  await Promise.all(dom.byId.run.emit("click", { target: dom.byId.run }));

  assert.match(dom.byId.status.textContent, /Merge the group/i);
  assert.equal(dom.byId.status.classes.has("status-error"), true);
  assert.equal(dom.byId.run.textContent, "Pixelate");
});

test("a menu command pixelates at its own size and syncs the panel", async () => {
  const uxp = require("./fakes/uxp.js");
  require("../main.js");
  const config = uxp.__test.registrations[uxp.__test.registrations.length - 1];

  const size = 128;
  installScenario({
    width: size,
    height: size,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: size, bottom: size },
        pixels: makeImage(size, size, 4, 4321),
      },
    ],
  });

  await config.commands.pixelate16.run();

  assert.ok(
    world.document.layers.find((layer) => layer.name === "Art [16px]"),
    "the command should have produced Art [16px]"
  );
  assert.deepEqual(
    dom.selectedValues(dom.sizeGroup, "data-size"),
    ["16"],
    "the panel should follow the command's size"
  );
});

test("a fully opaque canvas-sized selection is treated as no selection", async () => {
  const size = 128;
  const pixels = makeImage(size, size, 4, 5150);
  installScenario({
    width: size,
    height: size,
    layers: [
      {
        name: "Overhang",
        // Deliberately hangs off every edge of the canvas.
        bounds: { left: -32, top: -32, right: size + 32, bottom: size + 32 },
        pixels: makeImage(size + 64, size + 64, 4, 5151),
      },
    ],
    // Select All: whole canvas, every value at full strength.
    selection: { left: 0, top: 0, right: size, bottom: size },
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: false, limitToSelection: true });

  assert.equal(result.limitedToSelection, false, "Select All should not clip anything");
  // The overhang outside the canvas must still have been pixelated.
  assert.deepEqual(world.putCalls[0].targetBounds, {
    left: -32,
    top: -32,
    right: size + 32,
    bottom: size + 32,
  });
  assert.ok(pixels.length > 0);
});

test("a shaped selection spanning the whole canvas is still respected", async () => {
  const size = 128;
  installScenario({
    width: size,
    height: size,
    layers: [
      {
        name: "Art",
        bounds: { left: 0, top: 0, right: size, bottom: size },
        pixels: makeImage(size, size, 4, 5252),
      },
    ],
    // Bounding box is the whole canvas, but the mask has holes, so this is a
    // real shape and must not be mistaken for Select All.
    selection: {
      left: 0,
      top: 0,
      right: size,
      bottom: size,
      maskAt: (x, y) => (x + y > 40 ? 255 : 0),
    },
  });

  const result = await pixelateActiveLayer({ size: 32, duplicate: false, limitToSelection: true });

  assert.equal(result.limitedToSelection, true, "a shaped selection must be honoured");
});

test("the panel, the manifest and the worker agree on the size list", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

  const literal = (source) => {
    const match = source.match(/const SIZES = \[([^\]]+)\];/);
    assert.ok(match, "no SIZES literal found");
    return match[1].split(",").map((part) => Number(part.trim()));
  };

  // main.js keeps its own copy on purpose: it must not require the worker at
  // module scope. So assert the copies agree rather than trusting them to.
  assert.deepEqual(literal(read("main.js")), SHIPPED_SIZES);

  const buttons = [...read("index.html").matchAll(/data-size="(\d+)"/g)].map((m) =>
    Number(m[1])
  );
  assert.deepEqual(buttons, SHIPPED_SIZES, "index.html buttons drifted from SIZES");

  const manifest = JSON.parse(read("manifest.json"));
  const commands = manifest.entrypoints
    .filter((entry) => entry.type === "command")
    .map((entry) => entry.id);
  assert.deepEqual(
    commands,
    SHIPPED_SIZES.map((size) => `pixelate${size}`),
    "manifest commands drifted from SIZES"
  );
  for (const size of SHIPPED_SIZES) {
    const entry = manifest.entrypoints.find((e) => e.id === `pixelate${size}`);
    assert.equal(entry.label.default, `Pixelate to ${size} px`);
  }
});

test("every manifest command is registered by the panel", () => {
  const uxp = require("./fakes/uxp.js");
  require("../main.js");
  const config = uxp.__test.registrations[uxp.__test.registrations.length - 1];
  for (const size of SHIPPED_SIZES) {
    assert.equal(
      typeof config.commands[`pixelate${size}`].run,
      "function",
      `command pixelate${size} is not registered`
    );
  }
  assert.equal(Object.keys(config.commands).length, SHIPPED_SIZES.length);
});

/* ------------------------------------------------------------------ *
 * Resilience of the panel itself. These load a fresh main.js against *
 * a fresh DOM, so they must stay last in the file.                   *
 * ------------------------------------------------------------------ */

function withSilencedErrors(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
}

test("a failure loading pixelate.js is reported in the panel, not silently", async () => {
  const freshDom = require("./fakes/dom.js").install();
  delete require.cache[require.resolve("../main.js")];

  // Break resolution of the worker module, as a host whose require() resolves
  // relative paths differently would.
  const previousResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "./pixelate.js" || request === "pixelate.js") {
      const error = new Error("Cannot find module 'pixelate.js'");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return previousResolve.call(this, request, ...rest);
  };

  try {
    require("../main.js");

    // The controls must still be alive even though the worker is unreachable.
    assert.deepEqual(freshDom.selectedValues(freshDom.sizeGroup, "data-size"), ["32"]);
    freshDom.clickSegment(freshDom.sizeGroup, "data-size", 64);
    assert.deepEqual(freshDom.selectedValues(freshDom.sizeGroup, "data-size"), ["64"]);

    await withSilencedErrors(() =>
      Promise.all(freshDom.byId.run.emit("click", { target: freshDom.byId.run }))
    );
    assert.match(freshDom.byId.status.textContent, /Couldn't load pixelate\.js/);
    assert.equal(freshDom.byId.status.classes.has("status-error"), true);
    assert.equal(freshDom.byId.run.textContent, "Pixelate");
  } finally {
    Module._resolveFilename = previousResolve;
  }
});

test("the UI still wires up when entrypoint registration fails", () => {
  const freshDom = require("./fakes/dom.js").install();
  const uxp = require("./fakes/uxp.js");
  const realSetup = uxp.entrypoints.setup;
  uxp.entrypoints.setup = () => {
    throw new Error("simulated setup failure");
  };
  delete require.cache[require.resolve("../main.js")];

  try {
    withSilencedErrors(() => require("../main.js"));

    // Wiring happens before registration, so the panel survives it failing.
    assert.deepEqual(freshDom.selectedValues(freshDom.sizeGroup, "data-size"), ["32"]);
    freshDom.clickSegment(freshDom.sizeGroup, "data-size", 16);
    assert.deepEqual(freshDom.selectedValues(freshDom.sizeGroup, "data-size"), ["16"]);
    assert.equal(freshDom.byId.duplicateBox.textContent, "✓");
    assert.match(freshDom.byId.status.textContent, /Menu commands unavailable/);
  } finally {
    uxp.entrypoints.setup = realSetup;
  }
});
