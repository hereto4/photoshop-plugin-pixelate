/*
 * Photoshop side of True Pixelate: validate the selection, read the layer's
 * pixels with the Imaging API, run them through the nearest-neighbour maps,
 * and write them straight back. The pixel maths lives in nn.js; the rectangle
 * maths lives in plan.js.
 */

"use strict";

const { app, core, constants, imaging } = require("photoshop");

const { buildSampleMap, remapPixels, blendWithMask } = require("./nn.js");
const { planPixelation, BASIS_LAYER, BASIS_CANVAS } = require("./plan.js");

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

/** Errors we raise ourselves and are happy to show the user verbatim. */
class PixelateError extends Error {
  constructor(message) {
    super(message);
    this.name = "PixelateError";
    this.expected = true;
  }
}

const ADJUSTMENT_KIND_NAMES = [
  "BLACKANDWHITE",
  "BRIGHTNESSCONTRAST",
  "CHANNELMIXER",
  "CLARITY",
  "COLORBALANCE",
  "COLORLOOKUP",
  "CURVES",
  "EXPOSURE",
  "GRADIENTMAP",
  "GRAIN",
  "HUESATURATION",
  "INVERSION",
  "LEVELS",
  "PHOTOFILTER",
  "POSTERIZE",
  "SELECTIVECOLOR",
  "THRESHOLD",
  "VIBRANCE",
];

/** Kinds that hold no pixels of their own but can be rasterized into some. */
const RASTERIZABLE_KIND_LABELS = [
  ["TEXT", "type"],
  ["SMARTOBJECT", "Smart Object"],
  ["SOLIDFILL", "solid colour fill"],
  ["GRADIENTFILL", "gradient fill"],
  ["PATTERNFILL", "pattern fill"],
];

let kindTables = null;

/**
 * Resolve the LayerKind enum lazily, on first use rather than at import time.
 *
 * Reading the enum while this module loads would take the whole panel down if
 * a Photoshop build ever renamed or dropped a member: the panel would come up
 * with dead controls and no clue why. Resolving late turns that same surprise
 * into one readable error from a button press.
 */
function layerKinds() {
  if (kindTables) return kindTables;
  const enumeration = (constants && constants.LayerKind) || {};
  kindTables = {
    NORMAL: enumeration.NORMAL,
    GROUP: enumeration.GROUP,
    VIDEO: enumeration.VIDEO,
    LAYER3D: enumeration.LAYER3D,
    adjustments: new Set(
      ADJUSTMENT_KIND_NAMES.map((name) => enumeration[name]).filter(
        (kind) => kind !== undefined
      )
    ),
    rasterizable: new Map(
      RASTERIZABLE_KIND_LABELS.filter(([name]) => enumeration[name] !== undefined).map(
        ([name, label]) => [enumeration[name], label]
      )
    ),
  };
  return kindTables;
}

/** The rasterize target, with a literal fallback if the enum is unavailable. */
function entireLayerRasterizeType() {
  const enumeration = constants && constants.RasterizeType;
  return (enumeration && enumeration.ENTIRELAYER) || "entireLayer";
}

/**
 * Bounds and dimensions come back as plain numbers in current Photoshop, but
 * older/odd paths hand back unit objects. Normalise both to integer pixels.
 */
function toPixels(value) {
  if (value && typeof value === "object" && "_value" in value) {
    return Math.round(value._value);
  }
  return Math.round(value);
}

function normalizeBounds(bounds) {
  return {
    left: toPixels(bounds.left),
    top: toPixels(bounds.top),
    right: toPixels(bounds.right),
    bottom: toPixels(bounds.bottom),
  };
}

function maxValueFor(componentSize) {
  if (componentSize === 32) return 1;
  if (componentSize === 16) return 65535;
  return 255;
}

/**
 * Refuse early, with a message that says what to do about it, rather than
 * letting putPixels fail deep inside a modal scope.
 */
function assertPixelatable(layer, willDuplicate) {
  const kind = layer.kind;
  const kinds = layerKinds();

  if (kind !== undefined && kind === kinds.GROUP) {
    throw new PixelateError(
      "Groups can't be pixelated directly. Merge the group (Cmd/Ctrl+E) or convert it to a Smart Object first."
    );
  }
  if (kinds.adjustments.has(kind)) {
    throw new PixelateError(
      "Adjustment layers hold no pixels. Select the layer whose pixels you want to pixelate."
    );
  }
  if (kind !== undefined && (kind === kinds.VIDEO || kind === kinds.LAYER3D)) {
    throw new PixelateError("Video and 3D layers aren't supported. Rasterize the layer first.");
  }
  if (kind === kinds.NORMAL) {
    return;
  }
  if (kinds.rasterizable.has(kind)) {
    if (willDuplicate) return; // the copy gets rasterized for us
    throw new PixelateError(
      `A ${kinds.rasterizable.get(kind)} layer has to be rasterized before its pixels can be edited. ` +
        "Turn on “Work on a duplicate layer” and the plugin will rasterize the copy instead, " +
        "or rasterize this layer yourself."
    );
  }
  throw new PixelateError("This layer type can't be pixelated. Rasterize it first.");
}

/**
 * Bounds of the active selection in pixels, or null when nothing is selected.
 *
 * Deliberately goes through imaging.getSelection rather than reading the
 * document's `selection` descriptor: that descriptor reports in whatever the
 * ruler units happen to be, while getSelection always answers in pixels. The
 * probe mask is thrown away immediately.
 */
async function getSelectionBounds(documentID, canvas) {
  let probe = null;
  try {
    probe = await imaging.getSelection({ documentID });
  } catch (error) {
    return null; // no active selection
  }
  try {
    if (!probe || !probe.sourceBounds) return null;
    const bounds = normalizeBounds(probe.sourceBounds);
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;

    // A canvas-sized, fully opaque mask is how some builds report "nothing is
    // selected", and it is also exactly what Select All gives. Either way it
    // means "clip nothing", so treat it as no selection -- which additionally
    // stops a layer's off-canvas overhang being clipped away.
    const coversCanvas =
      bounds.left <= 0 &&
      bounds.top <= 0 &&
      bounds.right >= canvas.width &&
      bounds.bottom >= canvas.height;
    if (coversCanvas && probe.imageData && (await isFullyOpaque(probe.imageData))) {
      return null;
    }
    return bounds;
  } finally {
    if (probe && probe.imageData) probe.imageData.dispose();
  }
}

/** True when every value in a selection mask is at full strength. */
async function isFullyOpaque(maskImage) {
  const mask = await maskImage.getData({ chunky: true, fullRange: true });
  const full = maxValueFor(maskImage.componentSize);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] < full) return false;
  }
  return true;
}

async function prepareTargetLayer(layer, options) {
  let target = layer;

  if (options.duplicate) {
    target = await layer.duplicate();
    if (!target) {
      throw new PixelateError("Couldn't duplicate the layer.");
    }
    if (layerKinds().rasterizable.has(target.kind)) {
      await target.rasterize(entireLayerRasterizeType());
    }
    target.name = `${layer.name} [${options.size}px]`;
  }

  // A locked layer silently rejects pixel writes; unlock what we must.
  if (target.allLocked) target.allLocked = false;
  if (target.pixelsLocked) target.pixelsLocked = false;

  return target;
}

/**
 * Pixelate one layer. Runs the whole job inside a single modal scope with
 * history suspended, so the result is one undo step called "Pixelate 32 px".
 *
 * @param {object} options
 * @param {number}  options.size              16 | 32 | 64 | 128
 * @param {string} [options.basis]            "layer" (default) or "canvas"
 * @param {boolean}[options.duplicate]        work on a copy (default true)
 * @param {boolean}[options.limitToSelection] respect an active selection (default true)
 * @returns {Promise<object>} a summary for the panel to report
 */
async function pixelateActiveLayer(options) {
  const size = Number(options.size);
  if (!SIZES.includes(size)) {
    throw new PixelateError(
      `Unsupported size ${options.size}. Choose one of ${SIZES.join(", ")}.`
    );
  }
  const basis = options.basis === BASIS_CANVAS ? BASIS_CANVAS : BASIS_LAYER;
  const duplicate = options.duplicate !== false;
  const limitToSelection = options.limitToSelection !== false;

  const doc = app.activeDocument;
  if (!doc) {
    throw new PixelateError("Open a document first.");
  }

  const selected = doc.activeLayers;
  if (!selected || selected.length === 0) {
    throw new PixelateError("Select a layer in the Layers panel first.");
  }
  if (selected.length > 1) {
    throw new PixelateError(
      `Select a single layer — ${selected.length} layers are selected.`
    );
  }

  const sourceLayer = selected[0];
  assertPixelatable(sourceLayer, duplicate);

  const documentID = doc.id;
  const canvas = { width: toPixels(doc.width), height: toPixels(doc.height) };

  return core.executeAsModal(
    async (executionContext) => {
      const hostControl = executionContext.hostControl;
      const suspensionID = await hostControl.suspendHistory({
        documentID,
        name: `Pixelate ${size} px`,
      });
      let committed = false;
      try {
        const result = await runPixelation({
          documentID,
          sourceLayer,
          canvas,
          size,
          basis,
          duplicate,
          limitToSelection,
        });
        committed = !result.noop;
        return result;
      } finally {
        // Nothing changed on a no-op, so drop the history step instead of
        // leaving the user an undo that does nothing.
        await hostControl.resumeHistory(suspensionID, committed);
      }
    },
    { commandName: `Pixelate ${size} px` }
  );
}

async function runPixelation(context) {
  const {
    documentID,
    sourceLayer,
    canvas,
    size,
    basis,
    duplicate,
    limitToSelection,
  } = context;

  const selectionBounds = limitToSelection
    ? await getSelectionBounds(documentID, canvas)
    : null;

  // Peek at the source layer's geometry before duplicating, so a no-op costs
  // the user nothing -- no stray copy left behind in the stack.
  const preview = planPixelation({
    layerBounds: normalizeBounds(sourceLayer.boundsNoEffects),
    canvas,
    basis,
    size,
    selectionBounds,
  });
  if (preview.noop) {
    return { noop: true, reason: preview.reason, size, basis, longEdge: preview.longEdge };
  }

  const target = await prepareTargetLayer(sourceLayer, { duplicate, size });

  // Rasterizing can move the bounds, so re-read them from the real target.
  const layerBounds = normalizeBounds(target.boundsNoEffects);
  const plan = planPixelation({ layerBounds, canvas, basis, size, selectionBounds });
  if (plan.noop) {
    return { noop: true, reason: plan.reason, size, basis, longEdge: plan.longEdge };
  }

  const { readRect, writeRect, gridRect, cells } = plan;

  let source = null;
  let outputImage = null;
  let maskImage = null;
  try {
    source = await imaging.getPixels({
      documentID,
      layerID: target.id,
      sourceBounds: readRect,
      componentSize: -1, // keep the document's native bit depth
      applyAlpha: false, // straight alpha in, straight alpha out
    });

    const sourceData = source.imageData;
    const components = sourceData.components;
    const hasAlpha = sourceData.hasAlpha;
    const componentSize = sourceData.componentSize;
    const buffer = await sourceData.getData({ chunky: true, fullRange: true });

    // getPixels can hand back a rect that differs from the one we asked for
    // (clipped to real data), so trust what it reports.
    const actualRead = source.sourceBounds ? normalizeBounds(source.sourceBounds) : readRect;
    const srcRect = {
      left: actualRead.left,
      top: actualRead.top,
      width: sourceData.width,
      height: sourceData.height,
    };

    const outWidth = writeRect.right - writeRect.left;
    const outHeight = writeRect.bottom - writeRect.top;

    const colMap = buildSampleMap(
      writeRect.left,
      outWidth,
      gridRect.left,
      gridRect.right - gridRect.left,
      cells.width
    );
    const rowMap = buildSampleMap(
      writeRect.top,
      outHeight,
      gridRect.top,
      gridRect.bottom - gridRect.top,
      cells.height
    );

    const output = new buffer.constructor(outWidth * outHeight * components);
    remapPixels({
      src: buffer,
      srcRect,
      dst: output,
      dstRect: { left: writeRect.left, top: writeRect.top, width: outWidth, height: outHeight },
      components,
      colMap,
      rowMap,
      // With an alpha channel, sampling past the layer's data means
      // transparent. Without one (Background layer) zeroes would read as
      // black, so hold the edge pixel instead.
      fillOutOfRange: hasAlpha,
    });

    if (plan.limitedToSelection) {
      maskImage = await imaging.getSelection({ documentID, sourceBounds: writeRect });
      const mask = await maskImage.imageData.getData({ chunky: true, fullRange: true });

      // The originals for the same rect, so soft mask edges fade back to them.
      const baseline = new buffer.constructor(outWidth * outHeight * components);
      const identityCols = new Int32Array(outWidth);
      for (let x = 0; x < outWidth; x++) identityCols[x] = writeRect.left + x;
      const identityRows = new Int32Array(outHeight);
      for (let y = 0; y < outHeight; y++) identityRows[y] = writeRect.top + y;
      remapPixels({
        src: buffer,
        srcRect,
        dst: baseline,
        dstRect: { left: writeRect.left, top: writeRect.top, width: outWidth, height: outHeight },
        components,
        colMap: identityCols,
        rowMap: identityRows,
        fillOutOfRange: hasAlpha,
      });

      blendWithMask({
        base: baseline,
        pixelated: output,
        mask,
        pixelCount: outWidth * outHeight,
        components,
        hasAlpha,
        maxValue: maxValueFor(componentSize),
        maskMaxValue: maxValueFor(maskImage.imageData.componentSize),
        integer: componentSize !== 32,
      });
    }

    const createOptions = {
      width: outWidth,
      height: outHeight,
      components,
      colorSpace: sourceData.colorSpace,
      chunky: true,
      fullRange: true,
    };
    if (sourceData.colorProfile) {
      createOptions.colorProfile = sourceData.colorProfile;
    }
    outputImage = await imaging.createImageDataFromBuffer(output, createOptions);

    await imaging.putPixels({
      documentID,
      layerID: target.id,
      imageData: outputImage,
      targetBounds: {
        left: writeRect.left,
        top: writeRect.top,
        right: writeRect.right,
        bottom: writeRect.bottom,
      },
      replace: true,
    });

    return {
      noop: false,
      size,
      basis,
      duplicated: duplicate,
      layerName: target.name,
      cells: { width: cells.width, height: cells.height },
      blockWidth: plan.blockWidth,
      blockHeight: plan.blockHeight,
      writeRect,
      limitedToSelection: plan.limitedToSelection,
      colorSpace: sourceData.colorSpace,
      componentSize,
    };
  } finally {
    if (source && source.imageData) source.imageData.dispose();
    if (maskImage && maskImage.imageData) maskImage.imageData.dispose();
    if (outputImage) outputImage.dispose();
  }
}

module.exports = {
  SIZES,
  PixelateError,
  pixelateActiveLayer,
  BASIS_LAYER,
  BASIS_CANVAS,
};
