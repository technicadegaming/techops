#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { buildReferenceHintsFromRows } = require('../src/services/manualLookupReferenceService');
const { normalizeTrustedCatalogRow } = require('../src/services/trustedManualCatalogService');

function parseCsvLine(line = '') {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function parseCsv(content = '') {
  const lines = `${content || ''}`.split(/\r?\n/g).filter((line) => `${line || ''}`.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((entry) => `${entry || ''}`.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = `${values[index] || ''}`.trim();
    });
    return row;
  });
}

function toReferenceRows(rows = []) {
  return rows
    .map((row) => normalizeTrustedCatalogRow(row))
    .filter((row) => row.assetName || row.normalizedTitle || row.originalTitle)
    .map((row) => ({
      ...row,
      referenceOnly: true,
      notTrustedCatalog: true,
    }));
}

function mergeReferenceHints(rows = []) {
  const hints = buildReferenceHintsFromRows(rows);
  return {
    generatedAt: new Date().toISOString(),
    referenceOnly: true,
    notTrustedCatalog: true,
    rowsUsedForReference: rows.length,
    aliasesGenerated: (hints.aliases || []).length,
    manufacturerMappingsGenerated: hints.manufacturerNormalization ? 1 : 0,
    titleFamilyMappingsGenerated: (hints.familyTitles || []).length,
    ...hints,
  };
}

function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
  const outputPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(__dirname, '../src/data/manualLookupReferenceHints.json');

  if (!inputPath) throw new Error('Usage: node scripts/extractManualLookupReferenceHints.js <csv-path> [output-json]');

  const csv = fs.readFileSync(inputPath, 'utf8');
  const parsedRows = parseCsv(csv);
  const referenceRows = toReferenceRows(parsedRows);
  const output = mergeReferenceHints(referenceRows);

  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({
    inputPath,
    outputPath,
    rowsProcessed: parsedRows.length,
    rowsUsedForReference: referenceRows.length,
    aliasesGenerated: output.aliasesGenerated,
    manufacturerMappingsGenerated: output.manufacturerMappingsGenerated,
    titleFamilyMappingsGenerated: output.titleFamilyMappingsGenerated,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Reference extraction failed: ${error.message}\n`);
  process.exitCode = 1;
}
