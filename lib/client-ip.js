'use strict';

const net = require('net');

/* Addresses that cannot safely identify an internet viewer. A private value
   either means local traffic or a proxy configuration that did not expose the
   actual client. */
function isPrivateIp(value) {
  const ip = String(value || '').trim().toLowerCase();
  if (!ip || ip === 'unknown') return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip === '::') return true;
  if (ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.') || ip.startsWith('::ffff:172.')) return true;
  return false;
}

/* Strip ports/brackets, unwrap IPv4-mapped IPv6, and collapse loopback
   spellings. Returns an empty string for an unusable unspecified address. */
function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip === '::1') return '127.0.0.1';
  if (ip === '::') return '';
  return ip;
}

/* Build the request resolver once at startup. The configured edge header is
   only trusted through a private socket; a request that reaches Node directly
   can never override its public socket address with a forged header. */
function createClientIpResolver(options = {}) {
  const headerName = String(options.headerName || '').trim().toLowerCase();
  return function getClientIp(req = {}) {
    const socketIp = normalizeIp(req.socket?.remoteAddress);
    if (socketIp && !isPrivateIp(socketIp)) return socketIp;

    if (headerName) {
      const edgeIp = normalizeIp(String(req.headers?.[headerName] || '').split(',')[0]);
      if (edgeIp && net.isIP(edgeIp) && !isPrivateIp(edgeIp)) return edgeIp;
    }

    const proxyIp = normalizeIp(req.ip);
    if (proxyIp && !isPrivateIp(proxyIp)) return proxyIp;

    return proxyIp || socketIp || 'unknown';
  };
}

module.exports = { createClientIpResolver, isPrivateIp, normalizeIp };
