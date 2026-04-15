async function fetchWebContextForTask({ db, taskId, settings, traceId }) {
  if (!settings.aiUseWebSearch) return { summary: null, sources: [], cacheHit: false };
  const cacheRef = db.collection('aiWebContextCache').doc(taskId);
  const cached = await cacheRef.get();
  if (cached.exists) {
    const payload = cached.data();
    return { summary: payload.summary || null, sources: payload.sources || [], cacheHit: true };
  }

  // Conservative placeholder abstraction for external search enrichment.
  // Keep non-blocking and safe; implementation can be upgraded later.
  const payload = {
    summary: 'No external web enrichment provider configured yet. Internal knowledge only.',
    sources: [],
    traceId,
    createdAt: new Date().toISOString()
  };
  await cacheRef.set(payload, { merge: true });
  return { ...payload, cacheHit: false };
}

module.exports = {
  fetchWebContextForTask
};
