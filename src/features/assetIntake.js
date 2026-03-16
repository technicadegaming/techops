export const ASSET_IMPORT_COLUMNS = ['name', 'manufacturer', 'locationName', 'serialNumber', 'model', 'category'];

export const ASSET_CSV_TEMPLATE = `name,manufacturer,locationName,serialNumber,model,category\nTicket Kiosk 01,Betson,Main Floor,SN-101,TK-Prime,Kiosk\nRedemption Game 02,Raw Thrills,Arcade Zone,SN-202,Jurassic Park Arcade,Arcade`;

const KNOWN_MANUFACTURERS = ['betson', 'raw thrills', 'sega', 'adrenaline amusements', 'ice', 'namco', 'wells gardner', 'elaut', 'stern', 'atari'];

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
  if (/air hockey/.test(source)) return 'Sports';
  if (/vr|virtual reality/.test(source)) return 'VR';
  if (/crane|claw/.test(source)) return 'Redemption';
  if (/arcade|game/.test(source)) return 'Arcade';
  return '';
}

function normalizeField(value = '') {
  return `${value || ''}`.replace(/\s+/g, ' ').trim();
}

export function normalizeAssetCandidate(raw = {}, { defaultLocationName = '' } = {}) {
  const base = {
    name: normalizeField(raw.name || raw.assetName || ''),
    manufacturer: normalizeField(raw.manufacturer || ''),
    locationName: normalizeField(raw.locationName || raw.location || defaultLocationName || ''),
    serialNumber: normalizeField(raw.serialNumber || raw.serial || ''),
    model: normalizeField(raw.model || ''),
    category: normalizeField(raw.category || '')
  };
  base.name = base.name.replace(/\s{2,}/g, ' ');
  const manufacturerInference = inferManufacturer(base);
  const categoryInference = inferCategory(base);
  const manufacturerSuggestion = !base.manufacturer && manufacturerInference.manufacturer ? manufacturerInference.manufacturer : '';
  const categorySuggestion = !base.category && categoryInference ? categoryInference : '';
  return {
    ...base,
    manufacturerSuggestion,
    categorySuggestion,
    normalizationConfidence: base.manufacturer ? 'high' : manufacturerInference.confidence,
    reviewNeeded: !base.manufacturer || !!manufacturerSuggestion || !!categorySuggestion
  };
}

export function parseBulkAssetList(text = '', options = {}) {
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
    if (!parts.length) {
      parsed = { name: line };
    } else if (parts.length === 2) {
      parsed = { manufacturer: parts[0], name: parts[1] };
    } else {
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
  const hasName = lowerHeaders.includes('name') || lowerHeaders.includes('assetname');
  if (!hasName) {
    return { rows: [], errors: ['CSV is missing required column: name.'] };
  }

  const rows = [];
  const errors = [];
  lines.slice(1).forEach((line, index) => {
    const rowNumber = index + 2;
    const values = tokenizeCsvLine(line);
    if (!values.some(Boolean)) return;
    const raw = {};
    headers.forEach((header, valueIndex) => {
      raw[header] = values[valueIndex] || '';
    });
    const normalized = normalizeAssetCandidate({
      name: raw.name || raw.assetName || raw.AssetName,
      manufacturer: raw.manufacturer || raw.Manufacturer,
      locationName: raw.locationName || raw.location || raw.Location,
      serialNumber: raw.serialNumber || raw.serial || raw.SerialNumber,
      model: raw.model || raw.Model,
      category: raw.category || raw.Category
    }, options);
    if (!normalized.name) {
      errors.push(`Row ${rowNumber}: missing asset name.`);
      return;
    }
    rows.push({ ...normalized, source: 'csv', sourceRow: rowNumber });
  });
  return { rows, errors };
}
