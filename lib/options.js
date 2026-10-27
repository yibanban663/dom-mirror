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

function normalizeTransferOptions(value, name, maxBytesDefault, maxBytesMax, extensionsDefault) {
  if (value === undefined) value = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const maxBytes = value.maxBytes === undefined ? maxBytesDefault
    : integer(value.maxBytes, maxBytesDefault, 1, maxBytesMax, `${name}.maxBytes`);
  let extensions = extensionsDefault;
  if (value.extensions !== undefined) {
    if (!Array.isArray(value.extensions) || !value.extensions.length
      || value.extensions.some(item => typeof item !== 'string' || !/^[a-z0-9]{1,12}$/i.test(item))) {
      throw new TypeError(`${name}.extensions must be a non-empty array of extension strings`);
    }
    extensions = [...new Set(value.extensions.map(item => item.toLowerCase()))];
  }
  return { maxBytes, extensions };
}

function normalizeOptions(options = {}) {
  const originUrl = httpUrl(options.originUrl).href;
  const defaultMode = options.defaultMode ?? 'dom';
  if (!['dom', 'frame'].includes(defaultMode)) throw new TypeError('defaultMode must be dom or frame');
  const presentation = options.presentation ?? 'embedded';
  if (!['embedded', 'demo'].includes(presentation)) throw new TypeError('presentation must be embedded or demo');
  const allowedOrigins = options.allowedOrigins ?? [];
  if (!Array.isArray(allowedOrigins)) throw new TypeError('allowedOrigins must be an array');
  const crossOriginFrameOrigins = options.crossOriginFrameOrigins ?? [];
  if (!Array.isArray(crossOriginFrameOrigins)) throw new TypeError('crossOriginFrameOrigins must be an array');
  const requestOrigins = options.requestOrigins ?? [];
  if (!Array.isArray(requestOrigins)) throw new TypeError('requestOrigins must be an array');
  const logger = options.logger ?? console;
  if (typeof logger.log !== 'function') throw new TypeError('logger.log must be a function');
  const obfuscate = options.obfuscate ?? true;
  if (typeof obfuscate !== 'boolean') throw new TypeError('obfuscate must be a boolean');
  const canvasStream = options.canvasStream ?? true;
  const elbit = options.elbit ?? true;
  if (typeof elbit !== 'boolean') throw new TypeError('elbit must be a boolean');
  if (typeof canvasStream !== 'boolean') throw new TypeError('canvasStream must be a boolean');
  // v0.29：2D 指令流每画布 10s 滚动字节预算（超限自动转位图捕获，0=不限）
  const canvasOpsBudget = options.canvasOpsBudget ?? 100000;
  if (typeof canvasOpsBudget !== 'number' || !(canvasOpsBudget >= 0)) throw new TypeError('canvasOpsBudget must be a non-negative number');
  const chromiumSandbox = options.chromiumSandbox ?? true;
  if (typeof chromiumSandbox !== 'boolean') throw new TypeError('chromiumSandbox must be a boolean');
  const maskInputTypes = options.maskInputTypes ?? [];
  if (!Array.isArray(maskInputTypes) || maskInputTypes.some(t => typeof t !== 'string' || !/^[a-z0-9-]{1,20}$/i.test(t))) {
    throw new TypeError('maskInputTypes must be an array of input type strings');
  }
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
  const upload = normalizeTransferOptions(options.upload, 'upload', 8 * 1024 * 1024, 64 * 1024 * 1024,
    ['txt', 'md', 'csv', 'json', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip']);
  const download = normalizeTransferOptions(options.download, 'download', 32 * 1024 * 1024, 128 * 1024 * 1024, []);
  upload.maxTotalBytes = integer(options.upload?.maxTotalBytes, upload.maxBytes * 2, 1, 256 * 1024 * 1024, 'upload.maxTotalBytes');
  upload.maxConcurrent = integer(options.upload?.maxConcurrent, 2, 1, 8, 'upload.maxConcurrent');
  upload.idleTimeoutMs = integer(options.upload?.idleTimeoutMs, 30000, 100, 300000, 'upload.idleTimeoutMs');
  return {
    originUrl, defaultMode, presentation, logger,
    allowedOrigins: allowedOrigins.map(value => httpUrl(value).origin),
    crossOriginFrameOrigins: crossOriginFrameOrigins.map(value => httpUrl(value).origin),
    requestOrigins: requestOrigins.map(value => httpUrl(value).origin),
    width: integer(options.width, 1280, 320, 2560, 'width'),
    height: integer(options.height, 800, 240, 1600, 'height'),
    maxSessions: integer(options.maxSessions, 3, 1, Number.MAX_SAFE_INTEGER, 'maxSessions'),
    sessionGraceMs: integer(options.sessionGraceMs, 60000, 0, 300000, 'sessionGraceMs'),
    obfuscate, launchOptions, canvasStream, canvasOpsBudget, elbit, chromiumSandbox,
    maskInputTypes: new Set(maskInputTypes.map(t => t.toLowerCase())),
    redactAttributes: [...new Set(attributes.map(name => name.toLowerCase()))],
    getSessionIdentity: options.getSessionIdentity,
    upload, download,
  };
}

module.exports = { normalizeOptions };
