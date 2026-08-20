/*
 * Panel wiring.
 *
 * Deliberate constraint: nothing at module scope touches `photoshop` or `uxp`.
 * If loading those modules can fail, and it can, then doing it up here means a
 * failure leaves the panel drawn but completely dead -- no selection
 * highlight, no clicks, no feedback, nothing in the panel to explain why. So
 * the UI is wired first from plain DOM only, and the Photoshop side is pulled
 * in lazily on the first run, where any failure has somewhere visible to go.
 */

"use strict";

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const BASIS_LAYER = "layer";
const BASIS_CANVAS = "canvas";

const SELECTED_BACKGROUND = "rgba(38, 128, 235, 0.95)";
const UNSELECTED_BACKGROUND = "rgba(127, 127, 127, 0.2)";
const UNCHECKED_BACKGROUND = "rgba(127, 127, 127, 0.22)";

const state = {
  size: 32,
  basis: BASIS_LAYER,
  duplicate: true,
  limitToSelection: true,
  busy: false,
};

const ui = {};
let wired = false;
let pixelateModule = null;

/* ---------------------------------------------------------------- *
 * Lazy access to the Photoshop side                                *
 * ---------------------------------------------------------------- */

/**
 * Load pixelate.js on first use.
 *
 * Tries both spellings of the specifier because UXP's resolver is not Node's
 * and has been inconsistent about whether a relative path is relative to the
 * requiring file or to the plugin root. Every plugin module sits in the plugin
 * root precisely so both readings land on the same file.
 */
function loadPixelateModule() {
  if (pixelateModule) return pixelateModule;
  const attempts = ["./pixelate.js", "pixelate.js"];
  let lastError = null;
  for (const specifier of attempts) {
    try {
      pixelateModule = require(specifier);
      if (pixelateModule && pixelateModule.pixelateActiveLayer) return pixelateModule;
      pixelateModule = null;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError && lastError.message ? `: ${lastError.message}` : "";
  throw new Error(`Couldn't load pixelate.js${detail}`);
}

/* ---------------------------------------------------------------- *
 * Rendering                                                        *
 * ---------------------------------------------------------------- */

function round1(value) {
  return Math.round(value * 10) / 10;
}

function setStatus(message, isError) {
  if (!ui.status) return;
  ui.status.textContent = message || "";
  if (isError) ui.status.classList.add("status-error");
  else ui.status.classList.remove("status-error");
}

function updateHint() {
  if (!ui.hint) return;
  const subject = state.basis === BASIS_CANVAS ? "The canvas" : "The layer";
  ui.hint.textContent =
    `${subject}'s long edge is sampled down to ${state.size} px, then scaled ` +
    "straight back up. Nothing is resized.";
}

/**
 * Paint one segment. The background is set inline as well as by class so the
 * selection stays visible even if the stylesheet never loaded -- that being
 * the difference between "this control looks plain" and "this control looks
 * broken".
 */
function paintSegment(segment, selected) {
  if (selected) segment.classList.add("segment-selected");
  else segment.classList.remove("segment-selected");
  if (segment.style) {
    segment.style.backgroundColor = selected ? SELECTED_BACKGROUND : UNSELECTED_BACKGROUND;
  }
}

function paintGroup(group, attribute, value) {
  if (!group) return;
  const segments = group.querySelectorAll(".segment");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    paintSegment(segment, String(segment.getAttribute(attribute)) === String(value));
  }
}

function paintCheck(name) {
  const box = ui[`${name}Box`];
  if (!box) return;
  const on = state[name] === true;
  box.textContent = on ? "✓" : "";
  if (on) box.classList.add("check-box-on");
  else box.classList.remove("check-box-on");
  if (box.style) {
    box.style.backgroundColor = on ? SELECTED_BACKGROUND : UNCHECKED_BACKGROUND;
  }
}

function setBusy(busy) {
  state.busy = busy;
  if (!ui.run) return;
  ui.run.textContent = busy ? "Working…" : "Pixelate";
  if (busy) ui.run.classList.add("run-busy");
  else ui.run.classList.remove("run-busy");
}

/* ---------------------------------------------------------------- *
 * Reporting                                                        *
 * ---------------------------------------------------------------- */

function describeResult(result) {
  if (!result) return "Finished, but Photoshop reported nothing back.";
  if (result.noop) {
    switch (result.reason) {
      case "already-smaller":
        return `Nothing to do: the long edge is already ${result.longEdge} px, at or below ${result.size} px.`;
      case "empty-layer":
      case "empty-grid":
        return "That layer has no pixels to pixelate.";
      case "selection-misses-layer":
        return "The active selection doesn't overlap the layer.";
      default:
        return "Nothing to do.";
    }
  }

  const wide = round1(result.blockWidth);
  const tall = round1(result.blockHeight);
  const block = wide === tall ? `${wide} px` : `${wide} x ${tall} px`;
  let text = `${result.cells.width} x ${result.cells.height} blocks of ${block}`;
  if (result.limitedToSelection) text += ", inside the selection";
  text += `, on "${result.layerName}".`;
  return text;
}

function errorMessage(error) {
  if (!error) return "Something went wrong.";
  if (error.expected) return error.message;
  const label = error.name && error.name !== "Error" ? `${error.name}: ` : "";
  return `${label}${error.message || String(error)}`;
}

/* ---------------------------------------------------------------- *
 * Running                                                          *
 * ---------------------------------------------------------------- */

async function pixelate(size) {
  const { pixelateActiveLayer } = loadPixelateModule();
  return pixelateActiveLayer({
    size,
    basis: state.basis,
    duplicate: state.duplicate,
    limitToSelection: state.limitToSelection,
  });
}

async function run() {
  if (state.busy) return;
  setBusy(true);
  setStatus("Working…", false);
  try {
    setStatus(describeResult(await pixelate(state.size)), false);
  } catch (error) {
    setStatus(errorMessage(error), true);
    if (!error || !error.expected) console.error(error);
  } finally {
    setBusy(false);
  }
}

/** Plugins-menu commands reuse whatever the panel's other options are set to. */
async function runFromCommand(size) {
  if (state.busy) return;
  state.size = size;
  paintGroup(ui.sizeGroup, "data-size", size);
  updateHint();
  setBusy(true);
  try {
    const result = await pixelate(size);
    const message = describeResult(result);
    setStatus(message, false);
    if (result && result.noop) await showAlert(message);
  } catch (error) {
    const message = errorMessage(error);
    setStatus(message, true);
    if (!error || !error.expected) console.error(error);
    await showAlert(message);
  } finally {
    setBusy(false);
  }
}

/** Best-effort alert: a command run may have no visible panel to report into. */
async function showAlert(message) {
  try {
    const { core } = require("photoshop");
    if (core && core.showAlert) await core.showAlert({ message });
  } catch (error) {
    console.error(error);
  }
}

/* ---------------------------------------------------------------- *
 * Wiring                                                           *
 * ---------------------------------------------------------------- */

function wireUp() {
  if (wired) return true;
  if (typeof document === "undefined" || !document.getElementById) return false;

  ui.sizeGroup = document.getElementById("sizeGroup");
  ui.basisGroup = document.getElementById("basisGroup");
  ui.duplicate = document.getElementById("duplicate");
  ui.duplicateBox = document.getElementById("duplicateBox");
  ui.limitToSelection = document.getElementById("limitToSelection");
  ui.limitToSelectionBox = document.getElementById("limitToSelectionBox");
  ui.run = document.getElementById("run");
  ui.status = document.getElementById("status");
  ui.hint = document.getElementById("hint");

  // The body may not be parsed yet; let the caller retry.
  if (!ui.sizeGroup || !ui.run) return false;

  // A listener per segment: no event delegation, so nothing depends on
  // event.target or Element.closest() behaving like it does in a browser.
  const segments = ui.sizeGroup.querySelectorAll(".segment");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const size = Number(segment.getAttribute("data-size"));
    if (SIZES.indexOf(size) === -1) continue;
    segment.addEventListener("click", () => {
      if (state.busy) return;
      state.size = size;
      paintGroup(ui.sizeGroup, "data-size", size);
      updateHint();
    });
  }

  if (ui.basisGroup) {
    const options = ui.basisGroup.querySelectorAll(".segment");
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const basis = option.getAttribute("data-basis");
      if (basis !== BASIS_LAYER && basis !== BASIS_CANVAS) continue;
      option.addEventListener("click", () => {
        if (state.busy) return;
        state.basis = basis;
        paintGroup(ui.basisGroup, "data-basis", basis);
        updateHint();
      });
    }
  }

  for (const name of ["duplicate", "limitToSelection"]) {
    const row = ui[name];
    if (!row) continue;
    row.addEventListener("click", () => {
      if (state.busy) return;
      state[name] = !state[name];
      paintCheck(name);
    });
  }

  ui.run.addEventListener("click", run);

  paintGroup(ui.sizeGroup, "data-size", state.size);
  paintGroup(ui.basisGroup, "data-basis", state.basis);
  paintCheck("duplicate");
  paintCheck("limitToSelection");
  updateHint();
  setStatus("", false);

  wired = true;
  return true;
}

/** Register the panel and the four menu commands. Never blocks the UI. */
function registerEntrypoints() {
  try {
    const { entrypoints } = require("uxp");
    entrypoints.setup({
      panels: {
        truePixelate: {
          show() {},
        },
      },
      commands: SIZES.reduce((commands, size) => {
        commands[`pixelate${size}`] = { run: () => runFromCommand(size) };
        return commands;
      }, {}),
    });
    return true;
  } catch (error) {
    // The panel still works; only the Plugins-menu commands are missing.
    console.error(error);
    setStatus(`Menu commands unavailable: ${errorMessage(error)}`, true);
    return false;
  }
}

function bootstrap() {
  const ready = wireUp();
  if (!ready) {
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("DOMContentLoaded", wireUp);
    }
    if (typeof setTimeout === "function") setTimeout(wireUp, 0);
  }
  registerEntrypoints();
}

bootstrap();
