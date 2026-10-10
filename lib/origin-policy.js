'use strict';

function normalizeOrigin(value) {
  if (!value) return '';
  try { return new URL(value).origin.replace(/\/$/, ''); } catch (_) {
    return String(value).replace(/\/$/, '');
  }
}

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map(item => normalizeOrigin(item.trim()))
    .filter(Boolean);
}

function hostnameFromUrl(value) {
  if (!value) return '';
  try { return new URL(value).hostname.toLowerCase(); } catch (_) { return ''; }
}

function isLocalOrigin(origin) {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(origin).hostname); } catch (_) {
    return false;
  }
}

function isPreviewOrigin(origin) {
  try { return new URL(origin).hostname.endsWith('.e2b.app'); } catch (_) { return false; }
}

function createOriginPolicy(options = {}) {
  const authorizedHostname = String(options.authorizedHostname || '').toLowerCase();
  const allowedOrigins = new Set(options.allowedOrigins || []);
  const production = Boolean(options.production);

  function isAuthorizedHostname(value) {
    const hostname = String(value || '').split(':')[0].toLowerCase();
    if (hostname === authorizedHostname) return true;
    return authorizedHostname.endsWith('.netlify.app') &&
      hostname.length > authorizedHostname.length + 2 &&
      hostname.endsWith(`--${authorizedHostname}`);
  }

  function requestOrigin(req) {
    const origin = normalizeOrigin(req.headers.origin || '');
    if (origin) return origin;
    const host = req.headers.host;
    if (!host) return '';
    const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    return `${protocol}://${host}`;
  }

  function isSameOriginRequest(req, origin) {
    if (!origin || !req.headers.host) return false;
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocols = new Set([req.protocol || 'http', 'http', 'https']);
    if (forwarded) protocols.add(forwarded);
    return [...protocols].some(protocol =>
      normalizeOrigin(`${protocol}://${req.headers.host}`) === origin
    );
  }

  function isAllowedOrigin(req, origin) {
    if (!origin) return true;
    if (allowedOrigins.has(origin) || isSameOriginRequest(req, origin)) return true;
    if (isAuthorizedHostname(hostnameFromUrl(origin))) return true;
    return !production && (isLocalOrigin(origin) || isPreviewOrigin(origin));
  }

  return {
    getRequestOrigin: requestOrigin,
    isAllowedOrigin,
    isAuthorizedHostname,
    isSameOriginRequest
  };
}

module.exports = {
  createOriginPolicy,
  hostnameFromUrl,
  isLocalOrigin,
  isPreviewOrigin,
  normalizeOrigin,
  parseOrigins
};
