#!/usr/bin/env node
'use strict';

/* One-time migration from the legacy Upstash REST database to REDIS_URL.
 * Values are never printed. The default is a read-only inventory; pass --apply
 * to write the destination after checking the summary. */

const { createDurableStore } = require('../lib/durable-store.js');

const apply = process.argv.includes('--apply');
const upstashUrl = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const upstashToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const redisUrl = String(process.env.REDIS_URL || '').trim();

if (!upstashUrl || !upstashToken || !redisUrl) {
  console.error('Set UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN and REDIS_URL.');
  process.exit(1);
}

const source = createDurableStore({ upstashUrl, upstashToken, timeoutMs: 10_000 });
const destination = createDurableStore({ redisUrl, timeoutMs: 10_000 });

async function command(store, args) {
  return (await store.command(args))?.result;
}

async function keys() {
  const found = new Set();
  let cursor = '0';
  do {
    const result = await command(source, ['SCAN', cursor, 'MATCH', 'freef1:*', 'COUNT', '200']);
    if (!Array.isArray(result) || result.length < 2) throw new Error('Unexpected SCAN response');
    cursor = String(result[0]);
    for (const key of result[1] || []) found.add(String(key));
  } while (cursor !== '0');
  return [...found].sort();
}

function hashPairs(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, String(item)]);
  return [];
}

async function expiryArgs(key) {
  const ttl = Number(await command(source, ['PTTL', key]));
  return ttl > 0 ? ['PX', String(ttl)] : [];
}

async function copyString(key) {
  const value = await command(source, ['GET', key]);
  if (value == null) return;
  await destination.command(['SET', key, String(value), ...(await expiryArgs(key))]);
}

async function copySet(key) {
  const members = await command(source, ['SMEMBERS', key]);
  await destination.command(['DEL', key]);
  for (let i = 0; i < (members || []).length; i += 500) {
    await destination.command(['SADD', key, ...members.slice(i, i + 500).map(String)]);
  }
  const expiry = await expiryArgs(key);
  if (expiry.length) await destination.command(['PEXPIRE', key, expiry[1]]);
}

async function copyHash(key) {
  const fields = hashPairs(await command(source, ['HGETALL', key]));
  await destination.command(['DEL', key]);
  for (let i = 0; i < fields.length; i += 500) {
    await destination.command(['HSET', key, ...fields.slice(i, i + 500)]);
  }
  const expiry = await expiryArgs(key);
  if (expiry.length) await destination.command(['PEXPIRE', key, expiry[1]]);
}

(async () => {
  const allKeys = await keys();
  const counts = {};
  const records = [];
  for (const key of allKeys) {
    const type = String(await command(source, ['TYPE', key]) || 'none').toLowerCase();
    counts[type] = (counts[type] || 0) + 1;
    records.push({ key, type });
  }

  console.log(`Found ${records.length} FreeF1 key(s): ${Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(', ') || 'none'}.`);
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to copy them to REDIS_URL.');
    return;
  }

  let copied = 0;
  for (const record of records) {
    if (record.type === 'string') await copyString(record.key);
    else if (record.type === 'set') await copySet(record.key);
    else if (record.type === 'hash') await copyHash(record.key);
    else throw new Error(`Unsupported Redis type ${record.type} at ${record.key}`);
    copied++;
    if (copied % 25 === 0 || copied === records.length) console.log(`Copied ${copied}/${records.length} keys.`);
  }
  console.log('Migration complete. Start the service with REDIS_URL; keep the old database until healthz reports redis.');
})().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.allSettled([source.close(), destination.close()]);
});
