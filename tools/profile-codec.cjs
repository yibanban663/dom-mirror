'use strict';
const sharp = require('sharp');
const { frameCropInput } = require('../lib/frame-codec');

// Keep the original PNG path available for controlled comparisons.
module.exports = function codecInput(png, decoded, reuse) {
  return reuse ? frameCropInput(sharp, png, decoded) : sharp(png);
};
