function normalizePhrase(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeManufacturerName(value = '') {
  const normalized = normalizePhrase(value);
  if (!normalized) return '';
  const aliases = new Map([
    ['baytek', 'Bay Tek'],
    ['bay tek', 'Bay Tek'],
    ['bay tek games', 'Bay Tek'],
    ['baytek games', 'Bay Tek'],
    ['raw thrills', 'Raw Thrills'],
    ['rawthrills', 'Raw Thrills'],
    ['lai', 'LAI Games'],
    ['lai games', 'LAI Games'],
    ['ice', 'ICE'],
    ['innovative concepts in entertainment', 'ICE']
  ]);
  return aliases.get(normalized) || `${value || ''}`.trim();
}

const TITLE_ALIAS_FAMILIES = [
  {
    canonical: 'Jurassic Park Arcade',
    aliases: ['Jurassic Park'],
    manufacturer: 'Raw Thrills'
  },
  {
    canonical: 'Virtual Rabbids: The Big Ride',
    aliases: [
      'Virtual Rabbids',
      'Virtual Rabbids Arcade',
      'Virtual Rabbids VR',
      'Virtual Rabbids The Big Ride Arcade',
      'Rabbids VR',
      'Rabbids VR Arcade'
    ],
    manufacturer: 'LAI Games'
  },
  {
    canonical: 'Quik Drop',
    aliases: ['Quick Drop', 'Quik Drop', 'Quickdrop'],
    manufacturer: 'Bay Tek',
    alternateTitles: ['Quick Drop']
  },
  {
    canonical: 'King Kong of Skull Island VR',
    aliases: ['King Kong VR', 'King Kong of Skull Island', 'King Kong Skull Island VR'],
    manufacturer: 'Raw Thrills'
  },
  {
    canonical: 'Fast & Furious Arcade',
    aliases: ['Fast and Furious', 'Fast & Furious', 'Fast N Furious', 'Fast and Furious Arcade'],
    manufacturer: 'Raw Thrills'
  },
  {
    canonical: 'Sink It',
    aliases: ['Sink-It', 'Sink It', 'Sink It Shootout'],
    manufacturer: 'Bay Tek',
    familyDisplayTitle: 'Sink It / Sink It Shootout',
    alternateTitles: ['Sink It Shootout'],
    variantWarning: 'Sink It family match found, but cabinet subtitle/model may still need confirmation.'
  },
  {
    canonical: 'HYPERshoot',
    aliases: ['Hypershoot', 'Hyper Shoot', 'HYPERshoot'],
    manufacturer: 'LAI Games'
  }
];

function resolveArcadeTitleFamily({ title = '', manufacturer = '' } = {}) {
  const normalizedTitle = normalizePhrase(title);
  const normalizedManufacturer = normalizePhrase(manufacturer);
  if (!normalizedTitle) {
    return {
      inputTitle: `${title || ''}`.trim(),
      canonicalTitle: '',
      manufacturer: normalizeManufacturerName(manufacturer),
      alternateTitles: [],
      variantWarning: '',
      matchedAlias: ''
    };
  }

  for (const family of TITLE_ALIAS_FAMILIES) {
    const candidates = [family.canonical, ...(family.aliases || []), ...(family.alternateTitles || []), family.familyDisplayTitle]
      .map((value) => `${value || ''}`.trim())
      .filter(Boolean);
    const normalizedCandidates = candidates.map((value) => normalizePhrase(value));
    const manufacturerMatches = !normalizedManufacturer
      || !family.manufacturer
      || normalizePhrase(family.manufacturer) === normalizedManufacturer
      || normalizedManufacturer.includes(normalizePhrase(family.manufacturer));
    if (!manufacturerMatches) continue;
    const matchIndex = normalizedCandidates.findIndex((candidate) => candidate === normalizedTitle);
    if (matchIndex === -1) continue;
    return {
      inputTitle: `${title || ''}`.trim(),
      canonicalTitle: family.canonical,
      familyDisplayTitle: family.familyDisplayTitle || family.canonical,
      manufacturer: normalizeManufacturerName(family.manufacturer || manufacturer),
      alternateTitles: Array.from(new Set([family.canonical, ...(family.aliases || []), ...(family.alternateTitles || [])].filter(Boolean))),
      variantWarning: family.variantWarning || '',
      matchedAlias: candidates[matchIndex] || ''
    };
  }

  return {
    inputTitle: `${title || ''}`.trim(),
    canonicalTitle: `${title || ''}`.trim(),
    familyDisplayTitle: `${title || ''}`.trim(),
    manufacturer: normalizeManufacturerName(manufacturer),
    alternateTitles: [`${title || ''}`.trim()].filter(Boolean),
    variantWarning: '',
    matchedAlias: `${title || ''}`.trim()
  };
}

function expandArcadeTitleAliases(values = []) {
  const queue = Array.isArray(values) ? values : [values];
  const normalized = new Set();
  const expanded = new Set();

  queue.forEach((value) => {
    const candidateText = `${value || ''}`.trim();
    const candidate = normalizePhrase(value);
    if (candidate) {
      normalized.add(candidate);
      if (candidateText) expanded.add(candidateText);
    }
  });

  for (const family of TITLE_ALIAS_FAMILIES) {
    const familyCandidates = [family.canonical, ...(family.aliases || []), ...(family.alternateTitles || []), family.familyDisplayTitle]
      .map((value) => normalizePhrase(value))
      .filter(Boolean);
    if (!familyCandidates.some((candidate) => normalized.has(candidate))) continue;
    familyCandidates.forEach((candidate) => normalized.add(candidate));
    [family.canonical, ...(family.aliases || []), ...(family.alternateTitles || []), family.familyDisplayTitle]
      .map((value) => `${value || ''}`.trim())
      .filter(Boolean)
      .forEach((value) => expanded.add(value));
  }

  return Array.from(expanded);
}

module.exports = {
  normalizePhrase,
  normalizeManufacturerName,
  resolveArcadeTitleFamily,
  expandArcadeTitleAliases
};
