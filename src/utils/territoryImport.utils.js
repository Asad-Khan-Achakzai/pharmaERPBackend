/**
 * Column mapping helpers for bulk territory Excel import (Phase 4).
 * Each row describes ZONE → AREA → BRICK (three fixed levels).
 */

const FIELDS = ['zone', 'area', 'brick_code', 'brick', 'is_active'];

const FIELD_LABELS = {
  zone: 'Zone name',
  area: 'Area name',
  brick: 'Brick name',
  brick_code: 'Brick code (optional)',
  is_active: 'Active (optional)'
};

const REQUIRED_FIELDS = ['zone', 'area', 'brick'];

const normHeader = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');

const SCORE = {
  zone: [/zone/],
  area: [/^area$/, /area name/],
  brick: [/brick name/, /^brick$/, /^territory$/],
  brick_code: [/brick.?code/, /^code$/],
  is_active: [/active/, /is.?active/, /^status$/]
};

const inferMapping = (headers) => {
  const mapping = { zone: null, area: null, brick: null, brick_code: null, is_active: null };
  const used = new Set();
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i];
    const key = normHeader(h);
    if (!key) continue;
    for (const field of FIELDS) {
      if (mapping[field]) continue;
      const patterns = SCORE[field];
      if (!patterns) continue;
      if (patterns.some((rx) => rx.test(key))) {
        mapping[field] = h;
        used.add(i);
        break;
      }
    }
  }
  const priority = ['zone', 'area', 'brick'];
  let pi = 0;
  for (let i = 0; i < headers.length && pi < priority.length; i += 1) {
    if (used.has(i)) continue;
    const h = headers[i];
    if (!h || !String(h).trim()) continue;
    const f = priority[pi];
    if (!mapping[f]) {
      mapping[f] = h;
      used.add(i);
      pi += 1;
    }
  }
  return mapping;
};

/** Extract cell from row object using header label from mapping */
const cell = (row, mapping, field) => {
  const h = mapping[field];
  if (!h || !row) return '';
  const v = row[h];
  return v == null ? '' : String(v).trim();
};

const parseBool = (raw) => {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return true;
  if (['n', 'no', '0', 'false', 'inactive', 'off'].includes(s)) return false;
  if (['y', 'yes', '1', 'true', 'active', 'on'].includes(s)) return true;
  return true;
};

const buildRowPayload = (row, mapping) => ({
  zone: cell(row, mapping, 'zone'),
  area: cell(row, mapping, 'area'),
  brick: cell(row, mapping, 'brick'),
  brick_code: cell(row, mapping, 'brick_code') || null,
  is_active: parseBool(cell(row, mapping, 'is_active'))
});

module.exports = {
  FIELDS,
  FIELD_LABELS,
  REQUIRED_FIELDS,
  inferMapping,
  buildRowPayload,
  parseBool,
  cell
};
