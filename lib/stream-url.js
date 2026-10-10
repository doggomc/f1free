'use strict';

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || ['localhost', '::1', '0.0.0.0'].includes(host)) return true;
  if (/^(127|10|0)\./.test(host)) return true;
  if (/^192\.168\./.test(host) || /^169\.254\./.test(host) || /^100\.64\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^(fc00:|fd00:|fe80:)/i.test(host)) return true;
  return false;
}

function youtubeId(url) {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
  if (!['youtube.com', 'youtube-nocookie.com', 'm.youtube.com'].includes(host)) return null;
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const parts = url.pathname.split('/').filter(Boolean);
  return ['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] || null : null;
}

function classifyStreamUrl(value, options = {}) {
  if (!value) return { type: null, embedUrl: null };
  let url;
  try { url = new URL(String(value).trim()); } catch (_) {
    return { type: null, embedUrl: null };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { type: null, embedUrl: null };
  if (options.rejectPrivateHosts && isPrivateHostname(url.hostname)) {
    return { type: null, embedUrl: null };
  }

  const id = youtubeId(url);
  if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
    return {
      type: 'youtube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`
    };
  }

  const pathAndQuery = url.pathname + url.search;
  if (/\.webm(?:\?.*)?$/i.test(pathAndQuery)) return { type: 'webm', embedUrl: url.href };
  if (/\.mp4(?:\?.*)?$/i.test(pathAndQuery)) return { type: 'mp4', embedUrl: url.href };
  return { type: 'embed', embedUrl: url.href };
}

module.exports = { classifyStreamUrl, isPrivateHostname, youtubeId };
