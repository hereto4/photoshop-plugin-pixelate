"use strict";

const registrations = [];

module.exports = {
  entrypoints: {
    setup(config) {
      registrations.push(config);
    },
  },
  __test: { registrations },
};
