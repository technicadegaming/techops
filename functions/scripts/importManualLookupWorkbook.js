#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_WORKBOOK_PATH,
  loadWorkbookSeed,
  buildCuratedCatalog
} = require('../src/services/manualLookupWorkbookImportService');

const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_WORKBOOK_PATH;
const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(__dirname, '../src/data/manualLookupCatalog.json');

const workbook = loadWorkbookSeed(inputPath);
const curated = buildCuratedCatalog(workbook);
fs.writeFileSync(outputPath, `${JSON.stringify(curated.entries, null, 2)}\n`);
process.stdout.write(`Imported ${curated.entries.length} workbook rows from ${workbook.sourcePath} -> ${outputPath}\n`);
