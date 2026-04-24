const BASE_TEMPLATE_COLUMNS = ['asset name', 'assetId', 'manufacturer', 'model', 'serial', 'location', 'zone', 'category', 'status', 'notes'];
const OPTIONAL_TEMPLATE_COLUMNS = ['alternateNames', 'subtitleOrVersion', 'playerCount', 'cabinetType', 'vendorOrDistributor', 'manualHintUrl', 'manualSourceHintUrl', 'supportHintUrl', 'manufacturerWebsite', 'externalAssetKey'];

export const ASSET_IMPORT_COLUMNS = [...BASE_TEMPLATE_COLUMNS, ...OPTIONAL_TEMPLATE_COLUMNS];
export const LEGACY_ASSET_IMPORT_COLUMNS = ['name', 'manufacturer', 'locationName', 'serialNumber', 'model', 'category'];
export const ASSET_TEMPLATE_HEADER = ASSET_IMPORT_COLUMNS.join(',');
export const ASSET_CSV_TEMPLATE = `${ASSET_TEMPLATE_HEADER}\nJurassic Park,jurassic-park-01,Raw Thrills,Jurassic Park Arcade,SN-202,Main Floor,Arcade Row,Arcade,active,Imported during opening intake,Jurassic Park Arcade|JP Arcade,DX,2,Sit-down,Betson,https://rawthrills.com/wp-content/uploads/2019/07/JurassicPark-Operators-Manual.pdf,https://rawthrills.com/games/jurassic-park-arcade/,https://rawthrills.com/service/,https://rawthrills.com,jp-rawthrills-arcade\nQuick Drop,,Bay Tek Games,,QD-102,Prize Midway,Redemption Lane,Redemption,active,Asset ID auto-generated when blank,Quik Drop,,1,Upright,Betson,https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf,https://www.baytekent.com/games/quik-drop/,https://www.baytekent.com/contact-us/,https://www.baytekent.com,legacy-quick-drop`;

const KNOWN_MANUFACTURERS = ['betson', 'raw thrills', 'sega', 'adrenaline amusements', 'ice', 'namco', 'wells gardner', 'elaut', 'stern', 'atari', 'bay tek games', 'baytek', 'andel', 'universal space', 'adrenaline', 'ubisoft'];

const CSV_ALIASES = {
  name: ['asset name', 'name', 'assetname'],
  assetId: ['assetid', 'id'],
  manufacturer: ['manufacturer'],
  model: ['model'],
  serialNumber: ['serial', 'serialnumber', 'serial number'],
  locationName: ['location', 'locationname', 'location name'],
  zone: ['zone', 'area'],
  notes: ['notes'],
  category: ['category', 'type'],
  status: ['status'],
  originalTitle: ['originaltitle', 'original title'],
  normalizedTitle: ['normalizedtitle', 'normalized title'],
  manufacturerInferred: ['manufacturerinferred', 'manufacturer inferred'],
  alternateNames: ['alternatenames', 'alternate names'],
  subtitleOrVersion: ['subtitleorversion', 'subtitle or version'],
  playerCount: ['playercount', 'player count'],
  cabinetType: ['cabinettype', 'cabinet type'],
  vendorOrDistributor: ['vendorordistributor', 'vendor or distributor'],
  manualHintUrl: ['manualhinturl', 'manual hint url'],
  manualSourceHintUrl: ['manualsourcehinturl', 'manual source hint url'],
  supportHintUrl: ['supporthinturl', 'support hint url'],
  manufacturerWebsite: ['manufacturerwebsite', 'manufacturer website'],
  externalAssetKey: ['externalassetkey', 'external asset key'],
  normalizedName: ['normalizedname', 'normalized name'],
  manualUrl: ['manualurl', 'manual url'],
  manualSourceUrl: ['manualsourceurl', 'manual source url'],
  supportEmail: ['supportemail', 'support email'],
  supportPhone: ['supportphone', 'support phone'],
  supportUrl: ['supporturl', 'support url'],
  matchType: ['matchtype', 'match type'],
  manualReady: ['manualready', 'manual ready'],
  reviewRequired: ['reviewrequired', 'review required'],
  matchConfidence: ['matchconfidence', 'match confidence'],
  matchNotes: ['matchnotes', 'match notes']
};

function tokenizeCsvLine(line = '') {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current.trim());
  return result;
}

function toTitle(value = '') {
  return `${value || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function normalizeField(value = '') {
  return `${value || ''}`.replace(/\s+/g, ' ').trim();
}

function normalizeUrl(value = '') {
  const trimmed = `${value || ''}`.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}

function inferManufacturer(candidate = {}) {
  if (candidate.manufacturer) return { manufacturer: candidate.manufacturer, confidence: 'high' };
  const name = `${candidate.name || ''}`.toLowerCase();
  const manufacturer = KNOWN_MANUFACTURERS.find((brand) => name.includes(brand));
  if (!manufacturer) return { manufacturer: '', confidence: 'low' };
  return { manufacturer: toTitle(manufacturer), confidence: 'medium' };
}

function inferCategory(candidate = {}) {
  if (candidate.category) return candidate.category;
  const source = `${candidate.name || ''} ${candidate.model || ''}`.toLowerCase();
  if (/kiosk|pos|terminal/.test(source)) return 'Kiosk';
  if (/pinball/.test(source)) return 'Pinball';
  if (/air hockey|air fx/.test(source)) return 'Sports';
  if (/vr|virtual reality|virtual rabbids/.test(source)) return 'VR';
  if (/crane|claw|drop|redemption/.test(source)) return 'Redemption';
  if (/arcade|game|jurassic park/.test(source)) return 'Arcade';
  return '';
}

function normalizeTitle(value = '') {
  return `${value || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(deluxe|arcade|machine|game|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeValues(values = []) {
  return [...new Set((values || []).map((value) => normalizeField(value)).filter(Boolean))];
}

function parseDelimitedTitles(line = '') {
  if (!line.includes(',')) return [line];
  return line.split(',');
}

function getHeaderValue(raw = {}, key) {
  const aliases = CSV_ALIASES[key] || [key];
  for (const alias of aliases) {
    const match = Object.keys(raw).find((header) => `${header || ''}`.trim().toLowerCase() === alias);
    if (match) return raw[match];
  }
  return '';
}

export function normalizeAssetCandidate(raw = {}, { defaultLocationName = '' } = {}) {
  const alternateNames = dedupeValues(`${raw.alternateNames || ''}`.split(/[|;]+|,/));
  const manualHintUrl = normalizeUrl(raw.manualHintUrl || raw.manualUrl || '');
  const manualSourceHintUrl = normalizeUrl(raw.manualSourceHintUrl || raw.manualSourceUrl || '');
  const supportHintUrl = normalizeUrl(raw.supportHintUrl || raw.supportUrl || '');
  const base = {
    name: normalizeField(raw.name || raw.assetName || raw.originalTitle || ''),
    assetId: normalizeField(raw.assetId || raw.id || ''),
    manufacturer: normalizeField(raw.manufacturer || ''),
    locationName: normalizeField(raw.locationName || raw.location || defaultLocationName || ''),
    serialNumber: normalizeField(raw.serialNumber || raw.serial || ''),
    model: normalizeField(raw.model || ''),
    category: normalizeField(raw.category || ''),
    zone: normalizeField(raw.zone || raw.area || ''),
    notes: normalizeField(raw.notes || ''),
    status: normalizeField(raw.status || '') || 'active',
    originalTitle: normalizeField(raw.originalTitle || raw.name || raw.assetName || ''),
    alternateNames,
    subtitleOrVersion: normalizeField(raw.subtitleOrVersion || ''),
    playerCount: normalizeField(raw.playerCount || ''),
    cabinetType: normalizeField(raw.cabinetType || ''),
    vendorOrDistributor: normalizeField(raw.vendorOrDistributor || ''),
    manualHintUrl,
    manualSourceHintUrl,
    supportHintUrl,
    manufacturerWebsite: normalizeField(raw.manufacturerWebsite || ''),
    externalAssetKey: normalizeField(raw.externalAssetKey || ''),
    supportEmail: normalizeField(raw.supportEmail || ''),
    supportPhone: normalizeField(raw.supportPhone || ''),
    normalizedTitle: normalizeField(raw.normalizedTitle || raw.normalizedName || ''),
    normalizedName: normalizeField(raw.normalizedName || raw.normalizedTitle || ''),
    manufacturerInferred: normalizeField(raw.manufacturerInferred || ''),
    legacyManualUrl: normalizeUrl(raw.manualUrl || ''),
    legacyManualSourceUrl: normalizeUrl(raw.manualSourceUrl || ''),
    legacySupportUrl: normalizeUrl(raw.supportUrl || ''),
    matchType: normalizeField(raw.matchType || ''),
    manualReady: normalizeField(raw.manualReady || ''),
    reviewRequired: normalizeField(raw.reviewRequired || ''),
    matchConfidence: normalizeField(raw.matchConfidence || ''),
    matchNotes: normalizeField(raw.matchNotes || '')
  };
  base.name = base.name.replace(/\s{2,}/g, ' ');
  const manufacturerInference = inferManufacturer(base);
  const categoryInference = inferCategory(base);
  const manufacturerSuggestion = !base.manufacturer && manufacturerInference.manufacturer ? manufacturerInference.manufacturer : '';
  const categorySuggestion = !base.category && categoryInference ? categoryInference : '';
  const normalizedTitle = base.normalizedTitle || base.normalizedName || toTitle(normalizeTitle(base.name || alternateNames[0] || ''));
  return {
    ...base,
    originalTitle: base.originalTitle || base.name,
    normalizedTitle,
    normalizedName: normalizedTitle,
    manufacturerSuggestion,
    categorySuggestion,
    normalizationConfidence: base.manufacturer ? 'high' : manufacturerInference.confidence,
    reviewNeeded: !base.manufacturer || !!manufacturerSuggestion || !!categorySuggestion,
    rowStatus: (base.manufacturer || manufacturerSuggestion || supportHintUrl || manualHintUrl || manualSourceHintUrl) ? 'needs_review' : 'unresolved'
  };
}

export function parseTitleBulkInput(text = '', options = {}) {
  const normalizedLines = `${text || ''}`.split(/\r?\n/).flatMap((line) => parseDelimitedTitles(line));
  const seen = new Set();
  const rows = [];
  normalizedLines.forEach((entry, index) => {
    const name = normalizeField(entry);
    if (!name) return;
    const dedupeKey = normalizeTitle(name);
    if (!dedupeKey || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const row = normalizeAssetCandidate({ name }, options);
    rows.push({ ...row, source: 'bulk_titles', sourceRow: index + 1 });
  });
  return { rows, errors: [] };
}

export function parseBulkAssetList(text = '', options = {}) {
  const parsedTitles = parseTitleBulkInput(text, options);
  if (parsedTitles.rows.length) return parsedTitles;
  const lines = `${text || ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  const errors = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let parts = [];
    if (line.includes('|')) parts = line.split('|').map((part) => part.trim());
    else if (line.includes('\t')) parts = line.split('\t').map((part) => part.trim());
    else if (line.includes(' - ')) parts = line.split(' - ').map((part) => part.trim());
    else if (line.includes(',')) parts = line.split(',').map((part) => part.trim());

    let parsed;
    if (!parts.length) parsed = { name: line };
    else if (parts.length === 2) parsed = { manufacturer: parts[0], name: parts[1] };
    else {
      parsed = {
        manufacturer: parts[0],
        name: parts[1],
        locationName: parts[2] || '',
        serialNumber: parts[3] || '',
        model: parts[4] || '',
        category: parts[5] || ''
      };
    }

    const normalized = normalizeAssetCandidate(parsed, options);
    if (!normalized.name) {
      errors.push(`Line ${lineNumber}: missing asset name.`);
      return;
    }
    rows.push({ ...normalized, source: 'bulk', sourceRow: lineNumber });
  });
  return { rows, errors };
}

export function parseAssetCsv(text = '', options = {}) {
  const lines = `${text || ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], errors: [] };
  const headers = tokenizeCsvLine(lines[0]).map((header) => header.trim());
  const lowerHeaders = headers.map((header) => header.toLowerCase());
  const hasName = lowerHeaders.includes('name') || lowerHeaders.includes('asset name') || lowerHeaders.includes('assetname');
  if (!hasName) return { rows: [], errors: ['CSV is missing required column: asset name.'] };

  const rows = [];
  const errors = [];
  lines.slice(1).forEach((line, index) => {
    const rowNumber = index + 2;
    const values = tokenizeCsvLine(line);
    if (!values.some(Boolean)) return;
    const raw = {};
    headers.forEach((header, valueIndex) => { raw[header] = values[valueIndex] || ''; });
    const normalized = normalizeAssetCandidate({
      name: getHeaderValue(raw, 'name'),
      assetId: getHeaderValue(raw, 'assetId'),
      manufacturer: getHeaderValue(raw, 'manufacturer'),
      model: getHeaderValue(raw, 'model'),
      serialNumber: getHeaderValue(raw, 'serialNumber'),
      locationName: getHeaderValue(raw, 'locationName'),
      zone: getHeaderValue(raw, 'zone'),
      notes: getHeaderValue(raw, 'notes'),
      category: getHeaderValue(raw, 'category'),
      status: getHeaderValue(raw, 'status'),
      alternateNames: getHeaderValue(raw, 'alternateNames'),
      subtitleOrVersion: getHeaderValue(raw, 'subtitleOrVersion'),
      playerCount: getHeaderValue(raw, 'playerCount'),
      cabinetType: getHeaderValue(raw, 'cabinetType'),
      vendorOrDistributor: getHeaderValue(raw, 'vendorOrDistributor'),
      manualHintUrl: getHeaderValue(raw, 'manualHintUrl'),
      manualSourceHintUrl: getHeaderValue(raw, 'manualSourceHintUrl'),
      supportHintUrl: getHeaderValue(raw, 'supportHintUrl'),
      manufacturerWebsite: getHeaderValue(raw, 'manufacturerWebsite'),
      externalAssetKey: getHeaderValue(raw, 'externalAssetKey'),
      originalTitle: getHeaderValue(raw, 'originalTitle'),
      normalizedTitle: getHeaderValue(raw, 'normalizedTitle') || getHeaderValue(raw, 'normalizedName'),
      manufacturerInferred: getHeaderValue(raw, 'manufacturerInferred'),
      normalizedName: getHeaderValue(raw, 'normalizedName') || getHeaderValue(raw, 'normalizedTitle'),
      manualUrl: getHeaderValue(raw, 'manualUrl'),
      manualSourceUrl: getHeaderValue(raw, 'manualSourceUrl'),
      supportEmail: getHeaderValue(raw, 'supportEmail'),
      supportPhone: getHeaderValue(raw, 'supportPhone'),
      supportUrl: getHeaderValue(raw, 'supportUrl'),
      matchType: getHeaderValue(raw, 'matchType'),
      manualReady: getHeaderValue(raw, 'manualReady'),
      reviewRequired: getHeaderValue(raw, 'reviewRequired'),
      matchConfidence: getHeaderValue(raw, 'matchConfidence'),
      matchNotes: getHeaderValue(raw, 'matchNotes')
    }, options);
    if (!normalized.name) {
      errors.push(`Row ${rowNumber}: missing asset name.`);
      return;
    }
    rows.push({ ...normalized, source: 'csv', sourceRow: rowNumber });
  });
  return { rows, errors };
}

function classifyRowStatus({ confidence = 0, supportUrl = '', manufacturer = '', manualReady = false, matchType = '' } = {}) {
  if (manualReady && ['exact_manual', 'manual_page_with_download'].includes(`${matchType || ''}`)) return 'good_match';
  if (['title_specific_source', 'support_only', 'family_match_needs_review'].includes(`${matchType || ''}`)) return 'needs_review';
  if (manufacturer || supportUrl || confidence >= 0.45) return 'needs_review';
  return 'unresolved';
}

function extractContactValue(contacts = [], keys = []) {
  return (contacts || []).find((entry) => keys.includes(`${entry?.contactType || ''}`.toLowerCase()))?.value || '';
}

export function mapPreviewToAssetIntakeRow(row = {}, preview = {}) {
  const engine = preview.assetResearchSummary || preview.manualMatchSummary || {};
  const documentationSuggestions = Array.isArray(preview.documentationSuggestions) ? preview.documentationSuggestions : [];
  const supportResources = Array.isArray(preview.supportResourcesSuggestion) ? preview.supportResourcesSuggestion : [];
  const supportContacts = Array.isArray(preview.supportContactsSuggestion) ? preview.supportContactsSuggestion : [];
  const bestManual = documentationSuggestions.find((entry) => normalizeUrl(entry?.url));
  const bestSupport = supportResources.find((entry) => normalizeUrl(entry?.url));
  const confidence = Number(engine.confidence || preview.confidence || 0);
  const supportEmail = row.supportEmail || engine.supportEmail || extractContactValue(supportContacts, ['email']);
  const supportPhone = row.supportPhone || engine.supportPhone || extractContactValue(supportContacts, ['phone', 'telephone']);
  const supportHintUrl = row.supportHintUrl || normalizeUrl(engine.supportUrl || bestSupport?.url || '');
  const manualReady = typeof engine.manualReady === 'boolean' ? engine.manualReady : false;
  const matchNotes = row.matchNotes || engine.matchNotes || [
    preview.status ? `status: ${preview.status}` : '',
    preview.likelyManufacturer ? `manufacturer: ${preview.likelyManufacturer}` : '',
    bestManual?.sourceType ? `manual source: ${bestManual.sourceType}` : '',
    bestSupport?.sourceType ? `support source: ${bestSupport.sourceType}` : ''
  ].filter(Boolean).join(' | ');
  return {
    ...row,
    originalTitle: engine.assetNameOriginal || row.originalTitle || row.name,
    normalizedTitle: engine.assetNameNormalized || preview.normalizedName || row.normalizedTitle || row.normalizedName || row.name,
    normalizedName: engine.assetNameNormalized || preview.normalizedName || row.normalizedTitle || row.normalizedName || row.name,
    manufacturer: row.manufacturer || engine.manufacturer || preview.likelyManufacturer || row.manufacturerSuggestion || '',
    manufacturerInferred: `${engine.manufacturerInferred ?? row.manufacturerInferred ?? (!row.manufacturer && (engine.manufacturer || preview.likelyManufacturer || row.manufacturerSuggestion))}` === 'true' ? true : (engine.manufacturerInferred ?? row.manufacturerInferred ?? (!row.manufacturer && !!(engine.manufacturer || preview.likelyManufacturer || row.manufacturerSuggestion))),
    manufacturerSuggestion: engine.manufacturer || preview.likelyManufacturer || row.manufacturerSuggestion || '',
    category: row.category || preview.likelyCategory || row.categorySuggestion || '',
    categorySuggestion: preview.likelyCategory || row.categorySuggestion || '',
    manualHintUrl: row.manualHintUrl || normalizeUrl(engine.manualUrl || ''),
    manualSourceHintUrl: row.manualSourceHintUrl || normalizeUrl(engine.manualSourceUrl || ''),
    supportEmail,
    supportPhone,
    supportHintUrl,
    matchConfidence: confidence ? confidence.toFixed(2) : row.matchConfidence || '',
    searchEvidence: Array.isArray(engine.searchEvidence) ? engine.searchEvidence : (Array.isArray(preview.searchHints) ? preview.searchHints : []),
    status: engine.status || preview.status || row.status || '',
    matchNotes,
    notes: row.notes || matchNotes,
    preview,
    confidence,
    matchType: engine.matchType || preview.matchType || '',
    manualReady,
    variantWarning: engine.variantWarning || preview.variantWarning || '',
    reviewRequired: typeof engine.reviewRequired === 'boolean' ? engine.reviewRequired : !manualReady,
    rowStatus: classifyRowStatus({
      confidence,
      supportUrl: supportHintUrl,
      manufacturer: row.manufacturer || engine.manufacturer || preview.likelyManufacturer || '',
      manualReady,
      matchType: engine.matchType || preview.matchType || ''
    }),
    reviewNeeded: typeof engine.reviewRequired === 'boolean'
      ? engine.reviewRequired
      : classifyRowStatus({ confidence, supportUrl: supportHintUrl, manufacturer: row.manufacturer || engine.manufacturer || preview.likelyManufacturer || '', manualReady, matchType: engine.matchType || preview.matchType || '' }) !== 'good_match'
  };
}

export async function enrichAssetIntakeRows(rows = [], { lookup, chunkDelayMs = 0 } = {}) {
  const results = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const payload = {
      assetName: row.name,
      manufacturer: row.manufacturer,
      serialNumber: row.serialNumber,
      assetId: row.assetId
    };
    try {
      const preview = await lookup(payload);
      results.push(mapPreviewToAssetIntakeRow(row, preview));
    } catch (error) {
      results.push({
        ...row,
        preview: null,
        confidence: 0,
        rowStatus: 'unresolved',
        reviewNeeded: true,
        matchNotes: row.matchNotes || `Lookup failed: ${`${error?.message || error || 'unknown error'}`.trim()}`
      });
    }
    if (chunkDelayMs && index < rows.length - 1) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
  }
  return results;
}

function escapeCsvValue(value = '') {
  const stringValue = Array.isArray(value) ? value.join('|') : `${value ?? ''}`;
  if (/[",\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

export function buildAssetImportRow(row = {}) {
  return {
    'asset name': row.name || '',
    assetId: row.assetId || '',
    manufacturer: row.manufacturer || '',
    model: row.model || '',
    serial: row.serialNumber || '',
    location: row.locationName || '',
    zone: row.zone || '',
    category: row.category || '',
    status: row.status || 'active',
    notes: row.notes || '',
    alternateNames: dedupeValues(row.alternateNames || []).join('|'),
    subtitleOrVersion: row.subtitleOrVersion || '',
    playerCount: row.playerCount || '',
    cabinetType: row.cabinetType || '',
    vendorOrDistributor: row.vendorOrDistributor || '',
    manualHintUrl: row.manualHintUrl || row.manualUrl || '',
    manualSourceHintUrl: row.manualSourceHintUrl || row.manualSourceUrl || '',
    supportHintUrl: row.supportHintUrl || row.supportUrl || '',
    manufacturerWebsite: row.manufacturerWebsite || '',
    externalAssetKey: row.externalAssetKey || ''
  };
}

export function buildAssetCsv(rows = []) {
  const header = ASSET_IMPORT_COLUMNS;
  const lines = [header.join(',')];
  (rows || []).forEach((row) => {
    const exportRow = buildAssetImportRow(row);
    lines.push(header.map((column) => escapeCsvValue(exportRow[column] || '')).join(','));
  });
  return lines.join('\n');
}
