# Architecture

## Overview

This repository hosts a Firebase-based multi-tenant operations portal for Scoot Business environments (FEC/arcade style operators).

## Frontend

- Hosting: GitHub Pages on `wow.technicade.tech` via the root `CNAME` file; this repo's `firebase.json` does not currently define a Firebase Hosting target.
- Entry shell: `src/app.js`
- Supporting shell modules:
  - `src/app/boot.js`
  - `src/app/state.js`
  - `src/app/router.js`
  - `src/app/dataRefresh.js`
  - `src/app/actions.js`
  - `src/app/renderApp.js`
- Feature modules: `src/features/*`

The app is framework-less JavaScript, intentionally preserved to avoid migration risk.

## Backend (Functions)

- Functions entry: `functions/src/index.js`
- Permissions libraries:
  - `functions/src/lib/permissions.js`
  - `functions/src/lib/enrichmentAuthorization.js`
- AI orchestration: `functions/src/services/taskAiOrchestrator.js`
- Asset documentation enrichment: `functions/src/services/assetEnrichmentService.js`
- Curated manual catalog lookup: `functions/src/services/manualLookupCatalogService.js` with workbook-seeded source data in `functions/src/data/manualLookupWorkbookSeed.json`, normalized via `functions/scripts/importManualLookupWorkbook.js` into `functions/src/data/manualLookupCatalog.json`
- Manual live discovery fallback: `functions/src/services/manualDiscoveryService.js`
- Manual acquisition + shared library: `functions/src/services/manualAcquisitionService.js`, `functions/src/services/manualLibraryService.js`
- Manual ingestion/extraction: `functions/src/services/manualIngestionService.js`

## Multi-tenant boundaries

- Firestore collections use `companyId` for tenant scoping.
- Cloud Storage paths are scoped under `companies/{companyId}/...` for tenant isolation.
- Approved manual source files are stored under `companies/{companyId}/manuals/{assetId}/{manualId}/source.*`, with extracted text in `manuals/{manualId}/chunks`.
- Asset manual suggestions use a catalog-first pipeline: normalized title/manufacturer, aliases, and explicit variants are checked against the curated catalog first; only misses continue into deterministic live discovery ordered as official manufacturer pages, official docs/manual repositories, exact-title PDF search, then trusted distributor/manual-library sources.
- Global admins can bypass tenant constraints where explicitly required.
