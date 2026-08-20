"use strict";

/*
 * Stand-in for the `photoshop` module, faithful enough to exercise
 * pixelate.js end to end under plain Node: a document with real pixel
 * buffers, an Imaging API that reads and writes them, and layers that can be
 * duplicated and rasterized.
 *
 * Tests drive it through installScenario() and then inspect the resulting
 * pixels and the recorded putPixels calls.
 */

const LAYER_KINDS = [
  "NORMAL",
  "GROUP",
  "TEXT",
  "SMARTOBJECT",
  "SOLIDFILL",
  "GRADIENTFILL",
  "PATTERNFILL",
  "VIDEO",
  "LAYER3D",
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

const constants = {
  LayerKind: {},
  RasterizeType: { ENTIRELAYER: "entireLayer" },
};
for (const key of LAYER_KINDS) {
  constants.LayerKind[key] = `kind:${key}`;
}

const world = {
  document: null,
  selection: null, // {left, top, right, bottom, maskAt?(x, y) -> 0..255}
  putCalls: [],
  alerts: [],
  historyStates: [],
  rasterized: [],
  nextLayerID: 1,
};

class FakeImageData {
  constructor(buffer, options) {
    this.buffer = buffer;
    this.width = options.width;
    this.height = options.height;
    this.components = options.components;
    this.componentSize = options.componentSize;
    this.colorSpace = options.colorSpace;
    this.colorProfile = options.colorProfile;
    this.hasAlpha = options.hasAlpha;
    this.disposed = false;
  }
  async getData() {
    if (this.disposed) throw new Error("getData() after dispose()");
    return this.buffer;
  }
  dispose() {
    this.disposed = true;
  }
}

class FakeLayer {
  constructor(config) {
    this.id = config.id !== undefined ? config.id : world.nextLayerID++;
    this.name = config.name || `Layer ${this.id}`;
    this.kind = config.kind || constants.LayerKind.NORMAL;
    this.bounds = { ...config.bounds };
    this.allLocked = config.allLocked || false;
    this.pixelsLocked = config.pixelsLocked || false;
    this.components = config.components !== undefined ? config.components : 4;
    this.hasAlpha = config.hasAlpha !== undefined ? config.hasAlpha : this.components === 4;
    this.componentSize = config.componentSize || 8;
    this.colorSpace = config.colorSpace || "RGB";
    this.colorProfile = config.colorProfile;
    const width = this.bounds.right - this.bounds.left;
    const height = this.bounds.bottom - this.bounds.top;
    const Ctor = config.arrayType || Uint8Array;
    this.pixels = config.pixels || new Ctor(Math.max(0, width * height * this.components));
  }

  get boundsNoEffects() {
    return { ...this.bounds };
  }

  async duplicate() {
    const copy = new FakeLayer({
      name: `${this.name} copy`,
      kind: this.kind,
      bounds: this.bounds,
      components: this.components,
      hasAlpha: this.hasAlpha,
      componentSize: this.componentSize,
      colorSpace: this.colorSpace,
      colorProfile: this.colorProfile,
      pixels: this.pixels.slice(),
    });
    copy.duplicatedFrom = this.id;
    world.document.layers.unshift(copy);
    world.document.activeLayers = [copy];
    return copy;
  }

  async rasterize(target) {
    world.rasterized.push({ layerID: this.id, target });
    this.kind = constants.LayerKind.NORMAL;
  }
}

class FakeDocument {
  constructor(config) {
    this.id = config.id || 1;
    this.width = config.width;
    this.height = config.height;
    this.layers = config.layers;
    this.activeLayers = config.activeLayers || [config.layers[0]];
  }
}

/** Read a rect out of a layer, zero-filled where the rect leaves its data. */
function readRect(layer, rect) {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const out = new layer.pixels.constructor(width * height * layer.components);
  const lw = layer.bounds.right - layer.bounds.left;
  const lh = layer.bounds.bottom - layer.bounds.top;
  for (let y = 0; y < height; y++) {
    const ly = rect.top + y - layer.bounds.top;
    if (ly < 0 || ly >= lh) continue;
    for (let x = 0; x < width; x++) {
      const lx = rect.left + x - layer.bounds.left;
      if (lx < 0 || lx >= lw) continue;
      const to = (y * width + x) * layer.components;
      const from = (ly * lw + lx) * layer.components;
      for (let c = 0; c < layer.components; c++) out[to + c] = layer.pixels[from + c];
    }
  }
  return out;
}

/** Write a rect into a layer, growing its bounds as Photoshop would. */
function writeRect(layer, rect, buffer, components) {
  const union = {
    left: Math.min(layer.bounds.left, rect.left),
    top: Math.min(layer.bounds.top, rect.top),
    right: Math.max(layer.bounds.right, rect.right),
    bottom: Math.max(layer.bounds.bottom, rect.bottom),
  };
  if (
    union.left !== layer.bounds.left ||
    union.top !== layer.bounds.top ||
    union.right !== layer.bounds.right ||
    union.bottom !== layer.bounds.bottom
  ) {
    const grown = new layer.pixels.constructor(
      (union.right - union.left) * (union.bottom - union.top) * layer.components
    );
    const oldWidth = layer.bounds.right - layer.bounds.left;
    const oldHeight = layer.bounds.bottom - layer.bounds.top;
    const newWidth = union.right - union.left;
    for (let y = 0; y < oldHeight; y++) {
      const ny = layer.bounds.top + y - union.top;
      for (let x = 0; x < oldWidth; x++) {
        const nx = layer.bounds.left + x - union.left;
        const to = (ny * newWidth + nx) * layer.components;
        const from = (y * oldWidth + x) * layer.components;
        for (let c = 0; c < layer.components; c++) grown[to + c] = layer.pixels[from + c];
      }
    }
    layer.pixels = grown;
    layer.bounds = union;
  }

  const lw = layer.bounds.right - layer.bounds.left;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  for (let y = 0; y < height; y++) {
    const ly = rect.top + y - layer.bounds.top;
    for (let x = 0; x < width; x++) {
      const lx = rect.left + x - layer.bounds.left;
      const to = (ly * lw + lx) * layer.components;
      const from = (y * width + x) * components;
      for (let c = 0; c < layer.components; c++) layer.pixels[to + c] = buffer[from + c];
    }
  }
}

const imaging = {
  async getPixels(options) {
    const layer = world.document.layers.find((l) => l.id === options.layerID);
    if (!layer) throw new Error(`no layer ${options.layerID}`);
    const rect = options.sourceBounds;
    const buffer = readRect(layer, rect);
    return {
      sourceBounds: { ...rect },
      imageData: new FakeImageData(buffer, {
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        components: layer.components,
        componentSize: layer.componentSize,
        colorSpace: layer.colorSpace,
        colorProfile: layer.colorProfile,
        hasAlpha: layer.hasAlpha,
      }),
    };
  },

  async putPixels(options) {
    const layer = world.document.layers.find((l) => l.id === options.layerID);
    if (!layer) throw new Error(`no layer ${options.layerID}`);
    const image = options.imageData;
    if (image.disposed) throw new Error("putPixels received a disposed imageData");
    const rect = options.targetBounds;
    if ((rect.right - rect.left) !== image.width || (rect.bottom - rect.top) !== image.height) {
      throw new Error(
        `targetBounds ${image.width}x${image.height} mismatch: ` +
          `${rect.right - rect.left}x${rect.bottom - rect.top}`
      );
    }
    const expected = image.width * image.height * image.components;
    if (image.buffer.length !== expected) {
      throw new Error(`buffer length ${image.buffer.length}, expected ${expected}`);
    }
    world.putCalls.push({
      layerID: options.layerID,
      targetBounds: { ...rect },
      replace: options.replace,
      components: image.components,
    });
    writeRect(layer, rect, image.buffer, image.components);
  },

  async createImageDataFromBuffer(buffer, options) {
    if (!options.width || !options.height || !options.components || !options.colorSpace) {
      throw new Error("createImageDataFromBuffer missing a required option");
    }
    const componentSize =
      buffer instanceof Uint8Array ? 8 : buffer instanceof Uint16Array ? 16 : 32;
    return new FakeImageData(buffer, {
      ...options,
      componentSize,
      hasAlpha: options.components === 4,
    });
  },

  async getSelection(options) {
    if (!world.selection) {
      const error = new Error("No selection");
      error.number = -1;
      throw error;
    }
    const sel = world.selection;
    const rect = options.sourceBounds || {
      left: sel.left,
      top: sel.top,
      right: sel.right,
      bottom: sel.bottom,
    };
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const cy = rect.top + y;
      for (let x = 0; x < width; x++) {
        const cx = rect.left + x;
        const inside = cx >= sel.left && cx < sel.right && cy >= sel.top && cy < sel.bottom;
        if (!inside) continue;
        mask[y * width + x] = sel.maskAt ? sel.maskAt(cx, cy) : 255;
      }
    }
    return {
      sourceBounds: { ...rect },
      imageData: new FakeImageData(mask, {
        width,
        height,
        components: 1,
        componentSize: 8,
        colorSpace: "Grayscale",
        hasAlpha: false,
      }),
    };
  },
};

const core = {
  async executeAsModal(fn, options) {
    const hostControl = {
      async suspendHistory(config) {
        world.historyStates.push({ ...config, committed: null });
        return world.historyStates.length - 1;
      },
      async resumeHistory(id, commit) {
        world.historyStates[id].committed = commit;
      },
    };
    return fn({ hostControl }, options && options.descriptor);
  },
  async showAlert(options) {
    world.alerts.push(options.message);
  },
};

const app = {
  get activeDocument() {
    return world.document;
  },
};

function installScenario(config) {
  world.document = null;
  world.selection = null;
  world.putCalls = [];
  world.alerts = [];
  world.historyStates = [];
  world.rasterized = [];
  world.nextLayerID = 1;

  if (!config) return world;

  const layers = (config.layers || []).map((layer) => new FakeLayer(layer));
  world.document = new FakeDocument({
    id: config.documentID || 1,
    width: config.width,
    height: config.height,
    layers,
    activeLayers:
      config.activeLayerIndexes !== undefined
        ? config.activeLayerIndexes.map((i) => layers[i])
        : [layers[0]],
  });
  world.selection = config.selection || null;
  return world;
}

module.exports = {
  app,
  core,
  constants,
  imaging,
  action: { async batchPlay() { return []; } },
  __test: { installScenario, world, FakeLayer, readRect },
};
