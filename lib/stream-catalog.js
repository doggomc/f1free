'use strict';

const SOURCES = Object.freeze([
  { id: 'sky-sports-f1', label: 'Sky Sports F1' },
  { id: 'westream', label: 'WeStream F1' },
  { id: 'sky-uk-2', label: 'Sky UK 2' },
  { id: 'sky-uk', label: 'Sky UHD' },
  { id: 'f1tv', label: 'F1TV' },
  { id: 'appletv', label: 'AppleTV' },
  { id: 'dazn', label: 'DAZN' },
  { id: 'wikisport', label: 'WikiSport' }
].map(source => Object.freeze(source)));

const SOURCE_IDS = new Set(SOURCES.map(source => source.id));
const RETIRED_RELAY_IDS = new Set(['cdnlivetv-f1', 'strmfree-f1']);
const ALLOWED_TEMPLATE_FIELDS = new Set([
  'season', 'eventSlug', 'sessionSlug', 'eastSlug', 'streamNum'
]);

function validTargetUrl(value, options = {}) {
  if (typeof value !== 'string' || value.length > 500) return false;
  if (/^https:\/\//i.test(value)) return true;
  return Boolean(options.allowLoopback) &&
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(value);
}

function targetTemplateFields(value) {
  return [...String(value || '').matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]);
}

function validateTargetMap(value, options = {}) {
  const errors = [];
  const targets = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: ['target map must be an object'], targets };
  }
  for (const [id, entry] of Object.entries(value)) {
    if (!SOURCE_IDS.has(id)) {
      errors.push(`unknown source id: ${id}`);
      continue;
    }
    const url = entry && typeof entry === 'object' ? entry.url : entry;
    if (!validTargetUrl(url, options)) {
      errors.push(`${id}: target must be a valid HTTPS URL`);
      continue;
    }
    const unknownFields = targetTemplateFields(url).filter(field => !ALLOWED_TEMPLATE_FIELDS.has(field));
    if (unknownFields.length) {
      errors.push(`${id}: unknown template field(s): ${[...new Set(unknownFields)].join(', ')}`);
      continue;
    }
    targets.set(id, { url: String(url) });
  }
  return { errors, targets };
}

module.exports = {
  ALLOWED_TEMPLATE_FIELDS,
  RETIRED_RELAY_IDS,
  SOURCES,
  SOURCE_IDS,
  targetTemplateFields,
  validateTargetMap,
  validTargetUrl
};
