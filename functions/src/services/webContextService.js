function normalizeCodeToken(value = '') {
  const raw = `${value || ''}`.trim().toUpperCase();
  if (!raw) return '';
  const spaced = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const match = spaced.match(/^([A-Z]{1,4})\s*(\d{1,4})$/);
  if (match) return `${match[1]}${Number(match[2])}`;
  const numeric = spaced.match(/^(?:ERROR(?:\s+CODE)?|CODE)\s*(\d{1,4})$/);
  if (numeric) return `E${Number(numeric[1])}`;
  return spaced.replace(/\s+/g, '');
}

function isWebSearchEnabled(settings = {}) {
  return settings.aiUseWebSearch === true || settings.operationsWebResearchEnabled === true;
}

function buildTargetedQueries({ asset = {}, task = {}, codeTokens = [] } = {}) {
  const assetName = `${asset.name || task.assetName || ''}`.trim();
  const manufacturer = `${asset.manufacturer || ''}`.trim();
  const firstCode = codeTokens[0] || '';
  const codeDigits = `${firstCode}`.match(/\d{1,4}/)?.[0] || '';
  if (!assetName || !firstCode) return [];
  return [
    `${assetName} ${manufacturer} ${firstCode} manual`.replace(/\s+/g, ' ').trim(),
    `${assetName} error ${codeDigits || firstCode}`.trim(),
    `${assetName} card dispenser error`.trim()
  ];
}

function extractCodeDefinitionFromSource(source = {}, codeTokens = []) {
  const text = `${source.title || ''} ${source.snippet || ''}`.trim();
  if (!text) return null;
  for (const code of codeTokens) {
    const codeDigits = `${code}`.match(/\d{1,4}/)?.[0] || '';
    const regexes = [
      new RegExp(`\\b${code}\\b\\s*(?:[:\\-—]|means|=)\\s*([^.;\\n]{4,220})`, 'i'),
      codeDigits ? new RegExp(`\\bERROR\\s*${codeDigits}\\b\\s*(?:[:\\-—]|means|=)\\s*([^.;\\n]{4,220})`, 'i') : null
    ].filter(Boolean);
    for (const regex of regexes) {
      const match = text.match(regex);
      if (match?.[1]) {
        return {
          sourceType: 'web_code_definition',
          code,
          matchedCode: code,
          meaning: `${match[1]}`.trim(),
          sourceUrl: source.url || '',
          sourceTitle: source.title || source.url || '',
          excerpt: `${text}`.slice(0, 420)
        };
      }
    }
  }
  return null;
}

async function fetchWebContextForTask({
  db,
  taskId,
  settings,
  traceId,
  task = {},
  asset = {},
  taskTokens = {},
  searchWeb = null
}) {
  if (!isWebSearchEnabled(settings)) return { summary: null, sources: [], cacheHit: false, enabled: false, disabledReason: 'disabled_by_settings' };
  const cacheRef = db.collection('aiWebContextCache').doc(taskId);
  const cached = await cacheRef.get();
  if (cached.exists) {
    const payload = cached.data();
    return { summary: payload.summary || null, sources: payload.sources || [], cacheHit: true, enabled: true, configured: payload.configured !== false };
  }

  if (typeof searchWeb !== 'function') {
    const payload = {
      summary: 'Web research is not configured. AI is using manuals/internal data only.',
      sources: [],
      configured: false,
      traceId,
      createdAt: new Date().toISOString()
    };
    await cacheRef.set(payload, { merge: true });
    return { ...payload, cacheHit: false, enabled: true };
  }

  const codeTokens = Array.isArray(taskTokens.codeTokens) ? taskTokens.codeTokens.map((token) => normalizeCodeToken(token)).filter(Boolean) : [];
  const queries = buildTargetedQueries({ asset, task, codeTokens });
  const webResults = await searchWeb({ queries, taskId, traceId, settings });
  const sources = Array.isArray(webResults?.sources) ? webResults.sources : [];
  const codeDefinitions = sources
    .map((source) => extractCodeDefinitionFromSource(source, codeTokens))
    .filter(Boolean);
  const payload = {
    summary: webResults?.summary || (sources.length ? `Web research found ${sources.length} supporting source(s).` : 'Web research returned no matching sources.'),
    sources,
    codeDefinitions,
    queries,
    configured: true,
    traceId,
    createdAt: new Date().toISOString()
  };
  await cacheRef.set(payload, { merge: true });
  return { ...payload, cacheHit: false, enabled: true };
}

module.exports = {
  fetchWebContextForTask,
  buildTargetedQueries,
  extractCodeDefinitionFromSource
};
