'use strict';

/*
 * Minimal Redis command adapter.
 *
 * Production prefers a normal Redis/Valkey URL (Redis Cloud, Render Key Value,
 * or any compatible service). The old Upstash REST variables remain accepted
 * so existing deployments can migrate without losing data. Both transports
 * expose the response shape the application has always consumed:
 *
 *   command(['GET', 'key'])                  -> { result }
 *   command([['SET', ...], ['GET', ...]])    -> [{ result }, { result }]
 */

function timeoutAfter(ms, label) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function withTimeout(promise, ms, label) {
  const timeout = timeoutAfter(ms, label);
  return Promise.race([promise, timeout.promise]).finally(timeout.cancel);
}

function normalizeCommand(command) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new TypeError('Redis command must be a non-empty array');
  }
  return command.map(value => Buffer.isBuffer(value) ? value : String(value));
}

function createRedisTransport(url, timeoutMs, logger, createClientOverride = null) {
  let client = null;
  let connectPromise = null;
  let closing = false;

  async function connectedClient() {
    if (closing) throw new Error('Redis transport is closed');
    if (client?.isReady || client?.isOpen) return client;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      // Loaded only when REDIS_URL is configured. Local/test installs and old
      // Upstash deployments do not pay the module's memory/startup cost.
      const createClient = createClientOverride || require('redis').createClient;
      const next = createClient({
        url,
        socket: {
          connectTimeout: timeoutMs,
          reconnectStrategy(retries) {
            if (retries >= 5) return new Error('Redis reconnect budget exhausted');
            return Math.min(100 * (2 ** retries), 2_000);
          }
        }
      });
      next.on('error', error => logger(`[Storage] Redis connection error: ${error.message}`));
      try {
        await withTimeout(next.connect(), timeoutMs, 'Redis connect');
        client = next;
        return next;
      } catch (error) {
        try { next.destroy(); } catch (_) {}
        throw error;
      }
    })();

    try {
      return await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  function abandonTimedOutClient(redis, error) {
    if (!/ timed out$/i.test(String(error?.message || '')) || client !== redis) return;
    // node-redis queues commands during reconnect. Destroy on our own deadline
    // so a write the application already treated as failed cannot run later.
    try { redis.destroy(); } catch (_) {}
    client = null;
  }

  async function command(input) {
    const redis = await connectedClient();
    const pipeline = Array.isArray(input?.[0]);
    try {
      if (!pipeline) {
        const result = await withTimeout(
          redis.sendCommand(normalizeCommand(input)),
          timeoutMs,
          `Redis ${String(input?.[0] || 'command')}`
        );
        return { result };
      }

      // MULTI preserves ordering for dependent command pairs such as SADD/SCARD.
      const transaction = redis.multi();
      input.forEach(item => transaction.addCommand(normalizeCommand(item)));
      const results = await withTimeout(transaction.exec(), timeoutMs, 'Redis transaction');
      return results.map(result => ({ result }));
    } catch (error) {
      abandonTimedOutClient(redis, error);
      throw error;
    }
  }

  async function close() {
    closing = true;
    let current = client;
    if (!current && connectPromise) {
      try { current = await connectPromise; } catch (_) {}
    }
    client = null;
    if (!current?.isOpen) return;
    try { await current.close(); } catch (_) {
      try { current.destroy(); } catch (_) {}
    }
  }

  return { command, close };
}

function createUpstashTransport(baseUrl, token, timeoutMs) {
  async function command(commands) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const pipeline = Array.isArray(commands?.[0]);
      const response = await fetch(`${baseUrl}${pipeline ? '/pipeline' : ''}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(commands),
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(payload.error);
      if (Array.isArray(payload)) {
        const failed = payload.find(item => item?.error);
        if (failed) throw new Error(failed.error);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return { command, close: async () => {} };
}

function createDurableStore(options = {}) {
  const redisUrl = String(options.redisUrl || '').trim();
  const upstashUrl = String(options.upstashUrl || '').replace(/\/+$/, '');
  const upstashToken = String(options.upstashToken || '');
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 3_500);
  const logger = typeof options.logger === 'function' ? options.logger : console.warn;

  if (redisUrl) {
    const transport = createRedisTransport(redisUrl, timeoutMs, logger, options.createRedisClient);
    return { enabled: true, provider: 'redis', ...transport };
  }
  if (upstashUrl && upstashToken) {
    const transport = createUpstashTransport(upstashUrl, upstashToken, timeoutMs);
    return { enabled: true, provider: 'upstash', ...transport };
  }
  return {
    enabled: false,
    provider: 'local',
    command: async () => { throw new Error('A durable Redis store is not configured'); },
    close: async () => {}
  };
}

module.exports = { createDurableStore, normalizeCommand };
