const { isLosslessNumber, isSafeNumber, LosslessNumber, parse, stringify } = require('lossless-json');

class InputError extends Error {}

function parseJson(text) {
  return parse(text, undefined, token => isSafeNumber(token) ? Number(token) : new LosslessNumber(token));
}

function readJson(text, label) {
  try {
    return parseJson(text);
  } catch {
    throw new InputError(`${label}: некорректный JSON.`);
  }
}

function clone(value) {
  return parseJson(stringify(value));
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isLosslessNumber(value);
}

function pathParts(path) {
  if (path === '' || path === '$') return [];
  if (typeof path !== 'string') throw new InputError('Ожидается путь к полю JSON.');
  const parts = path.replace(/^\$\./, '').split('.');
  if (parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new InputError('Недопустимый путь к полю JSON.');
  }
  return parts;
}

function get(value, path) {
  for (const part of pathParts(path)) {
    if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function set(target, path, value) {
  const parts = pathParts(path);
  const key = parts.pop();
  if (!key) throw new InputError('Укажите имя параметра.');
  for (const part of parts) {
    if (!Object.hasOwn(target, part)) target[part] = {};
    if (!object(target[part])) throw new InputError('Конфликт вложенных параметров запроса.');
    target = target[part];
  }
  target[key] = value;
}

function integer(value) {
  if (Number.isSafeInteger(value)) return BigInt(value);
  if (isLosslessNumber(value) && /^-?\d+$/.test(value.value)) return BigInt(value.value);
  return null;
}

function scalarText(value) {
  if (value === null || value === undefined) return '';
  if (isLosslessNumber(value)) return value.value;
  if (typeof value === 'object') return stringify(value);
  return String(value);
}

function publicValue(value) {
  if (isLosslessNumber(value)) return value.value;
  if (Array.isArray(value)) return value.map(publicValue);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, publicValue(child)]));
  return value;
}

function inferShape(value, depth = 0) {
  if (value === null) return 'null';
  if (isLosslessNumber(value)) return integer(value) === null ? 'number' : 'int64';
  if (depth === 6) return Array.isArray(value) ? [] : object(value) ? {} : typeof value;
  if (Array.isArray(value)) return value.length ? [inferShape(value[0], depth + 1)] : [];
  if (object(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, child]) => [key, inferShape(child, depth + 1)]));
  }
  return typeof value;
}

module.exports = { InputError, clone, get, inferShape, integer, isLosslessNumber, object, parseJson,
  pathParts, publicValue, readJson, scalarText, set, stringify };
