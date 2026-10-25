'use strict';

function integer(value, fallback, min, max, name) {
  value ??= fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('origin URLs must use HTTP(S) without credentials');
  }
  return url;
}

function normalizeOptions(options = {}) {
  const originUrl = httpUrl(options.originUrl).href;
  const defaultMode = options.defaultMode ?? 'dom';
  if (!['dom', 'frame'].includes(defaultMode)) throw new TypeError('defaultMode must be dom or frame');
  const presentation = options.presentation ?? 'embedded';
  if (!['embedded', 'demo'].includes(presentation)) throw new TypeError('presentation must be embedded or demo');
  const allowedOrigins = options.allowedOrigins ?? [];
  if (!Array.isArray(allowedOrigins)) throw new TypeError('allowedOrigins must be an array');
  const logger = options.logger ?? console;
  if (typeof logger.log !== 'function') throw new TypeError('logger.log must be a function');
  const obfuscate = options.obfuscate ?? true;
  if (typeof obfuscate !== 'boolean') throw new TypeError('obfuscate must be a boolean');
  const launchOptions = options.launchOptions ?? {};
  if (typeof launchOptions !== 'object' || Array.isArray(launchOptions)) {
    throw new TypeError('launchOptions must be an object');
  }
  const attributes = options.redactAttributes ?? [];
  if (!Array.isArray(attributes) || attributes.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9:_-]*$/i.test(name))) {
    throw new TypeError('redactAttributes must be an array of attribute names');
  }
  if (options.getSessionIdentity !== undefined && typeof options.getSessionIdentity !== 'function') {
    throw new TypeError('getSessionIdentity must be a synchronous function');
  }
  return {
    originUrl, defaultMode, presentation, logger,
    allowedOrigins: allowedOrigins.map(value => httpUrl(value).origin),
    width: integer(options.width, 1280, 320, 2560, 'width'),
    height: integer(options.height, 800, 240, 1600, 'height'),
    maxSessions: integer(options.maxSessions, 3, 1, Number.MAX_SAFE_INTEGER, 'maxSessions'),
    sessionGraceMs: integer(options.sessionGraceMs, 60000, 0, 300000, 'sessionGraceMs'),
    obfuscate, launchOptions,
    redactAttributes: [...new Set(attributes.map(name => name.toLowerCase()))],
    getSessionIdentity: options.getSessionIdentity,
  };
}

module.exports = { normalizeOptions };
