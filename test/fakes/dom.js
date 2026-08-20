"use strict";

/*
 * Just enough DOM for main.js to wire itself up and be clicked, so the
 * UI -> options -> pixels path is covered rather than assumed. Mirrors
 * index.html: plain divs, no widget layer.
 */

class FakeElement {
  constructor(spec = {}) {
    this.id = spec.id;
    this.attrs = spec.attrs || {};
    this.classes = new Set(spec.classes || []);
    this.children = [];
    this.listeners = {};
    this.textContent = "";
    this.style = {};
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  /** Fire listeners and hand back their return values so tests can await. */
  emit(type, event) {
    const handlers = this.listeners[type] || [];
    return handlers.map((handler) => handler(event || { target: this }));
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  setAttribute(name, value) {
    this.attrs[name] = value;
  }

  get classList() {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }

  querySelectorAll(selector) {
    const wanted = selector.replace(/^\./, "");
    return this.children.filter((child) => child.classes.has(wanted));
  }
}

/** Mirrors index.html closely enough that main.js finds every element. */
function install() {
  const byId = {};
  const make = (spec) => {
    const element = new FakeElement(spec);
    if (spec.id) byId[spec.id] = element;
    return element;
  };

  const sizeGroup = make({ id: "sizeGroup" });
  for (const size of [16, 32, 64, 128]) {
    sizeGroup.children.push(
      new FakeElement({ classes: ["segment"], attrs: { "data-size": String(size) } })
    );
  }

  const basisGroup = make({ id: "basisGroup" });
  for (const basis of ["layer", "canvas"]) {
    basisGroup.children.push(
      new FakeElement({ classes: ["segment"], attrs: { "data-basis": basis } })
    );
  }

  make({ id: "duplicate", classes: ["check"] });
  make({ id: "duplicateBox", classes: ["check-box"] });
  make({ id: "limitToSelection", classes: ["check"] });
  make({ id: "limitToSelectionBox", classes: ["check-box"] });
  make({ id: "run", classes: ["run"] });
  make({ id: "status", classes: ["status"] });
  make({ id: "hint", classes: ["hint"] });

  const document = {
    readyState: "complete",
    getElementById: (id) => byId[id] || null,
    querySelector: () => null,
    addEventListener: () => {},
  };

  global.document = document;

  /** Click the segment carrying the given attribute value. */
  const clickSegment = (group, attribute, value) => {
    const segment = group.children.find(
      (child) => child.getAttribute(attribute) === String(value)
    );
    if (!segment) throw new Error(`no segment with ${attribute}=${value}`);
    return segment.emit("click", { target: segment });
  };

  const selectedValues = (group, attribute) =>
    group.children
      .filter((child) => child.classes.has("segment-selected"))
      .map((child) => child.getAttribute(attribute));

  return { document, byId, sizeGroup, basisGroup, clickSegment, selectedValues };
}

module.exports = { install, FakeElement };
