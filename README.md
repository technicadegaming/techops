# Scoot Business TechOps Portal

Scoot Business TechOps is a multi-tenant operations platform for FEC/arcade-style businesses. Some low-risk internal and historical references still use pre-Scoot naming where changing them could create migration ambiguity, but current contributor-facing guidance should default to Scoot Business or neutral terminology.

## What this repo contains

- Browser-based operations portal (`src/`) with Firebase Auth + Firestore-backed data flows.
- Firebase Cloud Functions (`functions/`) for AI-assisted workflows and policy checks.
- Firebase security rules (`firestore.rules`, `storage.rules`) for tenant isolation.
- Operational docs under `docs/`.

## Firebase products in use

- **Authentication** for identity and session management.
- **Cloud Firestore** for multi-tenant operational records.
- **Cloud Functions** for secured server-side orchestration.
- **Cloud Storage** for company-scoped evidence, approved manual source files, and backup artifacts.

## Local development

### Prerequisites

- Node.js 20+
- Firebase CLI

### Setup

```bash
npm install
npm install --prefix functions
```

### Verify locally

```bash
npm run lint
npm run test --prefix functions
npm run test:rules
```

### Root source of truth

- The repository root files (for example `index.html`, Firebase config, and docs) are the authoritative source for the deployed app and operational workflows.
- Legacy GitHub Pages export artifacts and root `CNAME` files are not part of the current Firebase Hosting deployment path and should not be reintroduced without a documented operational need.

### Runtime config injection (`window.__APP_CONFIG__`)

- `src/config.js` reads runtime overrides from `window.__APP_CONFIG__` during browser startup and merges them over the committed defaults.
- This repo currently documents the contract, but it does **not** include an environment-specific injector for staging/production. In practice, the hosting layer must define `window.__APP_CONFIG__` before the app modules load if you need overrides.
- Safe committed defaults may stay in `src/config.js` (for example the Firebase web client config and non-privileged defaults).
- Privilege-affecting values such as `bootstrapAdmins` must be supplied intentionally at runtime, for example with an inline script placed ahead of the app bundle:

```html
<script>
  window.__APP_CONFIG__ = {
    bootstrapAdmins: ['owner@example.com']
  };
</script>
```

- Leave `bootstrapAdmins` unset in normal local/staging/production operation unless you are deliberately enabling a bootstrap path for a specific rollout or recovery case.
- Staging and production overrides should follow the same pattern: inject only the environment-specific keys that differ from committed defaults, and keep the injected object small and explicit.

### Security rules tests (Firestore + Storage)

Rules tests use the Firebase Local Emulator Suite via `firebase emulators:exec` and Node's built-in test runner.

```bash
npm run test:rules
```

This command starts local Firestore + Storage emulators, runs `test/rules/security.rules.test.js`, and then shuts emulators down automatically.

## Deployment overview

For full release guidance, use:

- `docs/DEPLOYMENT.md` for deploy sequencing and post-deploy verification.
- `docs/RELEASE_CHECKLIST.md` for pre-merge / pre-deploy / post-deploy checklists.

Typical deploy commands:

```bash
firebase deploy --only firestore:rules
firebase deploy --only storage
firebase deploy --only firestore:indexes
firebase deploy --only functions
firebase deploy --only hosting
```

### Recommended deploy order

1. Rules (`firestore:rules`, then `storage`) to enforce tenancy boundaries first.
2. Firestore indexes (if changed) so query dependencies are ready.
3. Functions so backend behavior aligns with rules and indexes.
4. Hosting for UI updates.

### Secrets handling expectations

- Never commit local secret material (for example `functions/.secret.local`).
- Keep secrets in Firebase-managed configuration or project secret stores.
- Validate secret availability before production deploys.

## Contributor operating guide

- Repository-level Codex guidance and completion criteria live in `AGENTS.md`.
- Near-term phased implementation sequence lives in `docs/NEXT_PHASE_EXECUTION_PLAN.md`.
- Keep changes incremental and non-destructive to current Firebase tenancy architecture.

## Security and tenancy model (high-level)

- Company data is scoped by `companyId` in Firestore and by storage path prefix:
  - `companies/{companyId}/evidence/...`
  - `companies/{companyId}/manuals/{assetId}/{manualId}/source.pdf`
  - `companies/{companyId}/backups/...`
- Enrichment authorization policy is standardized across functions libraries and tests.
- Firebase local secret files (for example `functions/.secret.local`) are ignored and must never be committed.
- Asset manual enrichment now checks a curated lookup catalog first (`functions/src/data/manualLookupCatalog.json`) before live rediscovery, then falls back to deterministic official-first/manual-repository-first discovery when no catalog match exists.

See `docs/SECURITY.md` and `docs/ARCHITECTURE.md` for details.
For current implementation-oriented contributor docs, also see `docs/DATA_MODEL.md` and `docs/FRONTEND_STRUCTURE.md`.

### Manual lookup registry

- Workbook-backed manual seed data lives in `functions/src/data/manualLookupWorkbookSeed.json`.
- Regenerate the curated catalog with `npm run manual-catalog:import` from the repo root (or `npm run manual-catalog:import --prefix functions` if you are working directly in `functions/`).
- See `docs/MANUAL_LOOKUP_REGISTRY.md` for verification/trust-tier guidance and regression expectations.
