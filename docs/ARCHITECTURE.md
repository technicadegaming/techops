# Architecture

## Overview

This repository hosts a Firebase-based multi-tenant operations portal for Scoot Business environments (FEC/arcade style operators).

## Frontend

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
- Manual ingestion/extraction: `functions/src/services/manualIngestionService.js`

## Multi-tenant boundaries

- Firestore collections use `companyId` for tenant scoping.
- Cloud Storage paths are scoped under `companies/{companyId}/...` for tenant isolation.
- Approved manual source files are stored under `companies/{companyId}/manuals/{assetId}/{manualId}/source.*`, with extracted text in `manuals/{manualId}/chunks`.
- Global admins can bypass tenant constraints where explicitly required.
