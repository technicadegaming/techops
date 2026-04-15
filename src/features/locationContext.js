const ALL_LOCATIONS_KEY = '__all_locations__';
const UNASSIGNED_LOCATION_KEY = '__unassigned_location__';

function normalizeText(value = '') {
  return `${value || ''}`.trim().toLowerCase().replace(/\s+/g, ' ');
}

function slugify(value = '') {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function buildCatalogMap(companyLocations = []) {
  const byId = new Map();
  const byName = new Map();
  (companyLocations || []).forEach((location) => {
    const name = `${location?.name || ''}`.trim();
    if (!name) return;
    const normalized = normalizeText(name);
    const entry = {
      key: `${location.id || `loc-name-${slugify(name) || 'unknown'}`}`,
      id: location.id || '',
      name,
      normalizedName: normalized,
      label: name,
      source: 'company'
    };
    if (entry.id) byId.set(entry.id, entry);
    byName.set(normalized, entry);
  });
  return { byId, byName };
}

function addDerivedLocation(catalog, rawName, source = 'derived') {
  const name = `${rawName || ''}`.trim();
  if (!name) return;
  const normalized = normalizeText(name);
  if (!normalized || catalog.byName.has(normalized)) return;
  catalog.byName.set(normalized, {
    key: `${source}-${slugify(name) || 'unknown'}`,
    id: '',
    name,
    normalizedName: normalized,
    label: `${name} (from records)`,
    source
  });
}

export function buildLocationOptions(state) {
  const catalog = buildCatalogMap(state.companyLocations || []);
  (state.assets || []).forEach((asset) => addDerivedLocation(catalog, asset.locationName || asset.location));
  (state.tasks || []).forEach((task) => addDerivedLocation(catalog, task.location));
  (state.workers || []).forEach((worker) => addDerivedLocation(catalog, worker.locationName));

  const locations = [...catalog.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return [
    { key: ALL_LOCATIONS_KEY, id: '', name: 'Company-wide', label: 'Company-wide', source: 'system' },
    ...locations,
    { key: UNASSIGNED_LOCATION_KEY, id: '', name: 'Unassigned location', label: 'Unassigned location', source: 'system' }
  ];
}

export function getLocationOptionByKey(state, key) {
  return buildLocationOptions(state).find((option) => option.key === key) || null;
}

export function getLocationSelection(state) {
  const key = `${state.route?.locationKey || ALL_LOCATIONS_KEY}`.trim() || ALL_LOCATIONS_KEY;
  return getLocationOptionByKey(state, key) || getLocationOptionByKey(state, ALL_LOCATIONS_KEY);
}

export function getLocationRecord(state, value = {}) {
  const catalog = buildCatalogMap(state.companyLocations || []);
  const locationId = `${value.locationId || value.defaultLocationId || ''}`.trim();
  const locationName = `${value.locationName || value.location || ''}`.trim();

  if (locationId && catalog.byId.has(locationId)) return catalog.byId.get(locationId);
  if (locationName) {
    const normalized = normalizeText(locationName);
    return catalog.byName.get(normalized) || {
      key: `derived-${slugify(locationName) || 'unknown'}`,
      id: '',
      name: locationName,
      normalizedName: normalized,
      label: locationName,
      source: 'derived'
    };
  }

  return {
    key: UNASSIGNED_LOCATION_KEY,
    id: '',
    name: '',
    normalizedName: '',
    label: 'Unassigned location',
    source: 'system'
  };
}

export function getAssetLocationRecord(state, asset) {
  return getLocationRecord(state, asset || {});
}

export function getTaskLocationRecord(state, task, assetById = new Map()) {
  const asset = assetById.get(task?.assetId || '');
  return getLocationRecord(state, {
    locationId: task?.locationId || asset?.locationId || '',
    locationName: task?.location || asset?.locationName || asset?.location || ''
  });
}

export function isRecordInLocationScope(record, selection) {
  if (!selection || selection.key === ALL_LOCATIONS_KEY) return true;
  if (selection.key === UNASSIGNED_LOCATION_KEY) return record.key === UNASSIGNED_LOCATION_KEY;
  if (selection.id && record.id) return selection.id === record.id;
  return record.normalizedName && selection.normalizedName && record.normalizedName === selection.normalizedName;
}

export function filterAssetsByLocation(state, selection = getLocationSelection(state)) {
  return (state.assets || []).filter((asset) => isRecordInLocationScope(getAssetLocationRecord(state, asset), selection));
}

export function filterTasksByLocation(state, selection = getLocationSelection(state), assetById = new Map((state.assets || []).map((asset) => [asset.id, asset]))) {
  return (state.tasks || []).filter((task) => isRecordInLocationScope(getTaskLocationRecord(state, task, assetById), selection));
}

export function buildLocationSummary(state, selection = getLocationSelection(state)) {
  const assetById = new Map((state.assets || []).map((asset) => [asset.id, asset]));
  const scopedAssets = filterAssetsByLocation(state, selection);
  const scopedTasks = filterTasksByLocation(state, selection, assetById);
  const openTasks = scopedTasks.filter((task) => task.status !== 'completed');
  const brokenAssets = scopedAssets.filter((asset) => openTasks.some((task) => task.assetId === asset.id));
  return {
    selection,
    scopedAssets,
    scopedTasks,
    openTasks,
    brokenAssets,
    openCriticalTasks: openTasks.filter((task) => task.severity === 'critical'),
    assetsWithoutDocs: scopedAssets.filter((asset) => !(asset.manualLinks || []).length)
  };
}

export function getLocationScopeLabel(selection) {
  if (!selection || selection.key === ALL_LOCATIONS_KEY) return 'Company-wide view';
  if (selection.key === UNASSIGNED_LOCATION_KEY) return 'Unassigned location view';
  return `${selection.name} view`;
}

export function getLocationEmptyState(selection, nounPlural) {
  if (!selection || selection.key === ALL_LOCATIONS_KEY) return `No ${nounPlural} yet.`;
  if (selection.key === UNASSIGNED_LOCATION_KEY) return `No ${nounPlural} without a location right now.`;
  return `No ${nounPlural} for ${selection.name} right now.`;
}

export { ALL_LOCATIONS_KEY, UNASSIGNED_LOCATION_KEY };
