const DISPLAY_ALIASES = new Map([
  ['baytek', 'Bay Tek'],
  ['bay tek', 'Bay Tek'],
  ['bay tek games', 'Bay Tek'],
  ['baytek games', 'Bay Tek'],
  ['baytek entertainment', 'Bay Tek'],
  ['bay tek entertainment', 'Bay Tek'],
  ['baytek ent', 'Bay Tek'],
  ['bay tek ent', 'Bay Tek'],
  ['rawthrills', 'Raw Thrills'],
  ['raw thrills', 'Raw Thrills'],
  ['innovative concepts in entertainment', 'ICE']
]);

function normalizeManufacturerDisplayName(value = '') {
  const raw = `${value || ''}`.trim();
  if (!raw) return '';
  const normalizedKey = raw.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (DISPLAY_ALIASES.has(normalizedKey)) return DISPLAY_ALIASES.get(normalizedKey);
  return raw;
}

export { normalizeManufacturerDisplayName };
