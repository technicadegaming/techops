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

Start with the baseline checks on every contributor-facing change:

```bash
npm run lint
npm run test --prefix functions
```

Then add the change-specific checks that match your touch points:

```bash
npm run test:app-shell
npm run test:rules
```

- Run `npm run test:app-shell` when you touch `src/app.js`, `src/app/*`, or frontend shell/controller seams that feed the signed-in app shell.
- Run `npm run test:rules` when you touch `firestore.rules`, `storage.rules`, tenant-scoped data access, storage path enforcement, or other security-sensitive access boundaries.
- GitHub CI enforces the baseline lint/functions suites plus the emulator-backed rules suite; app-shell coverage is still a conditional reviewer/local expectation rather than a blanket CI gate.
- Use `.github/pull_request_template.md` to record which conditional checks applied and which implementation docs you consulted.
- If you need deploy/release-specific gates, use `docs/DEPLOYMENT.md` and `docs/RELEASE_CHECKLIST.md` as the source of truth rather than copying those steps into feature docs.

### Start here: contributor path

If you are new to this repository, use this order first:

1. Read this `README.md` for the repo shape, validation commands, and deployment/runtime-config pointers.
2. Read `docs/ARCHITECTURE.md` for the high-level Firebase architecture and backend/frontend module map.
3. Read `docs/DATA_MODEL.md` for the current Firestore + Storage tenant model (`companyId`, storage path scoping, and major collections).
4. Read `docs/FRONTEND_STRUCTURE.md` for where frontend code lives today and how `src/app.js`, `src/app/*`, and `src/features/*` fit together.
5. If your work touches the app shell, read `docs/APP_SHELL_REMAINING_SEAMS.md` first for the current stabilization boundary, then `docs/APP_SHELL_REFACTOR_PLAN.md` only if you need the extraction history.
6. Before touching deploy flow, release gates, or security-sensitive boundaries, read `docs/DEPLOYMENT.md`, `docs/RELEASE_CHECKLIST.md`, and `docs/SECURITY.md`.
7. Before touching schema or storage conventions, re-check `docs/DATA_MODEL.md`; before moving frontend structure, re-check `docs/FRONTEND_STRUCTURE.md`.

### Documentation map

Use this map to reduce doc-hunting:

#### Core contributor docs

- `docs/ARCHITECTURE.md` — high-level system overview and current module map.
- `docs/DATA_MODEL.md` — implementation-aware Firestore + Storage model and tenant scoping rules.
- `docs/FRONTEND_STRUCTURE.md` — current browser app structure, shell boundaries, and preferred frontend contribution seams.

#### App-shell stabilization docs

- `docs/APP_SHELL_REMAINING_SEAMS.md` — the current “stop here and stabilize” view of what still belongs in `src/app.js`, and the default guidance before proposing more shell extraction.
- `docs/APP_SHELL_REFACTOR_PLAN.md` — historical/current decomposition plan for the shell, including what has already been extracted.

#### Runtime config, migration, deploy, and security docs

- `docs/FIREBASE_MIGRATION_NOTES.md` — company-scoping rollout notes and the `window.__APP_CONFIG__` bootstrap/runtime-config guidance.
- `docs/DEPLOYMENT.md` — recommended deploy order, pre/post deploy checks, and rollback guidance.
- `docs/RELEASE_CHECKLIST.md` — pre-merge, pre-deploy, and post-deploy checklist form.
- `docs/SECURITY.md` — secrets handling, tenant storage boundaries, and security-focused operational checks.
- `docs/FIREBASE_COMPANY_ONBOARDING_SETUP.md` — historical Firebase setup notes for company onboarding and scoped workspace rollout.

#### Other operational docs

- `docs/MANUAL_LOOKUP_REGISTRY.md` — manual catalog import/verification workflow.
- `docs/NEXT_PHASE_EXECUTION_PLAN.md` — near-term phased implementation sequence when planning follow-up work.

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
- See `docs/FIREBASE_MIGRATION_NOTES.md` for the current rollout-safe runtime-config guidance in the broader company-scoping migration context.

### Security rules tests (Firestore + Storage)

Rules tests use the Firebase Local Emulator Suite via `firebase emulators:exec` and Node's built-in test runner.

```bash
npm run test:rules
```

This command starts local Firestore + Storage emulators, runs `test/rules/security.rules.test.js`, and then shuts emulators down automatically. On the first run in a given environment, the Firebase CLI may download emulator artifacts into `~/.cache/firebase/emulators` before the tests start.

If emulator downloads fail with a 403 or another fetch/network error, the rules assertions have not been skipped—the emulator process never became healthy enough to run them. In that case:

1. Re-run the command after transient network issues clear.
2. Verify the environment can reach Firebase emulator artifact downloads.
3. If you want to warm the cache before running the suite, use `firebase setup:emulators:firestore` and `firebase setup:emulators:storage`.

GitHub Actions now caches `~/.cache/firebase/emulators` so CI does not need to re-download emulator binaries on every run. Local machines still depend on the Firebase CLI being able to populate that cache at least once.

### Lightweight app-shell tests

The repo also includes a lightweight Node-based shell test harness:

```bash
npm run test:app-shell
```

- Use it for focused tests around pure/lightly-coupled shell modules such as route helpers, state helpers, or controller support code that does not require a browser DOM + Firebase emulator stack.
- It is intentionally not full end-to-end coverage for the signed-in app shell; auth/bootstrap, full render sequencing, and Firebase-backed integration flows still rely on higher-level manual or broader test coverage.

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
- If you only read three docs before making a change, read `docs/DATA_MODEL.md`, `docs/FRONTEND_STRUCTURE.md`, and then the relevant deploy/security doc for your change area.

## Security and tenancy model (high-level)

- Company data is scoped by `companyId` in Firestore and by storage path prefix:
  - `companies/{companyId}/evidence/...`
  - `companies/{companyId}/manuals/{assetId}/{manualId}/source.pdf`
  - `companies/{companyId}/backups/...`
- Enrichment authorization policy is standardized across functions libraries and tests.
- Firebase local secret files (for example `functions/.secret.local`) are ignored and must never be committed.
- Asset manual enrichment now checks a curated lookup catalog first (`functions/src/data/manualLookupCatalog.json`) before live rediscovery, then falls back to deterministic official-first/manual-repository-first discovery when no catalog match exists.

See `docs/SECURITY.md` and `docs/ARCHITECTURE.md` for details.
For current implementation-oriented contributor docs, also see `docs/DATA_MODEL.md`, `docs/FRONTEND_STRUCTURE.md`, `docs/APP_SHELL_REMAINING_SEAMS.md`, and `docs/APP_SHELL_REFACTOR_PLAN.md`.

### Manual lookup registry

- Workbook-backed manual seed data lives in `functions/src/data/manualLookupWorkbookSeed.json`.
- Regenerate the curated catalog with `npm run manual-catalog:import` from the repo root (or `npm run manual-catalog:import --prefix functions` if you are working directly in `functions/`).
- See `docs/MANUAL_LOOKUP_REGISTRY.md` for verification/trust-tier guidance and regression expectations.
