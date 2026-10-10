'use strict';

const fs = require('fs');
const path = require('path');

function hasIndex(directory) {
  if (!directory || !fs.existsSync(directory)) return false;
  try {
    if (fs.existsSync(path.join(directory, 'index.html'))) return true;
    return fs.readdirSync(directory, { withFileTypes: true }).some(entry =>
      entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'index.html'))
    );
  } catch (_) {
    return false;
  }
}

function resolveDirectory(configured, candidates) {
  if (hasIndex(configured)) return configured;
  for (const candidate of candidates) if (hasIndex(candidate)) return candidate;
  if (configured && fs.existsSync(configured)) return configured;
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return configured || candidates[0] || null;
}

function resolveSiteDirectory(configured, candidates) {
  if (hasIndex(configured)) return configured;
  for (const candidate of candidates) if (hasIndex(candidate)) return candidate;
  return null;
}

function findIndex(directory) {
  if (!directory) return null;
  const direct = path.join(directory, 'index.html');
  if (fs.existsSync(direct)) return direct;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(directory, entry.name, 'index.html');
      if (fs.existsSync(nested)) return nested;
    }
  } catch (_) {}
  return null;
}

module.exports = { findIndex, hasIndex, resolveDirectory, resolveSiteDirectory };
