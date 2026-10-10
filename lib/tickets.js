'use strict';

const crypto = require('crypto');

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createTicketService(options = {}) {
  const secret = String(options.secret || '');
  const allowedSourceIds = options.allowedSourceIds || new Set();
  const overrideSourceId = String(options.overrideSourceId || 'override');
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || Date.now;

  if (!secret) throw new Error('Ticket service requires a signing secret');

  function sign(kind, payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${kind}|${body}`)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  function verify(kind, ticket) {
    const parts = String(ticket || '').split('.');
    if (parts.length !== 2) return null;
    const [body, signature] = parts;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${kind}|${body}`)
      .digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      return {
        payload,
        expired: Boolean(Number(payload.e)) && now() > Number(payload.e)
      };
    } catch (_) {
      return null;
    }
  }

  function createStream(sourceId, ttlMs, extra = null) {
    return sign('stream-ticket', {
      i: sourceId,
      n: randomBytes(8).toString('hex'),
      e: now() + ttlMs,
      ...(extra || {})
    });
  }

  function verifyStream(ticket) {
    const verified = verify('stream-ticket', ticket);
    if (!verified) return null;
    const sourceId = String(verified.payload.i || '');
    if (!allowedSourceIds.has(sourceId) && sourceId !== overrideSourceId) return null;
    return {
      sourceId,
      exp: Number(verified.payload.e) || 0,
      expired: verified.expired,
      u: verified.payload.u ? String(verified.payload.u) : ''
    };
  }

  function createSite(ttlMs) {
    return sign('site-ticket', {
      n: randomBytes(8).toString('hex'),
      e: now() + ttlMs
    });
  }

  function verifySite(ticket) {
    const verified = verify('site-ticket', ticket);
    if (!verified || verified.expired) return null;
    return { exp: Number(verified.payload.e) || 0 };
  }

  return { sign, verify, createStream, verifyStream, createSite, verifySite };
}

module.exports = { createTicketService, safeEqual };
