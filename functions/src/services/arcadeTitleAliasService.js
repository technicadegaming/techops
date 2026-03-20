function normalizePhrase(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TITLE_ALIAS_FAMILIES = [
  {
    canonical: 'Jurassic Park Arcade',
    aliases: ['Jurassic Park']
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
    ]
  }
];

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
    const familyCandidates = [family.canonical, ...(family.aliases || [])]
      .map((value) => normalizePhrase(value))
      .filter(Boolean);
    if (!familyCandidates.some((candidate) => normalized.has(candidate))) continue;
    familyCandidates.forEach((candidate) => normalized.add(candidate));
    [family.canonical, ...(family.aliases || [])]
      .map((value) => `${value || ''}`.trim())
      .filter(Boolean)
      .forEach((value) => expanded.add(value));
  }

  return Array.from(expanded);
}

module.exports = {
  normalizePhrase,
  expandArcadeTitleAliases
};
