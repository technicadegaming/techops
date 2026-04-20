#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const { importTrustedCatalogRows } = require('../src/services/trustedManualCatalogService');

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
  const lines = `${content || ''}`
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((entry) => `${entry || ''}`.trim());
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === lines[0]) continue;
    const values = parseCsvLine(lines[index]);
    const row = {};
    header.forEach((key, column) => {
      row[key] = `${values[column] || ''}`.trim();
    });
    rows.push(row);
  }
  return rows;
}

async function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (!inputPath) {
    throw new Error('Usage: node scripts/importTrustedManualCatalog.js <csv-path>');
  }
  const csv = fs.readFileSync(inputPath, 'utf8');
  const rows = parseCsv(csv);

  admin.initializeApp();
  const db = admin.firestore();
  const stats = await importTrustedCatalogRows({ db, rows, sourceFile: inputPath });

  process.stdout.write(JSON.stringify({
    inputPath,
    ...stats,
  }, null, 2));
  process.stdout.write('\n');
}

main().catch((error) => {
  process.stderr.write(`Trusted catalog import failed: ${error.message}\n`);
  process.exitCode = 1;
});
