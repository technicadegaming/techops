const COLLECTION_ALIASES = {
  companies: ['workspaces'],
  companyMemberships: ['workspace_members']
};

function resolveAliasedCollectionValue(key, runtimeCollections = {}) {
  const direct = runtimeCollections[key];
  if (`${direct || ''}`.trim()) return direct;

  const aliases = COLLECTION_ALIASES[key] || [];
  for (const alias of aliases) {
    const value = runtimeCollections[alias];
    if (`${value || ''}`.trim()) return value;
  }
  return undefined;
}

export function normalizeCollections(defaultCollections = {}, runtimeCollections = {}) {
  const merged = { ...defaultCollections, ...runtimeCollections };
  for (const key of Object.keys(COLLECTION_ALIASES)) {
    const value = resolveAliasedCollectionValue(key, runtimeCollections);
    if (`${value || ''}`.trim()) merged[key] = value;
  }
  return merged;
}
